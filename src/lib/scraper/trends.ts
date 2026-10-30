/**
 * Google Trends "Daily Search Trends" RSS reader: the raw feed → plain rows,
 * no database. Parsing is XML-regex based by design: the feed is flat, it
 * keeps us dependency-free, and it works on any Node ≥18 runtime.
 *
 *   https://trends.google.com/trending/rss?geo=US
 *
 * One <item> is one trending search, e.g.:
 *   <item>
 *     <title>thursday night football tonight</title>
 *     <ht:approx_traffic>10000+</ht:approx_traffic>
 *     <pubDate>Thu, 29 Oct 2026 16:40:00 -0700</pubDate>
 *     <ht:news_item>
 *       <ht:news_item_title>…</ht:news_item_title>
 *       <ht:news_item_url>…</ht:news_item_url>
 *       <ht:news_item_source>USA Today</ht:news_item_source>
 *     </ht:news_item>
 *   </item>
 */
import { topicKey } from "../storyStore/neo4j";

export const DEFAULT_GEOS = ["US", "GB", "IN", "BR", "DE", "JP", "AU", "CA"];

/** Parses "200,000+", "50K+", "1M+", "1,000" into 200000, 50000, 1000000, 1000; null when unparseable. */
export function parseTraffic(raw: string): number | null {
  const match = /([\d.,]+)\s*([KkMm]?)/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "k") return Math.round(value * 1_000);
  if (unit === "m") return Math.round(value * 1_000_000);
  return Math.round(value);
}

/** Unescapes one XML text node: character references and the five named entities. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text of an element's direct children, concatenated; null when absent. */
export function elementText(xml: string, tag: string): string | null {
  const matches = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))];
  if (matches.length === 0) return null;
  return decodeXmlEntities(matches.map((match) => match[1]).join(" ")).trim();
}

/** An http(s) URL unescaped and trimmed, or null. */
function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = decodeXmlEntities(raw).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

export interface ScraperHeadline {
  title: string;
  url: string;
  source: string;
}

export interface TrendItem {
  key: string;
  name: string;
  /** Approx searches, parsed from ht:approx_traffic ("50,000+" → 50000). */
  traffic: number | null;
  trafficLabel: string | null;
  /** The item's pubDate as ISO, when present and parseable. */
  at: string | null;
  /** The geos whose feed listed this term; a TRENDED edge is written per geo. */
  geos: string[];
  /** Up to `headlinesPerItem` news items the feed attaches to the trend. */
  headlines: ScraperHeadline[];
}

/** Parses one <item>…</item> block from `geo`'s feed; null when it has no usable title. */
export function parseTrendItem(itemXml: string, geo: string, headlinesPerItem: number): TrendItem | null {
  const name = elementText(itemXml, "title");
  if (!name) return null;
  const at = elementText(itemXml, "pubDate");
  const atIso = at && Number.isFinite(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null;
  const trafficRaw = elementText(itemXml, "ht:approx_traffic");
  const headlines: ScraperHeadline[] = [];
  for (const match of itemXml.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)) {
    const block = match[1];
    const title = elementText(block, "ht:news_item_title");
    const url = cleanUrl(elementText(block, "ht:news_item_url"));
    if (!title || !url) continue;
    headlines.push({
      title: title.replace(/\s+/g, " ").trim(),
      url,
      source: elementText(block, "ht:news_item_source") || new URL(url).hostname.replace(/^www\./, ""),
    });
    if (headlines.length >= headlinesPerItem) break;
  }
  return {
    key: topicKey(name),
    name,
    traffic: trafficRaw ? parseTraffic(trafficRaw) : null,
    trafficLabel: trafficRaw,
    at: atIso,
    geos: [geo],
    headlines,
  };
}

export interface FetchTrendsOptions {
  geos?: string[];
  /** Items per feed kept, highest approx_traffic first. */
  limitPerGeo?: number;
  /** ht:news_item blocks kept per item. */
  headlinesPerItem?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchXml?: (url: string) => Promise<string>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LIMIT_PER_GEO = 20;
const HEADLINES_PER_ITEM = 5;

/** The geo's feed URL. */
export function trendsFeedUrl(geo: string): string {
  return `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
}

export interface FetchTrendsResult {
  items: TrendItem[];
  /** Geos whose feed failed (each already logged to console). */
  failedGeos: string[];
}

/**
 * Reads the daily-trends RSS feed per geo and flattens it to rows, highest
 * traffic first. The same term trending in several geos becomes one row with
 * their geos merged and the highest traffic. A failed feed is logged and
 * skipped, so one blocked geo never blocks the others.
 */
export async function fetchTrendRss(options: FetchTrendsOptions = {}): Promise<FetchTrendsResult> {
  const geos = options.geos ?? DEFAULT_GEOS;
  const limitPerGeo = options.limitPerGeo ?? LIMIT_PER_GEO;
  const headlinesPerItem = options.headlinesPerItem ?? HEADLINES_PER_ITEM;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchXml =
    options.fetchXml ??
    (async (url: string) => {
      const res = await fetch(url, {
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NeoflixBot/1.0; +https://neoflix.local)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });

  const byKey = new Map<string, TrendItem>();
  const failedGeos: string[] = [];
  await Promise.all(
    geos.map(async (geo) => {
      let xml: string;
      try {
        xml = await fetchXml(trendsFeedUrl(geo));
      } catch (err) {
        console.warn(`[scraper] trends feed ${geo} failed: ${err instanceof Error ? err.message : String(err)}`);
        failedGeos.push(geo);
        return;
      }
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
      const parsed = items
        .map((item) => parseTrendItem(item, geo, headlinesPerItem))
        .filter((item): item is TrendItem => item !== null)
        .sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0))
        .slice(0, limitPerGeo);
      for (const item of parsed) {
        const known = byKey.get(item.key);
        if (!known) {
          byKey.set(item.key, item);
        } else {
          // Same term in two feeds: keep the stronger traffic figure, merge
          // the geos, and keep whichever headlines were parsed first.
          byKey.set(item.key, {
            ...known,
            traffic: (item.traffic ?? 0) > (known.traffic ?? 0) ? item.traffic : known.traffic,
            trafficLabel: (item.traffic ?? 0) > (known.traffic ?? 0) ? item.trafficLabel : known.trafficLabel,
            // ISO strings compare lexically; a parseable date beats a missing one.
            at: item.at && (!known.at || item.at > known.at) ? item.at : known.at,
            geos: [...known.geos, ...item.geos.filter((g) => !known.geos.includes(g))],
          });
        }
      }
    })
  );
  const items = [...byKey.values()].sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0));
  return { items, failedGeos };
}
