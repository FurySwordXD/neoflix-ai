import type { EventImage } from "./types";

/**
 * Image handling for story events.
 *
 * The model proposes image URLs, so each one must clear at least one of two
 * independent bars before it can render in the app:
 *  1. it is one of the exact URLs we harvested from the live search (Tavily's
 *     image pool, or the og:image we read off a result page), or
 *  2. its host is a known newsroom, agency, or archive.
 * Anything else is dropped; an event with no image is fine. Outlets often
 * serve photography from a CDN on a different domain than the article
 * (static01.nyt.com for nytimes.com), which is why the harvested set — not the
 * host list — is the primary trust anchor.
 */
export const TRUSTED_IMAGE_HOSTS = [
  // Wire services and broadcasters
  "apnews.com",
  "reuters.com",
  "bbc.co.uk",
  "bbci.co.uk",
  "cnn.com",
  "npr.org",
  "aljazeera.com",
  "dw.com",
  "france24.com",
  "cbsnews.com",
  "nbcnews.com",
  "abcnews.go.com",
  "pbs.org",
  "cbc.ca",
  "theguardian.com",
  "washingtonpost.com",
  "nytimes.com",
  "wsj.com",
  "usatoday.com",
  "latimes.com",
  "politico.com",
  "thehill.com",
  "axios.com",
  "time.com",
  "newsweek.com",
  "foreignpolicy.com",
  "theatlantic.com",
  "economist.com",
  "ft.com",
  "bloomberg.com",
  "cnbc.com",
  "forbes.com",
  "businessinsider.com",
  "sky.com",
  "independent.co.uk",
  "telegraph.co.uk",
  "thetimes.co.uk",
  "spiegel.de",
  "lemonde.fr",
  "elpais.com",
  "corriere.it",
  "nhk.or.jp",
  "scmp.com",
  "japantimes.co.jp",
  "straitstimes.com",
  "thehindu.com",
  "timesofindia.indiatimes.com",
  "abc.net.au",
  "smh.com.au",
  "theage.com.au",
  "rnz.co.nz",
  "haaretz.com",
  "timesofisrael.com",
  "jpost.com",
  "middleeasteye.net",
  "hurriyetdailynews.com",
  "kyivindependent.com",
  "kyivpost.com",
  "pravda.com.ua",
  "themoscowtimes.com",
  "meduza.io",
  "rferl.org",
  "voanews.com",
  "africanews.com",
  "allafrica.com",
  "premiumtimesng.com",
  "mg.co.za",
  "theeastafrican.co.ke",
  "monitor.co.ug",
  "nation.africa",
  "elcomercio.pe",
  "folha.uol.com.br",
  "estadao.com.br",
  "infobae.com",
  "clarin.com",
  "latercera.com",
  "nacion.com",
  "teletica.com",
  // Institutions, agencies and archives
  "un.org",
  "unocha.org",
  "who.int",
  "cdc.gov",
  "nih.gov",
  "nasa.gov",
  "esa.int",
  "noaa.gov",
  "usgs.gov",
  "europa.eu",
  "nato.int",
  "icrc.org",
  "msf.org",
  "worldbank.org",
  "imf.org",
  "iaea.org",
  "opcw.org",
  "whitehouse.gov",
  "state.gov",
  "defense.gov",
  "gov.uk",
  "gob.mx",
  "canada.ca",
  "gov.au",
  "wikimedia.org",
  "wikipedia.org",
  "britannica.com",
  "si.edu",
  "loc.gov",
  "archives.gov",
  "iwm.org.uk",
  "gettyimages.com",
  "shutterstock.com",
  // Photography CDNs that sit on a different domain than the newsroom itself.
  "static01.nyt.com",
  "i.guim.co.uk",
  "images.wsj.net",
  "assets.bwbx.io",
  "ca-times.brightspotcdn.com",
  "i.dailymail.co.uk",
  "e3.365dm.com",
  "img.haarets.co.il",
  "images.indianexpress.com",
  "static.toiimg.com",
  "img.etimg.com",
  "cdn.nationalgeographic.com",
  "static.euronews.com",
  "icdn.rtve.es",
  "img.huffingtonpost.com",
  "media.zenfs.com",
  "s.yimg.com",
];

const TRUSTED_HOSTS = TRUSTED_IMAGE_HOSTS;

const BAD_IMAGE =
  /(?:^data:|favicon|sprite|1x1|pixel\.gif|blank\.gif|\.svg(?:\?|#|$)|logo|placeholder)/i;

/** True when the URL is a plausible absolute http(s) image URL. */
function isImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (url.length < 12 || url.length > 800) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  if (BAD_IMAGE.test(url)) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

/** True when the URL sits on a known newsroom, agency, or archive host. */
export function isTrustedImageHost(raw: unknown): boolean {
  const url = isImageUrl(raw);
  if (!url) return false;
  const bare = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return [...TRUSTED_HOSTS].some(
    (trusted) => bare === trusted || bare.endsWith(`.${trusted}`)
  );
}

/**
 * Keep an image only when we can vouch for where it came from: an exact URL
 * from this search's candidates, or a known newsroom host.
 */
export function compileEventImage(
  raw: unknown,
  allowed?: Set<string>
): EventImage | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { url?: unknown; caption?: unknown; sourceUrl?: unknown };
  const url = isImageUrl(item.url);
  if (!url) return null;
  const fromSearch = allowed?.has(url) ?? false;
  if (!fromSearch && !isTrustedImageHost(url)) return null;

  const image: EventImage = { url };
  const caption = text(item.caption, 200);
  if (caption) image.caption = caption;
  const sourceUrl = text(item.sourceUrl, 800);
  if (/^https?:\/\//i.test(sourceUrl)) image.sourceUrl = sourceUrl;
  return image;
}

/** Every image an event carries, in order, deduplicated and capped. */
export function compileEventImages(
  raw: unknown,
  allowed?: Set<string>,
  limit = 2
): EventImage[] {
  const out: EventImage[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const image = compileEventImage(item, allowed);
    if (!image) continue;
    if (out.some((kept) => kept.url === image.url)) continue;
    out.push(image);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A story should show eight different photographs, not one repeated. Keeps the
 * first (chronological) use of each URL and drops later repeats. Mutates the
 * events' `images` arrays in place, since both the final and the streaming
 * compile already hold the event objects.
 */
export function dedupeEventImages<T extends { images?: EventImage[] }>(events: T[]): T[] {
  const used = new Set<string>();
  for (const event of events) {
    if (!event.images || event.images.length === 0) continue;
    const kept = event.images.filter((image) => {
      if (used.has(image.url)) return false;
      used.add(image.url);
      return true;
    });
    if (kept.length === 0) delete event.images;
    else event.images = kept;
  }
  return events;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}
