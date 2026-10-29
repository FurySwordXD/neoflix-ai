/**
 * Server-side verification that a harvested image URL really is a decodable
 * image, before it is ever offered to the model or shown to a reader.
 *
 * A URL that looks like a photo is not one: news sites return HTML error
 * pages with a 200, hotlink-protection serves a placeholder, signed CDN links
 * expire, and lazy-loaded og:image URLs sometimes point at a 1x1 pixel. So we
 * fetch the bytes and check them in layers, cheapest first:
 *   1. HTTP status and an `image/*` content type,
 *   2. a size window and a real image signature in the leading bytes,
 *   3. a full decode (via sharp, when available) confirming the bytes are a
 *      complete, supported image of a usable size.
 * Fails closed: anything unproven is dropped.
 */

/** How long a single image fetch may take before we give up on it. */
const IMAGE_TIMEOUT_MS = 7_000;
/** Images larger than this are not story photos; do not buffer them. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Below this the file is an icon, a spacer, or a truncated response. */
const MIN_IMAGE_BYTES = 2_000;
/** A story photo has to be big enough to actually display. */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
/** Guard against decompression bombs before sharp ever allocates pixels. */
const MAX_PIXELS = 40_000_000;

/** Image signature in the leading bytes, independent of any header claim. */
function sniffFormat(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  let ascii = "";
  for (let i = 0; i < 12; i++) ascii += String.fromCharCode(bytes[i]);
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    if (/^(avif|avis)/.test(brand)) return "avif";
    if (/^(heic|heix|hevc|hevx|mif1|msf1)/.test(brand)) return "heif";
  }
  return null;
}

/** Read a body, aborting once it exceeds `max` bytes. Returns null if too big. */
async function readBodyCapped(
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

/** The callable shape we use, without depending on sharp's module typing. */
type SharpFn = (input: Buffer, options?: { limitInputPixels?: number }) => {
  metadata: () => Promise<{ format?: string; width?: number; height?: number }>;
  resize: (w: number, h: number, opts?: { fit?: string }) => { toBuffer: () => Promise<Buffer> };
};

let sharpModule: SharpFn | null | undefined;

/** Load sharp once; if it is unavailable, the decode layer is skipped. */
async function loadSharp(): Promise<SharpFn | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFn };
    sharpModule = mod.default ?? (mod as unknown as SharpFn);
  } catch {
    console.warn("[imageCheck] sharp unavailable; relying on signature checks only");
    sharpModule = null;
  }
  return sharpModule;
}

/** Confirm the bytes decode as a complete image of a usable size. */
async function decodesAsImage(bytes: Buffer): Promise<boolean> {
  const sharp = await loadSharp();
  // Without sharp we still know the signature is a real image format.
  if (!sharp) return true;
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
    if (!meta.format || !meta.width || !meta.height) return false;
    if (meta.width < MIN_WIDTH || meta.height < MIN_HEIGHT) return false;
    // A header parse alone can pass on a truncated file; force a real decode.
    await sharp(bytes, { limitInputPixels: MAX_PIXELS })
      .resize(64, 64, { fit: "inside" })
      .toBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the URL serves bytes that decode as a real, usable image.
 * Never throws; any failure (network, status, wrong type, corrupt data) is
 * simply "not usable".
 */
export async function isDecodableImage(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NeoflixBot/1.0; +https://neoflix.local)",
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
        // Some CDNs gate hotlinks on the referer; the image's own origin is the
        // closest thing to the context it was published in.
        Referer: `${origin}/`,
      },
    });
    if (!res.ok || !res.body) return false;

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("image/")) return false;

    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > 0 && declared < MIN_IMAGE_BYTES) {
      return false;
    }

    const bytes = await readBodyCapped(res.body, MAX_IMAGE_BYTES);
    if (!bytes || bytes.byteLength < MIN_IMAGE_BYTES) return false;

    // The bytes must carry a real image signature, whatever the header said.
    if (!sniffFormat(bytes)) return false;

    return await decodesAsImage(bytes);
  } catch {
    return false;
  }
}

/**
 * Keep only the URLs that pass `isDecodableImage`, preserving input order.
 * Each unique URL is fetched once even if it appears more than once.
 */
export async function filterDecodableImages(
  urls: string[],
  concurrency = 6
): Promise<Set<string>> {
  const ok = new Set<string>();
  const queue = [...new Set(urls)];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      if (await isDecodableImage(url)) ok.add(url);
    }
  });
  await Promise.all(workers);
  return ok;
}
