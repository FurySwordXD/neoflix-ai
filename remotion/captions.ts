/**
 * Caption pagination for StoryVideo: a narration script is too long to show
 * all at once, so it is displayed in pages of at most CAPTION_MAX_LINES lines,
 * advancing over the event's duration like subtitles.
 *
 * Smarter than a char-count wrap:
 * - Lines wrap against the real rendered text width (canvas measureText in the
 *   caption font), so breaks land where the box actually breaks.
 * - Each sentence is wrapped with a minimum-raggedness pass, giving balanced
 *   centered lines instead of a packed first line and a stub last line.
 * - Pages break at sentence boundaries, so a page never opens mid-sentence; an
 *   over-long sentence falls back to balanced two-line chunks.
 * - Every page stays on screen at least MIN_PAGE_FRAMES so pages never flash.
 */

export const CAPTION_MAX_LINES = 2;
/** Shortest time a page is visible (frames), so a short page can't flash by. */
export const MIN_PAGE_FRAMES = 30;

export const CAPTION_FONT_SIZE = 22;
export const CAPTION_FONT_FAMILY = '"Segoe UI", system-ui, -apple-system, sans-serif';
export const CAPTION_BOX_MAX_WIDTH = 820;
export const CAPTION_BOX_PADDING_X = 22;
/** Text width available inside the caption box (box minus horizontal padding). */
export const CAPTION_INNER_WIDTH = CAPTION_BOX_MAX_WIDTH - CAPTION_BOX_PADDING_X * 2;
const CAPTION_FONT = `${CAPTION_FONT_SIZE}px ${CAPTION_FONT_FAMILY}`;
/** Char-width estimate, used only when canvas is unavailable (e.g. node tests). */
const FALLBACK_CHAR_WIDTH = CAPTION_FONT_SIZE * 0.54;

/** One caption page: the lines shown together, and when they become visible. */
export interface CaptionPage {
  lines: string[];
  /** Frame relative to the owning event's start when this page appears. */
  startFrame: number;
}

/* --- measurement --------------------------------------------------------- */

let measureCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

function context(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    measureCtx = null;
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      measureCtx = canvas.getContext("2d");
      if (measureCtx) measureCtx.font = CAPTION_FONT;
    }
  }
  return measureCtx;
}

/** Rendered width of `text` in the caption font, in px. Cached per string. */
export function measureCaptionText(text: string): number {
  const cached = widthCache.get(text);
  if (cached !== undefined) return cached;
  const ctx = context();
  const width = ctx ? ctx.measureText(text).width : text.length * FALLBACK_CHAR_WIDTH;
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(text, width);
  return width;
}

/* --- text segmentation ---------------------------------------------------- */

/**
 * Split into sentences. Only break after .!? when the next word looks like a
 * new sentence (starts uppercase or a quote), so "Oct. 7, 2023" or "U.S.
 * allies" stay in one piece.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"“'(\[])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/* --- line wrapping -------------------------------------------------------- */

/** Break a single word wider than the line into measured chunks that fit. */
function splitOverwideWord(word: string, maxWidth: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const char of word) {
    if (current && measureCaptionText(current + char) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Word wrap minimizing total squared slack so lines are balanced rather than
 * greedily packed (a full first line with a stub last line). Line widths are
 * measured, not guessed.
 */
export function wrapBalancedLines(text: string, maxWidth = CAPTION_INNER_WIDTH): string[] {
  const words: string[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (measureCaptionText(raw) > maxWidth) words.push(...splitOverwideWord(raw, maxWidth));
    else words.push(raw);
  }
  const n = words.length;
  if (n === 0) return [];

  const space = measureCaptionText(" ");
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + measureCaptionText(words[i]);
  const lineWidth = (from: number, to: number) => prefix[to + 1] - prefix[from] + space * (to - from);

  // cost[i] = best total squared slack wrapping words[i..n-1]. Every line's
  // slack counts — including the last — so a stub final line is penalized and
  // the pass settles on evenly-filled lines.
  const INF = Number.POSITIVE_INFINITY;
  const cost = new Array<number>(n + 1).fill(INF);
  const lineEnd = new Array<number>(n).fill(-1);
  cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i; j < n; j++) {
      const width = lineWidth(i, j);
      if (j > i && width > maxWidth) break;
      const rest = cost[j + 1];
      if (rest === INF) continue;
      const slack = maxWidth - width;
      const total = slack * slack + rest;
      if (total < cost[i]) {
        cost[i] = total;
        lineEnd[i] = j;
      }
    }
  }

  const lines: string[] = [];
  let start = 0;
  while (start < n) {
    const end = lineEnd[start];
    lines.push(words.slice(start, end + 1).join(" "));
    start = end + 1;
  }
  return lines;
}

