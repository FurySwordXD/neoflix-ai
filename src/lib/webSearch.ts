/**
 * Server-side web search for story generation. Nebius Token Factory does not
 * host a web_search tool, so we execute one ourselves and feed the results
 * back to the model as a function tool.
 *
 * Provider: Tavily (requires TAVILY_API_KEY in .env). Alongside the text
 * results we harvest images: the page's own social-preview image (og:image)
 * for each result, and the provider's query-level image pool. The model then
 * attaches those URLs to the events they illustrate — it may never invent one.
 *
 * Every harvested URL is fetched and decoded before it is offered (see
 * imageCheck.ts), so a link that 404s, serves HTML, or is a 1x1 pixel never
 * reaches the story.
 */

import { filterDecodableImages } from "./imageCheck";

export interface SearchImage {
  /** Direct image URL. */
  url: string;
  /** What the image shows, when the provider describes it. */
  description?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  /** The page's own social-preview image (og:image), when it exposes one. */
  image?: string;
  /** The alt text the page published for that image, when present. */
  imageAlt?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  /** Query-level image pool the provider returns alongside the results. */
  images: SearchImage[];
}

const FETCH_TIMEOUT_MS = 12_000;
/** Page fetches for og:image: a handful of the top results, best effort. */
const PAGE_IMAGE_LIMIT = 5;
/** How many candidate URLs to decode-verify per search, keeping the first. */
const VERIFY_IMAGE_LIMIT = 24;
const PAGE_IMAGE_TIMEOUT_MS = 5_000;
/** The <head> carries the meta tags; there is no need to read the whole page. */
const PAGE_IMAGE_BYTES = 180_000;
const MAX_QUERY_IMAGES = 12;
/** Sprites, tracking pixels, icons, and query strings make poor story photos. */
const BAD_IMAGE = /(?:^data:|favicon|sprite|1x1|pixel\.gif|blank\.gif|\.svg(?:\?|#|$))/i;

function clean(text: string, max = 300): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** HTML entities in URLs (&amp; and friends) must be decoded before use. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** A usable absolute image URL, or null for anything that would not render well. */
function cleanImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = decodeEntities(raw.trim());
  if (url.length < 12 || url.length > 800) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  if (BAD_IMAGE.test(url)) return null;
  return url;
}

function resolveImageUrl(raw: string, pageUrl: string): string | null {
  const cleaned = decodeEntities(raw.trim());
  if (!cleaned) return null;
  try {
    return cleanImageUrl(new URL(cleaned, pageUrl).toString());
  } catch {
    return null;
  }
}

const IMAGE_META = [
  // <meta property="og:image" content="…"> — either attribute order.
  /<meta[^>]+(?:property|name)=["'](?:og:image:url|og:image|twitter:image:src|twitter:image)["'][^>]*?content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:og:image:url|og:image|twitter:image:src|twitter:image)["']/i,
  // <link rel="image_src" href="…"> — the older convention, still in use.
  /<link[^>]+rel=["']image_src["'][^>]*?href=["']([^"']+)["']/i,
  /<link[^>]+href=["']([^"']+)["'][^>]*?rel=["']image_src["']/i,
];

/** Alt text the page published for its social-preview image. */
const IMAGE_ALT_META = [
  /<meta[^>]+(?:property|name)=["'](?:og:image:alt|twitter:image:alt)["'][^>]*?content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:og:image:alt|twitter:image:alt)["']/i,
];

/**
 * The page's lead image and its published alt text, from the social-preview
 * meta tags. The alt text matters: it is the outlet's own description of the
 * photograph, so captions can be sourced rather than guessed by the model.
 */
function extractPageImage(
  html: string,
  pageUrl: string
): { image: string; alt?: string } | null {
  const head = html.slice(0, PAGE_IMAGE_BYTES);
  let image: string | null = null;
  for (const pattern of IMAGE_META) {
    const match = pattern.exec(head);
    if (!match) continue;
    image = resolveImageUrl(match[1], pageUrl);
    if (image) break;
  }
  if (!image) return null;

  for (const pattern of IMAGE_ALT_META) {
    const match = pattern.exec(head);
    if (!match) continue;
    const alt = clean(decodeEntities(match[1]), 180);
    if (alt) return { image, alt };
  }
  return { image };
}

/** Read at most `max` bytes of a response body — enough for the document head. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let read = 0;
  try {
    while (read < max) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(out)) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out;
}

/** Best-effort: fetch a result page and pull its lead image. Never throws. */
async function fetchPageImage(
  pageUrl: string
): Promise<{ image: string; alt?: string } | null> {
  try {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_IMAGE_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NeoflixBot/1.0; +https://neoflix.local)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok || !res.body) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;
    return extractPageImage(await readCapped(res.body, PAGE_IMAGE_BYTES), pageUrl);
  } catch {
    return null;
  }
}

/** Tavily search API. Requires TAVILY_API_KEY. */
async function tavilySearch(query: string, maxResults: number): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  console.log("Tavily web search: ", query);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_images: true,
      include_image_descriptions: true,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    images?: Array<string | { url?: string; description?: string }>;
  };

  const results: WebSearchResult[] = (data.results ?? [])
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: clean(r.title ?? "", 180),
      url: r.url ?? "",
      snippet: clean(r.content ?? "", 400),
      date: r.published_date,
    }));

  const images: SearchImage[] = [];
  for (const item of data.images ?? []) {
    if (typeof item === "string") {
      const url = cleanImageUrl(item);
      if (url) images.push({ url });
    } else if (item && typeof item === "object") {
      const url = cleanImageUrl(item.url);
      if (!url) continue;
      const description = clean(item.description ?? "", 160);
      images.push(description ? { url, description } : { url });
    }
    if (images.length >= MAX_QUERY_IMAGES) break;
  }

  // Each result's own lead image is the best match for an event that cites it.
  await Promise.all(
    results.slice(0, PAGE_IMAGE_LIMIT).map(async (result) => {
      const found = await fetchPageImage(result.url);
      if (!found) return;
      result.image = found.image;
      if (found.alt) result.imageAlt = found.alt;
    })
  );

  // Verify the bytes before offering any of these to the model: a link that
  // does not decode is worse than no image, because it renders as a hole.
  const candidates: Array<{ url: string; keep: (ok: boolean) => void }> = [];
  for (const result of results) {
    if (result.image) {
      candidates.push({
        url: result.image,
        keep: (ok) => {
          if (!ok) {
            delete result.image;
            delete result.imageAlt;
          }
        },
      });
    }
  }
  for (const image of images) {
    candidates.push({
      url: image.url,
      keep: (ok) => {
        if (!ok) image.url = "";
      },
    });
  }

  const toVerify = candidates.slice(0, VERIFY_IMAGE_LIMIT);
  const verified = await filterDecodableImages(toVerify.map((c) => c.url));
  for (const candidate of toVerify) candidate.keep(verified.has(candidate.url));
  // Past the cap we stop checking, so we stop offering: fail closed.
  for (const candidate of candidates.slice(VERIFY_IMAGE_LIMIT)) candidate.keep(false);

  return { results, images: images.filter((image) => image.url) };
}

