import type { GraphConnection } from "../trendSync/graph";
import { scrapeSettingsFromEnv, type ScrapeSettings } from "./config";
import { writeTrends, type ScrapeSummary } from "./ingest";
import { fetchTrendRss } from "./trends";

/**
 * One scrape cycle: read the Google Trends daily feeds, then write Topics,
 * TRENDED edges and ABOUT-linked Articles into the shared graph. The sync
 * worker takes it from there (classify → link / stock for on-demand research).
 */

export interface ScrapeDeps {
  conn: GraphConnection;
  settings: ScrapeSettings;
  log: (line: string) => void;
  warn: (line: string) => void;
  signal?: AbortSignal;
}

export interface ScrapeResult {
  summary: ScrapeSummary;
  /** Trending terms the feeds returned (post-dedupe), highest traffic first. */
  items: number;
  /** Geos whose feed failed; empty when all feeds were read. */
  failedGeos: string[];
}

/**
 * Runs the scrape. Throws when every feed failed or the graph write failed —
 * the sync cycle that calls it logs the error and continues on whatever the
 * graph already holds.
 */
export async function runScrape(deps: ScrapeDeps): Promise<ScrapeResult> {
  const { settings, conn, signal } = deps;
  if (settings.itemLimit === 0) {
    deps.log("scrape: disabled (SCRAPE_ITEM_LIMIT=0)");
    return { summary: { topics: 0, trendEdges: 0, articles: 0, failedGeos: [] }, items: 0, failedGeos: [] };
  }
  const { items, failedGeos } = await fetchTrendRss({
    geos: settings.geos,
    limitPerGeo: settings.itemLimit,
    headlinesPerItem: settings.headlinesPerItem,
    timeoutMs: settings.timeoutMs,
    signal,
  });
  if (items.length === 0) {
    throw new Error(`all trends feeds failed (geos: ${settings.geos.join(", ")})`);
  }
  const summary = await writeTrends(conn.driver, items, { database: conn.database });
  const failedNote = failedGeos.length > 0 ? ` (${failedGeos.join(", ")} feeds failed)` : "";
  deps.log(
    `scrape: ${summary.topics} topics, ${summary.trendEdges} trended edges, ` +
      `${summary.articles} articles${failedNote}`
  );
  return { summary, items: items.length, failedGeos };
}
