import neo4j, { type Driver } from "neo4j-driver";
import { filterDecodableImages } from "./imageCheck";
import { storeKindFromEnv } from "./stories";
import { getDriver, neo4jConfigFromEnv, sourceDomain } from "./storyStore/neo4j";
import { webSearch, type SearchImage, type WebSearchResponse, type WebSearchResult } from "./webSearch";

/**
 * Graph-first research for the model's web_search tool. With STORY_STORE=neo4j
 * the graph news-scraper fills is searched first (its `article_text` and
 * `name_text` full-text indexes); enough fresh hits and Tavily is skipped.
 * Otherwise Tavily runs as before and its results are written back as
 * (:Article {provider: "tavily"}), so the next search for the same story can
 * be answered from the graph. In file mode nothing here touches Neo4j.
 *
 * Graph images are decode-verified like Tavily's and travel in
 * `WebSearchResult.image`, so `collectImageUrls` counts them as harvested.
 */

type Env = Record<string, string | undefined>;

export interface GraphResearchOptions {
  env?: Env;
  /** Defaults to the shared driver from NEO4J_* settings. */
  driver?: Driver;
  database?: string;
  now?: Date;
  /** Defaults to `filterDecodableImages`; tests inject a fake. */
  verifyImages?: (urls: string[]) => Promise<Set<string>>;
}

export interface GraphResearchSettings {
  /** GRAPH_MIN_HITS: graph results needed to skip Tavily. */
  minHits: number;
  /** GRAPH_FRESH_DAYS: how recently an Article must have been seen. */
  freshDays: number;
}

export interface ResearchDeps {
  graphSearch: (query: string) => Promise<WebSearchResponse>;
  webSearch: (query: string) => Promise<WebSearchResponse>;
  persist: (response: WebSearchResponse) => Promise<void>;
  minHits: number;
  log: (line: string) => void;
  warn: (...args: unknown[]) => void;
}

const DEFAULT_MIN_HITS = 5;
const DEFAULT_FRESH_DAYS = 30;
const GRAPH_RESULT_LIMIT = 8;
/** Rows without seen_at are judged in JS by `published`, so over-fetch a little. */
const GRAPH_CANDIDATE_LIMIT = GRAPH_RESULT_LIMIT * 3;
const SNIPPET_MAX = 400;
const SUMMARY_MAX = 1000;
const IMAGE_URL_MAX = 800;
const DAY_MS = 86_400_000;

/** Same definitions as news-scraper's SCHEMA_STATEMENTS, so either side may create them. */
const FULLTEXT_INDEXES = [
  "CREATE FULLTEXT INDEX article_text IF NOT EXISTS FOR (n:Article) ON EACH [n.title, n.summary] " +
    "OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
  "CREATE FULLTEXT INDEX name_text IF NOT EXISTS FOR (n:Topic|Entity) ON EACH [n.name] " +
    "OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
];

const SEARCH_ARTICLES = `
CALL () {
  CALL db.index.fulltext.queryNodes('article_text', $q) YIELD node, score
  RETURN node AS a, score
  UNION
  CALL db.index.fulltext.queryNodes('name_text', $q) YIELD node, score
  MATCH (a:Article)-[:ABOUT|MENTIONS]->(node)
  RETURN a, score
}
WITH a, max(score) AS score
WITH a, score, coalesce(a.seen_at, a.scraped_at) AS seen
WHERE seen >= datetime($since) OR seen IS NULL
RETURN a.url AS url, a.title AS title, a.summary AS summary, a.published AS published,
       a.image AS image, seen IS NOT NULL AS hasSeen, score
ORDER BY score DESC
LIMIT $limit
`;

// Fills only what is missing, so news-scraper's own fields always win; seen_at
// moves forward because the article just showed up in a live search.
const SAVE_TAVILY_ARTICLES = `
UNWIND $rows AS row
MERGE (a:Article {url: row.url})
SET a.title = coalesce(a.title, row.title),
    a.summary = CASE WHEN a.summary IS NULL OR a.summary = '' THEN row.summary ELSE a.summary END,
    a.published = coalesce(a.published, row.published),
    a.image = coalesce(a.image, row.image),
    a.provider = coalesce(a.provider, 'tavily'),
    a.scraped_at = coalesce(a.scraped_at, datetime($now)),
    a.seen_at = CASE WHEN a.seen_at IS NULL OR a.seen_at < datetime($now)
                THEN datetime($now) ELSE a.seen_at END
MERGE (s:Source {domain: row.domain})
MERGE (a)-[:PUBLISHED_BY]->(s)
`;