/**
 * Run the search. Returns an empty response on failure — the model is told to
 * answer without search results and rely on documented knowledge instead.
 */
export async function webSearch(query: string, maxResults = 8): Promise<WebSearchResponse> {
  try {
    return await tavilySearch(query, maxResults);
  } catch (err) {
    console.warn(
      "[webSearch] tavily failed:",
      err instanceof Error ? err.message : err
    );
    return { results: [], images: [] };
  }
}

/** Every image URL the model is allowed to use, from one search response. */
export function collectImageUrls(response: WebSearchResponse): string[] {
  const urls = new Set<string>();
  for (const result of response.results) {
    if (result.image) urls.add(result.image);
  }
  for (const image of response.images) urls.add(image.url);
  return [...urls];
}

/** Format results for the model's function_call_output payload. */
export function formatSearchOutput(response: WebSearchResponse): string {
  const { results, images } = response;
  if (results.length === 0) {
    return "No search results available. Rely on your own documented knowledge and note the limitation.";
  }
  const blocks = results.map((r, i) => {
    const lines = [
      `[${i + 1}] ${r.title}${r.date ? ` (${r.date})` : ""}`,
      r.url,
      r.snippet,
    ];
    if (r.image) {
      lines.push(
        r.imageAlt ? `image: ${r.image} (alt: ${r.imageAlt})` : `image: ${r.image}`
      );
    }
    return lines.join("\n");
  });
  if (images.length === 0) return blocks.join("\n\n");
  const pool = images
    .map((image) => `- ${image.url}${image.description ? ` — ${image.description}` : ""}`)
    .join("\n");
  return `${blocks.join("\n\n")}\n\nCANDIDATE IMAGES (the only image URLs you may use):\n${pool}`;
}
