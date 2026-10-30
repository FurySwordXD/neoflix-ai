/** Env settings for the trend scraper; a bad value is a hard config error, like the sync worker's. */

type Env = Record<string, string | undefined>;

export interface ScrapeSettings {
  /** SCRAPE_GEOS: comma-separated ISO geo codes for the trends feeds. */
  geos: string[];
  /** SCRAPE_ITEM_LIMIT: items kept per geo feed (0 disables the scraper). */
  itemLimit: number;
  /** SCRAPE_HEADLINES_PER_ITEM: ht:news_item blocks kept per trending item. */
  headlinesPerItem: number;
  /** SCRAPE_TIMEOUT_MS: per-feed fetch timeout. */
  timeoutMs: number;
}

export const DEFAULT_GEO_LIST = ["US", "GB", "IN", "BR", "DE", "JP", "AU", "CA"];

export function scrapeSettingsFromEnv(env: Env = process.env): ScrapeSettings {
  const rawGeos = env.SCRAPE_GEOS?.trim();
  const geos = rawGeos
    ? rawGeos
        .split(/[,\s]+/)
        .map((geo) => geo.trim().toUpperCase())
        .filter(Boolean)
    : DEFAULT_GEO_LIST;
  const itemLimit = readInt(env, "SCRAPE_ITEM_LIMIT", 20, 0);
  const headlinesPerItem = readInt(env, "SCRAPE_HEADLINES_PER_ITEM", 5, 1);
  const timeoutMs = readInt(env, "SCRAPE_TIMEOUT_MS", 15_000, 1);
  for (const geo of geos) {
    if (!/^[A-Z]{2}(-[A-Z0-9]{2,4})?$/.test(geo)) {
      throw new Error(`Invalid SCRAPE_GEOS: "${geo}" is not an ISO geo code (use e.g. "US,GB,IN").`);
    }
  }
  return { geos, itemLimit, headlinesPerItem, timeoutMs };
}

function readInt(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a whole number of ${min} or more).`);
  }
  return value;
}
