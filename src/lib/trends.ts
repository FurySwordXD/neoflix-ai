import neo4j, { type Driver } from "neo4j-driver";
import { isInterestId, type TrendItem } from "./recommend";
import { findExistingStory } from "./storyMatch";
import { listStoryMetas, storeKindFromEnv } from "./stories";
import type { StoryMeta } from "./stories";
import { getDriver, neo4jConfigFromEnv } from "./storyStore/neo4j";
import { regionsForGeos } from "./trendRegions";

/**
 * Dashboard trends, straight from the db: Topics the sync worker marked
 * story-worthy (news-scraper's TRENDED traffic and geos), then the stories
 * already saved in the store as the shelf behind them. Nothing here is
 * hardcoded — an empty graph simply means only saved stories show.
 */

type Env = Record<string, string | undefined>;

/** Freshness falls from 1 (trending now) to 0 at this age. */
export const FRESHNESS_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Same window, in hours, for saved-story freshness. */
export const FRESHNESS_WINDOW_HOURS = FRESHNESS_WINDOW_MS / 3_600_000;
const DEFAULT_LIMIT = 20;

export interface GraphTrendRow {
  key: string;
  name: string;
  query: string | null;
  category: string | null;
  slug: string | null;
  storyTitle: string | null;
  storyDescription: string | null;
  storyStatus: string | null;
  geos: string[];
  /** Highest TRENDED.traffic_value (or Topic.max_traffic) seen. */
  traffic: number | null;
  /** Latest TRENDED.at as epoch millis. */
  latestAtMs: number | null;
}

// TRENDED.at is a DateTime from news-scraper but may be an ISO string;
// stub Stories (no createdAt) are skipped, and the most recently refreshed
// linked Story wins.
const TRENDS_QUERY = `
MATCH (t:Topic) WHERE t.story_worthy = true
OPTIONAL MATCH (t)-[r:TRENDED]->(g:Geo)
WITH t, r, g,
     CASE WHEN r.at IS :: STRING THEN datetime(r.at)
          WHEN r.at IS NULL THEN null
          ELSE datetime({datetime: r.at}) END AS at
WITH t, collect(DISTINCT g.code) AS geos, max(r.traffic_value) AS traffic, max(at) AS latestAt
OPTIONAL MATCH (s:Story)-[:ABOUT]->(t) WHERE s.createdAt IS NOT NULL
WITH t, geos, traffic, latestAt, s ORDER BY s.refreshedAt DESC
WITH t, geos, traffic, latestAt, collect(s)[0] AS s
WITH t, geos, s, coalesce(traffic, t.max_traffic) AS traffic,
     CASE WHEN latestAt IS NULL THEN null ELSE latestAt.epochMillis END AS latestAtMs
RETURN t.key AS key, t.name AS name, t.story_query AS query, t.story_category AS category,
       s.slug AS slug, s.title AS storyTitle, s.description AS storyDescription,
       s.status AS storyStatus, geos, traffic, latestAtMs
ORDER BY coalesce(latestAtMs, 0) DESC, coalesce(traffic, 0) DESC, key
LIMIT $limit
`;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Validates one graph record; null when it lacks a usable key or name. */
export function parseTrendRow(raw: unknown): GraphTrendRow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const key = text(value.key);
  const name = text(value.name);
  if (!key || !name) return null;
  const geos = Array.isArray(value.geos) ? value.geos.filter((g): g is string => !!text(g)) : [];
  return {
    key,
    name,
    query: text(value.query),
    category: text(value.category),
    slug: text(value.slug),
    storyTitle: text(value.storyTitle),
    storyDescription: text(value.storyDescription),
    storyStatus: text(value.storyStatus),
    geos,
    traffic: finite(value.traffic),
    latestAtMs: finite(value.latestAtMs),
  };
}

