import neo4j from "neo4j-driver";
import { sourceDomain } from "../storyStore/neo4j";
import type { GraphConnection } from "./graph";

/**
 * Which news-scraper Topics the worker looks at this cycle, at or above the
 * traffic floor: never-checked ones; worthy ones that trended after the
 * worker last acted on them successfully (story_synced_at), so a failed or
 * capped action is retried; and non-worthy ones that trended again after
 * RECHECK_DAYS. A worthy topic checked inside that window comes back with its
 * stored classification, so it skips the model call. Each candidate carries a
 * few recent headlines from Articles ABOUT it, so the classifier judges the
 * news event rather than a bare search term.
 */

export const CANDIDATE_LIMIT = 25;
export const RECHECK_DAYS = 7;
export const HEADLINES_PER_TOPIC = 3;
const HEADLINE_MAX = 200;

export interface Headline {
  title: string;
  /** Domain of the article URL, e.g. "reuters.com". */
  source: string;
}

export interface CachedClassification {
  worthy: true;
  query: string;
  category: string | null;
}

export interface Candidate {
  key: string;
  name: string;
  /** Highest TRENDED.traffic_value, or null when news-scraper could not parse one. */
  traffic: number | null;
  /** Latest TRENDED.at, ISO. */
  latestAt: string;
  cached: CachedClassification | null;
  /** Up to HEADLINES_PER_TOPIC recent Article titles ABOUT the topic, newest first. */
  headlines: Headline[];
}

export interface CandidateOptions {
  trafficFloor: number;
  now?: Date;
}

// TRENDED.at is a DateTime from news-scraper, but a naive Python datetime
// lands as a LocalDateTime and older data may hold strings; all three are
// normalized before comparing.
const CANDIDATES = `
MATCH (t:Topic)-[r:TRENDED]->(:Geo)
WITH t, r,
     CASE WHEN r.at IS :: STRING THEN datetime(r.at)
          WHEN r.at IS NULL THEN null
          ELSE datetime({datetime: r.at}) END AS at
WITH t, max(at) AS latestAt, max(r.traffic_value) AS traffic
WITH t, latestAt, traffic, datetime($now) - duration({days: $recheckDays}) AS recheckBefore,
     datetime('1970-01-01T00:00:00Z') AS epoch
WHERE latestAt IS NOT NULL
  AND (traffic >= $floor OR $floor = 0)
  AND CASE
        WHEN t.story_worthy IS NULL OR t.story_checked_at IS NULL THEN true
        WHEN t.story_worthy = true THEN latestAt > coalesce(t.story_synced_at, epoch)
        ELSE latestAt > t.story_checked_at AND t.story_checked_at < recheckBefore
      END
WITH t, latestAt, traffic, recheckBefore
ORDER BY coalesce(traffic, 0) DESC, latestAt DESC, t.key
LIMIT $limit
RETURN t.key AS key, coalesce(t.name, t.key) AS name, traffic, toString(latestAt) AS latestAt,
       t.story_worthy = true AND t.story_checked_at >= recheckBefore AS isCached,
       t.story_query AS query, t.story_category AS category,
       COLLECT {
         MATCH (a:Article)-[:ABOUT]->(t)
         WHERE a.title IS NOT NULL AND trim(toString(a.title)) <> ''
         WITH a ORDER BY coalesce(a.seen_at, a.scraped_at) DESC, a.url
         LIMIT $headlines
         RETURN {title: a.title, url: a.url}
       } AS headlines
`;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseHeadlines(raw: unknown): Headline[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const value = (entry ?? {}) as Record<string, unknown>;
      const title = text(value.title)?.replace(/\s+/g, " ").slice(0, HEADLINE_MAX);
      const url = text(value.url);
      return title ? { title, source: url ? sourceDomain(url) : "unknown" } : null;
    })
    .filter((headline): headline is Headline => headline !== null)
    .slice(0, HEADLINES_PER_TOPIC);
}

/** Validates one graph record; null when it lacks a key, name or parseable time. */
export function parseCandidate(raw: Record<string, unknown>): Candidate | null {
  const key = text(raw.key);
  const name = text(raw.name);
  const at = text(raw.latestAt);
  const time = at ? Date.parse(at) : NaN;
  if (!key || !name || !Number.isFinite(time)) return null;
  const traffic = typeof raw.traffic === "number" && Number.isFinite(raw.traffic) ? raw.traffic : null;
  const query = text(raw.query);
  return {
    key,
    name,
    traffic,
    latestAt: new Date(time).toISOString(),
    cached: raw.isCached === true && query ? { worthy: true, query, category: text(raw.category) } : null,
    headlines: parseHeadlines(raw.headlines),
  };
}

export async function loadCandidates(conn: GraphConnection, opts: CandidateOptions): Promise<Candidate[]> {
  const { records } = await conn.driver.executeQuery(
    CANDIDATES,
    {
      now: (opts.now ?? new Date()).toISOString(),
      recheckDays: neo4j.int(RECHECK_DAYS),
      floor: neo4j.int(opts.trafficFloor),
      limit: neo4j.int(CANDIDATE_LIMIT),
      headlines: neo4j.int(HEADLINES_PER_TOPIC),
    },
    { database: conn.database }
  );
  return records
    .map((record) => parseCandidate(record.toObject()))
    .filter((candidate): candidate is Candidate => candidate !== null);
}
