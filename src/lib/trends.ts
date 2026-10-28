import neo4j, { type Driver } from "neo4j-driver";
import { isInterestId, type TrendItem } from "./recommend";
import { storeKindFromEnv } from "./stories";
import { getDriver, neo4jConfigFromEnv } from "./storyStore/neo4j";
import { regionsForGeos } from "./trendRegions";

/**
 * Live dashboard trends from the graph: Topics the sync worker marked
 * story-worthy, with news-scraper's TRENDED traffic and geos, mapped onto
 * recommend.ts's TrendItem. Only used when STORY_STORE=neo4j; any failure
 * yields [] so the dashboard falls back to the static TRENDS list.
 */

type Env = Record<string, string | undefined>;

/** Freshness falls from 1 (trending now) to 0 at this age. */
export const FRESHNESS_WINDOW_MS = 72 * 60 * 60 * 1000;
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

export interface LoadTrendsOptions {
  env?: Env;
  /** Injected in tests; otherwise the shared process driver. */
  driver?: Driver;
  now?: number;
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