/** Runs the trends query. Throws on graph errors; callers decide how to degrade. */
export async function fetchTrendRows(
  driver: Driver,
  limit: number,
  database?: string
): Promise<GraphTrendRow[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`trend limit must be a positive integer (got ${limit})`);
  }
  const { records } = await driver.executeQuery(
    TRENDS_QUERY,
    { limit: neo4j.int(limit) },
    { routing: neo4j.routing.READ, ...(database ? { database } : {}) }
  );
  return records
    .map((record) => parseTrendRow(record.toObject()))
    .filter((row): row is GraphTrendRow => row !== null);
}

/** 1 at `now`, linearly down to 0 after FRESHNESS_WINDOW_MS; 0 when unknown. */
export function freshnessAt(atMs: number | null, now: number): number {
  if (atMs === null) return 0;
  const age = Math.max(0, now - atMs);
  return Math.max(0, 1 - age / FRESHNESS_WINDOW_MS);
}

/** log1p(traffic) scaled so the busiest topic in the set is 1. */
function heatScale(rows: readonly GraphTrendRow[]): (traffic: number | null) => number {
  const peak = Math.max(0, ...rows.map((row) => Math.log1p(Math.max(0, row.traffic ?? 0))));
  return (traffic) => (peak === 0 ? 0 : Math.log1p(Math.max(0, traffic ?? 0)) / peak);
}

function blurbFor(row: GraphTrendRow): string {
  if (row.storyDescription) return row.storyDescription;
  return row.geos.length > 0 ? `Trending now in ${row.geos.join(", ")}.` : "Trending now.";
}

export function toTrendItems(rows: readonly GraphTrendRow[], now: number = Date.now()): TrendItem[] {
  const heat = heatScale(rows);
  return rows.map((row) => ({
    id: `graph:${row.key}`,
    // The classifier's query reads better than the raw search term (e.g. "微博").
    title: row.storyTitle ?? row.query ?? row.name,
    blurb: blurbFor(row),
    query: row.query ?? row.name,
    ...(row.slug ? { slug: row.slug } : {}),
    topics: row.category && isInterestId(row.category) ? [row.category] : [],
    regions: regionsForGeos(row.geos),
    heat: heat(row.traffic),
    freshness: freshnessAt(row.latestAtMs, now),
    ongoing: row.storyStatus ? row.storyStatus === "ongoing" : true,
  }));
}

// How recently the coverage behind each saved story was published: the
// newest Article its Events cite. A story whose sources ran today is what
// the news is talking about now; one citing years-old articles is a
// completed explainer, however recently the app refreshed it.
const ARTICLE_COVERAGE_QUERY = `
MATCH (s:Story)-[:HAS_EVENT]->(:Event)-[:CITES]->(a:Article)
WHERE s.createdAt IS NOT NULL AND a.published IS NOT NULL
WITH s, max(toString(a.published)) AS latestArticle
WHERE latestArticle IS NOT NULL
RETURN s.slug AS slug, latestArticle`;

/** Runs the coverage query. Throws on graph errors; callers decide how to degrade. */
export async function fetchArticleCoverage(
  driver: Driver,
  database?: string
): Promise<Record<string, number>> {
  const { records } = await driver.executeQuery(
    ARTICLE_COVERAGE_QUERY,
    {},
    { routing: neo4j.routing.READ, ...(database ? { database } : {}) }
  );
  const coverage: Record<string, number> = {};
  for (const record of records) {
    const row = record.toObject();
    const slug = text(row.slug);
    const at = text(row.latestArticle);
    if (!slug || !at) continue;
    const time = Date.parse(at);
    if (Number.isFinite(time)) coverage[slug] = time;
  }
  return coverage;
}

/** Latest cited-article time per saved story; {} when unavailable. */
export async function loadArticleCoverage(options: LoadTrendsOptions = {}): Promise<Record<string, number>> {
  const env = options.env ?? process.env;
  try {
    if (storeKindFromEnv(env) !== "neo4j") return {};
    const config = options.driver ? undefined : neo4jConfigFromEnv(env);
    const driver = options.driver ?? getDriver(config);
    const database = config ? config.database : env.NEO4J_DATABASE?.trim() || undefined;
    return await fetchArticleCoverage(driver, database);
  } catch (err) {
    console.error("[trends] article coverage unavailable:", err instanceof Error ? err.message : err);
    return {};
  }
}