const LUCENE_SPECIAL = /([+\-!(){}[\]^"~*?:\\/&|])/g;

const indexCache = globalThis as unknown as {
  __algonewsResearchIndexes?: WeakMap<Driver, Promise<void>>;
};

const emptyResponse = (): WebSearchResponse => ({ results: [], images: [] });

/** Lucene's English stop set plus common query filler; never required terms. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it",
  "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they",
  "this", "to", "was", "will", "with", "about", "after", "amid", "from", "has", "have", "how",
  "its", "latest", "new", "news", "over", "says", "than", "today", "vs", "what", "whats", "when",
  "where", "who", "why",
]);
const MIN_TERM_LETTERS = 3;
/** A hit counts only when it scores at least this share of the best hit. */
export const RELATIVE_SCORE_CUTOFF = 0.5;

/** Lowercased terms with Lucene syntax escaped (news-scraper's `fulltext_query`). */
function escapedTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(LUCENE_SPECIAL, "\\$1"))
    .filter((term) => term.replace(/\\/g, "").length > 0);
}

function isSignificant(term: string): boolean {
  const bare = term.replace(/[^\p{L}\p{N}]/gu, "");
  return bare.length >= MIN_TERM_LETTERS && !STOPWORDS.has(bare);
}

/**
 * A full-text query that requires every significant term (AND), so one shared
 * word cannot match. With no significant term left, any term may match, as
 * news-scraper's `fulltext_query` does.
 */
export function luceneQuery(text: string): string {
  const terms = escapedTerms(text);
  const significant = terms.filter(isSignificant);
  return significant.length > 0 ? significant.join(" AND ") : terms.join(" ");
}

