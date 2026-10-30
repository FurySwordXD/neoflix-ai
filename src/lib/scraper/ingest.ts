import neo4j, { type Driver } from "neo4j-driver";
import { sourceDomain } from "../storyStore/neo4j";
import type { TrendItem } from "./trends";

/**
 * Writes scraped trends into the graph with the exact shapes the rest of the
 * system already reads (news-scraper's model, mirrored in tests/trends.graph.test.ts):
 *
 *   (:Topic {key, name, max_traffic})-[:TRENDED {at, traffic, traffic_value}]->(:Geo {code})
 *   (:Article {url, title, published, seen_at, scraped_at})-[:ABOUT]->(:Topic)
 *
 * Everything is MERGE + coalesce-guarded SETs, so a re-run never clobbers
 * what the sync worker or a previous scrape wrote, and re-scraping the same
 * feed is idempotent.
 */

type Props = Record<string, unknown>;

// One row per (topic, geo) the feed listed it in. r.at only moves forward so
// a late-arriving older scrape cannot rewind freshness, and traffic keeps
// max semantics — readers take max(r.traffic_value), so accumulating would
// inflate a topic's heat every cycle. Existing r.at may be a string,
// LocalDateTime (a naive Python datetime from the old scraper) or DateTime;
// it is normalized exactly the way selection.ts reads it.
const MERGE_TRENDS = `
UNWIND $rows AS row
MERGE (t:Topic {key: row.key})
SET t.name = coalesce(t.name, row.name),
    t.max_traffic = CASE WHEN row.traffic IS NULL THEN t.max_traffic
                    WHEN t.max_traffic IS NULL OR row.traffic > t.max_traffic THEN row.traffic
                    ELSE t.max_traffic END
WITH t, row
MERGE (g:Geo {code: row.geo})
MERGE (t)-[r:TRENDED]->(g)
WITH r, row,
     CASE WHEN r.at IS NULL THEN null
          WHEN r.at IS :: STRING THEN datetime(r.at)
          ELSE datetime({datetime: r.at}) END AS existingAt,
     datetime(row.at) AS incomingAt
SET r.at = CASE WHEN existingAt IS NULL OR existingAt < incomingAt THEN incomingAt ELSE existingAt END,
    r.traffic = CASE WHEN row.traffic IS NULL THEN r.traffic
                 WHEN r.traffic_value IS NULL OR row.traffic > r.traffic_value THEN row.trafficLabel
                 ELSE r.traffic END,
    r.traffic_value = CASE WHEN row.traffic IS NULL THEN r.traffic_value
                      WHEN r.traffic_value IS NULL OR row.traffic > r.traffic_value THEN row.traffic
                      ELSE r.traffic_value END
RETURN count(*) AS edges
`;

// Fills only what is missing, so an Article news-scraper or a previous run
// wrote keeps its fields; seen_at moves forward because the article just
// surfaced in a live feed (the same rule persistSearchResults applies).
const MERGE_ARTICLES = `
UNWIND $rows AS row
MATCH (t:Topic {key: row.key})
MERGE (a:Article {url: row.url})
SET a.title = coalesce(a.title, row.title),
    a.published = coalesce(a.published, row.published),
    a.provider = coalesce(a.provider, $provider),
    a.scraped_at = coalesce(a.scraped_at, datetime($now)),
    a.seen_at = CASE WHEN a.seen_at IS NULL OR a.seen_at < datetime($now)
                THEN datetime($now) ELSE a.seen_at END
MERGE (s:Source {domain: row.domain})
MERGE (a)-[:PUBLISHED_BY]->(s)
MERGE (a)-[:ABOUT]->(t)
RETURN count(DISTINCT a) AS articles
`;

export interface ScrapeSummary {
  /** Trending terms written as Topics (with at least one TRENDED edge). */
  topics: number;
  /** TRENDED edges written (one per topic × geo the feed listed it in). */
  trendEdges: number;
  /** Feed headlines written as Articles ABOUT their topic. */
  articles: number;
  /** Geos whose feed failed (each already logged); the rest succeeded. */
  failedGeos: string[];
}

const EMPTY_SUMMARY: ScrapeSummary = { topics: 0, trendEdges: 0, articles: 0, failedGeos: [] };

/** Trend rows flattened to (topic × geo); `at` falls back to `now` when the item had no pubDate. */
export function trendRows(items: readonly TrendItem[], now: Date): Props[] {
  const rows: Props[] = [];
  for (const item of items) {
    for (const geo of item.geos) {
      rows.push({
        key: item.key,
        name: item.name,
        traffic: item.traffic,
        trafficLabel: item.trafficLabel,
        at: item.at ?? now.toISOString(),
        geo,
      });
    }
  }
  return rows;
}

/** One row per distinct headline; deduplicated by URL across topics. */
export function articleRows(items: readonly TrendItem[], now: Date): Props[] {
  const rows = new Map<string, Props>();
  for (const item of items) {
    for (const headline of item.headlines) {
      if (rows.has(headline.url)) continue;
      rows.set(headline.url, {
        key: item.key,
        url: headline.url,
        title: headline.title,
        published: item.at ?? now.toISOString(),
        domain: sourceDomain(headline.url),
      });
    }
  }
  return [...rows.values()];
}

/**
 * Writes one batch of scraped trends. The article write is guarded by an
 * existence check: it MERGEs `(:Article)-[:ABOUT]->(t)` onto Topics this
 * batch just upserted, and skips keys that vanished in between rather than
 * silently re-creating them.
 */
export async function writeTrends(
  driver: Driver,
  items: readonly TrendItem[],
  opts: { provider?: string; database?: string; now?: Date }
): Promise<ScrapeSummary> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? "google-trends-rss";
  const summary = { ...EMPTY_SUMMARY };

  const trends = trendRows(items, now);
  if (trends.length > 0) {
    const { records } = await driver.executeQuery(MERGE_TRENDS, { rows: trends }, { database: opts.database });
    summary.topics = new Set(trends.map((row) => row.key)).size;
    summary.trendEdges = Number(records[0]?.get("edges") ?? 0);
  }

  const articles = articleRows(items, now);
  if (articles.length > 0) {
    const keys = [...new Set(articles.map((row) => row.key as string))];
    const { records } = await driver.executeQuery(
      "UNWIND $keys AS key OPTIONAL MATCH (t:Topic {key: key}) RETURN key, t.key IS NOT NULL AS found",
      { keys },
      { database: opts.database }
    );
    const existing = new Set<string>();
    for (const record of records) {
      if (record.get("found") === true) existing.add(record.get("key") as string);
    }
    const writable = articles.filter((row) => existing.has(row.key as string));
    if (writable.length > 0) {
      const { records: written } = await driver.executeQuery(
        MERGE_ARTICLES,
        { rows: writable, now: now.toISOString(), provider },
        { database: opts.database }
      );
      summary.articles = Number(written[0]?.get("articles") ?? 0);
    }
  }

  return summary;
}