/* --- page planning -------------------------------------------------------- */

/** Group sentence-wrapped lines into pages of at most CAPTION_MAX_LINES lines. */
function planPages(segments: string[], maxWidth: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) pages.push(current);
    current = [];
  };
  for (const segment of segments) {
    const lines = wrapBalancedLines(segment, maxWidth);
    if (lines.length === 0) continue;
    if (lines.length <= CAPTION_MAX_LINES) {
      if (current.length + lines.length > CAPTION_MAX_LINES) flush();
      current = current.concat(lines);
    } else {
      // A sentence longer than a full page: emit its balanced lines two at a
      // time so the break still lands between lines, never mid-line.
      flush();
      let i = 0;
      for (; i + CAPTION_MAX_LINES <= lines.length; i += CAPTION_MAX_LINES) {
        pages.push(lines.slice(i, i + CAPTION_MAX_LINES));
      }
      current = lines.slice(i);
    }
  }
  flush();
  return pages;
}

/**
 * Turn relative text weights into frame durations, keeping the proportional
 * pacing but raising any page below MIN_PAGE_FRAMES by borrowing from pages
 * with surplus time (a couple of passes converge; sizes here are tiny).
 */
function distributeFrames(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let frames = weights.map((w) => (w / sum) * total);
  if (frames.length <= 1 || total < MIN_PAGE_FRAMES * frames.length) return frames;
  for (let pass = 0; pass < 3; pass++) {
    const deficit = frames.reduce((acc, f) => acc + Math.max(0, MIN_PAGE_FRAMES - f), 0);
    if (deficit <= 0.001) break;
    const surplus = frames.reduce((acc, f) => acc + Math.max(0, f - MIN_PAGE_FRAMES), 0);
    if (surplus <= 0) break;
    frames = frames.map((f) =>
      f < MIN_PAGE_FRAMES ? MIN_PAGE_FRAMES : f - (deficit * (f - MIN_PAGE_FRAMES)) / surplus
    );
  }
  return frames;
}

/** Paginate a narration script into timed pages of at most two lines. */
export function captionPages(text: string, durationInFrames: number): CaptionPage[] {
  const pages = planPages(splitSentences(text), CAPTION_INNER_WIDTH);
  if (pages.length === 0) return [];
  const weights = pages.map((lines) => lines.reduce((sum, line) => sum + measureCaptionText(line), 0) || 1);
  const frames = distributeFrames(weights, Math.max(1, durationInFrames));
  let elapsed = 0;
  return pages.map((lines, index) => {
    const page: CaptionPage = { lines, startFrame: Math.round(elapsed) };
    elapsed += frames[index];
    return page;
  });
}

/** Page visible at `elapsedFrames`; the last page holds until the caption fades out. */
export function activeCaptionPage(pages: CaptionPage[], elapsedFrames: number): CaptionPage | null {
  if (pages.length === 0) return null;
  let active = pages[0];
  for (const page of pages) {
    if (elapsedFrames < page.startFrame) break;
    active = page;
  }
  return active;
}