/** Rows scoring at least RELATIVE_SCORE_CUTOFF of the best score, in their original order. */
export function aboveScoreCutoff<T extends { score: unknown }>(rows: readonly T[]): T[] {
  const scored = rows.filter((row) => typeof row.score === "number" && Number.isFinite(row.score));
  if (scored.length === 0) return [];
  const top = Math.max(...scored.map((row) => row.score as number));
  return scored.filter((row) => (row.score as number) >= top * RELATIVE_SCORE_CUTOFF);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function graphResearchSettings(env: Env = process.env): GraphResearchSettings {
  return {
    minHits: positiveInt(env.GRAPH_MIN_HITS, DEFAULT_MIN_HITS),
    freshDays: positiveInt(env.GRAPH_FRESH_DAYS, DEFAULT_FRESH_DAYS),
  };
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value) && value.length <= IMAGE_URL_MAX;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface GraphConnection {
  driver: Driver;
  database?: string;
}

/** Null in file mode, so callers never reach for a driver they do not need. */
function graphConnection(opts: GraphResearchOptions): GraphConnection | null {
  const env = opts.env ?? process.env;
  if (storeKindFromEnv(env) !== "neo4j") return null;
  if (opts.driver) return { driver: opts.driver, database: opts.database };
  const config = neo4jConfigFromEnv(env);
  return { driver: getDriver(config), database: opts.database ?? config.database };
}

function ensureFulltextIndexes({ driver, database }: GraphConnection): Promise<void> {
  const done = (indexCache.__algonewsResearchIndexes ??= new WeakMap());
  let pending = done.get(driver);
  if (!pending) {
    pending = (async () => {
      for (const statement of FULLTEXT_INDEXES) await driver.executeQuery(statement, {}, { database });
    })().catch((err: unknown) => {
      done.delete(driver);
      throw err;
    });
    done.set(driver, pending);
  }
  return pending;
}

interface ArticleRow {
  url: unknown;
  title: unknown;
  summary: unknown;
  published: unknown;
  image: unknown;
  hasSeen: unknown;
  score: unknown;
}

/** An article never marked seen is fresh only if its published date parses and is recent. */
function isFresh(row: ArticleRow, sinceMs: number): boolean {
  if (row.hasSeen === true) return true;
  const published = optionalString(row.published);
  const time = published ? Date.parse(published) : NaN;
  return Number.isFinite(time) && time >= sinceMs;
}

function toResult(row: ArticleRow): WebSearchResult | null {
  const url = optionalString(row.url);
  const title = optionalString(row.title);
  if (!url || !title) return null;
  const date = optionalString(row.published);
  const image = isHttpUrl(row.image) ? row.image : undefined;
  return {
    title,
    url,
    snippet: (optionalString(row.summary) ?? "").slice(0, SNIPPET_MAX),
    ...(date ? { date } : {}),
    ...(image ? { image } : {}),
  };
}

async function withVerifiedImages(
  results: WebSearchResult[],
  verifyImages: (urls: string[]) => Promise<Set<string>>
): Promise<WebSearchResult[]> {
  const urls = [...new Set(results.flatMap((r) => (r.image ? [r.image] : [])))];
  if (urls.length === 0) return results;
  const ok = await verifyImages(urls);
  return results.map((result) => {
    if (!result.image || ok.has(result.image)) return result;
    const { image: _dropped, ...rest } = result;
    return rest;
  });
}

/**
 * Fresh Articles from the shared graph that match every significant query
 * term and score near the best hit, in Tavily's response shape. Returns an
 * empty response in file mode or for a query with no searchable terms; throws
 * on graph errors so the caller can log them and fall back to Tavily.
 */
export async function graphSearch(
  query: string,
  opts: GraphResearchOptions = {}
): Promise<WebSearchResponse> {
  const connection = graphConnection(opts);
  const q = luceneQuery(query);
  if (!connection || !q) return emptyResponse();
  await ensureFulltextIndexes(connection);

  const { freshDays } = graphResearchSettings(opts.env ?? process.env);
  const sinceMs = (opts.now ?? new Date()).getTime() - freshDays * DAY_MS;
  const { records } = await connection.driver.executeQuery(
    SEARCH_ARTICLES,
    { q, since: new Date(sinceMs).toISOString(), limit: neo4j.int(GRAPH_CANDIDATE_LIMIT) },
    { database: connection.database }
  );
  const fresh = records
    .map((record) => record.toObject() as unknown as ArticleRow)
    .filter((row) => isFresh(row, sinceMs));
  // Weak matches would count toward GRAPH_MIN_HITS and skip Tavily for nothing.
  const results = aboveScoreCutoff(fresh)
    .map(toResult)
    .filter((result): result is WebSearchResult => result !== null)
    .slice(0, GRAPH_RESULT_LIMIT);
  return {
    results: await withVerifiedImages(results, opts.verifyImages ?? filterDecodableImages),
    images: [],
  };
}

interface TavilyArticleRow {
  url: string;
  title: string;
  summary: string | null;
  published: string | null;
  image: string | null;
  domain: string;
}

function toArticleRow(result: WebSearchResult): TavilyArticleRow | null {
  const title = optionalString(result.title);
  if (!isHttpUrl(result.url) || !title) return null;
  return {
    url: result.url,
    title,
    summary: optionalString(result.snippet)?.slice(0, SUMMARY_MAX) ?? null,
    published: optionalString(result.date) ?? null,
    image: isHttpUrl(result.image) ? result.image : null,
    domain: sourceDomain(result.url),
  };
}

/** Writes Tavily results to the graph (neo4j mode only). Throws on graph errors. */
export async function persistSearchResults(
  response: WebSearchResponse,
  opts: GraphResearchOptions = {}
): Promise<void> {
  const connection = graphConnection(opts);
  if (!connection) return;
  const rows = response.results
    .map(toArticleRow)
    .filter((row): row is TavilyArticleRow => row !== null);
  if (rows.length === 0) return;
  await connection.driver.executeQuery(
    SAVE_TAVILY_ARTICLES,
    { rows, now: (opts.now ?? new Date()).toISOString() },
    { database: connection.database }
  );
}

/** `first`'s results and images, then `second`'s that are not already present (by URL). */
export function mergeSearchResponses(
  first: WebSearchResponse,
  second: WebSearchResponse
): WebSearchResponse {
  const resultUrls = new Set(first.results.map((r) => r.url));
  const imageUrls = new Set(first.images.map((i) => i.url));
  return {
    results: [...first.results, ...second.results.filter((r) => !resultUrls.has(r.url))],
    images: [
      ...first.images,
      ...second.images.filter((i: SearchImage) => !imageUrls.has(i.url)),
    ],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultDeps(): ResearchDeps {
  return {
    graphSearch: (query) => graphSearch(query),
    webSearch: (query) => webSearch(query),
    persist: (response) => persistSearchResults(response),
    minHits: graphResearchSettings().minHits,
    log: (line) => console.log(line),
    warn: (...args) => console.warn(...args),
  };
}

/**
 * The web_search tool executor: graph first, Tavily when the graph has fewer
 * than `minHits` results. Graph and persist failures are logged and never
 * fail the search.
 */
export async function researchQuery(
  query: string,
  overrides: Partial<ResearchDeps> = {}
): Promise<WebSearchResponse> {
  const deps = { ...defaultDeps(), ...overrides };
  let graph = emptyResponse();
  try {
    graph = await deps.graphSearch(query);
  } catch (err) {
    deps.warn("[research] graph search failed:", errorMessage(err));
  }

  if (graph.results.length >= deps.minHits) {
    deps.log(`research: graph=${graph.results.length} tavily=skipped`);
    return graph;
  }

  deps.log(`research: graph=${graph.results.length} tavily=used`);
  const tavily = await deps.webSearch(query);
  if (tavily.results.length > 0) {
    try {
      await deps.persist(tavily);
    } catch (err) {
      deps.warn("[research] saving Tavily results to the graph failed:", errorMessage(err));
    }
  }
  return mergeSearchResponses(tavily, graph);
}