export interface LoadTrendsOptions {
  env?: Env;
  /** Injected in tests; otherwise the shared process driver. */
  driver?: Driver;
  now?: number;
}

/** Graph trends first; the stories already in the store fill any gaps. */
export async function loadDashboardTrends(
  limit: number = DEFAULT_LIMIT,
  options: LoadTrendsOptions = {}
): Promise<TrendItem[]> {
  const now = options.now ?? Date.now();
  const metas = await listStoryMetas();
  const [graph, coverage] = await Promise.all([loadGraphTrends(limit, options), loadArticleCoverage(options)]);

  // Saved stories the graph already shows are covered by their Topic row.
  const covered = new Set(
    graph.flatMap((item) => {
      const bySlug = item.slug ? [item.slug] : [];
      const matched = findExistingStory(item.query, metas)?.slug;
      return matched ? [...bySlug, matched] : bySlug;
    })
  );
  const shelf = savedStoryTrends(metas, now, coverage).filter((item) => !covered.has(item.slug));

  // Freshest first: a saved story shown behind live trending topics keeps
  // its own recency, but never outranks what is trending right now.
  return [...graph, ...shelf].slice(0, limit);
}

/**
 * The stories already saved in the store, staged as dashboard cards: the
 * app's shelf. Each card's recency is the newest article its events cite —
 * coverage published now means the topic is in the news now — falling back
 * to when the story was last refreshed (or saved). `heat` is 0 so live
 * trending topics always outrank them.
 */
export function savedStoryTrends(
  metas: StoryMeta[],
  now: number = Date.now(),
  coverageAt: Record<string, number> = {}
): Array<TrendItem & { slug: string }> {
  return metas
    .map((meta) => {
      const covered = coverageAt[meta.slug];
      // News coverage wins; without it the story's own refresh history stands in.
      const stamp = Number.isFinite(covered) ? covered : Date.parse(meta.refreshedAt ?? meta.createdAt ?? meta.startAt);
      const ageHours = Number.isFinite(stamp) ? Math.max(0, (now - stamp) / 3_600_000) : null;
      return {
        item: {
          id: `story:${meta.slug}`,
          title: meta.title,
          blurb: meta.description || meta.subtitle,
          query: meta.title,
          slug: meta.slug,
          topics: [] as string[],
          regions: [] as string[],
          heat: 0,
          freshness: ageHours === null ? 0 : Math.max(0, 1 - ageHours / FRESHNESS_WINDOW_HOURS),
          ongoing: meta.status === "ongoing",
        } satisfies TrendItem & { slug: string },
        stamp,
      };
    })
    .filter(({ item }) => item.blurb.trim().length > 0)
    .sort((a, b) => {
      // Unknown recency sorts last; newer stories first within that.
      const left = Number.isFinite(a.stamp) ? a.stamp : -Infinity;
      const right = Number.isFinite(b.stamp) ? b.stamp : -Infinity;
      if (left !== right) return right - left;
      return a.item.title.localeCompare(b.item.title);
    })
    .map(({ item }) => item);
}

/** Story-worthy graph topics as dashboard trends; [] when unavailable. */
export async function loadGraphTrends(
  limit: number = DEFAULT_LIMIT,
  options: LoadTrendsOptions = {}
): Promise<TrendItem[]> {
  const env = options.env ?? process.env;
  try {
    if (storeKindFromEnv(env) !== "neo4j") return [];
    const config = options.driver ? undefined : neo4jConfigFromEnv(env);
    const driver = options.driver ?? getDriver(config);
    const database = config ? config.database : env.NEO4J_DATABASE?.trim() || undefined;
    const rows = await fetchTrendRows(driver, limit, database);
    return toTrendItems(rows, options.now ?? Date.now());
  } catch (err) {
    console.error("[trends] graph trends unavailable:", err instanceof Error ? err.message : err);
    return [];
  }
}
