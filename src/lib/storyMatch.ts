import type { StoryMeta } from "./stories";

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "to",
  "in",
  "on",
  "for",
  "from",
  "with",
  "how",
  "what",
  "about",
  "into",
  "its",
  "by",
  "at",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "this",
  "that",
  "over",
  "under",
  "after",
  "before",
]);

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "story";
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function significantTokens(input: string): string[] {
  return normalize(input)
    .split(" ")
    .filter((token) => {
      if (!token || STOP.has(token)) return false;
      if (/^\d+$/.test(token)) return token.length >= 2;
      return token.length >= 3;
    });
}

/** Higher is a closer match. 0 means "not this story". */
export function scoreStoryQuery(query: string, meta: StoryMeta): number {
  const qNorm = normalize(query);
  const qSlug = slugify(query);
  if (qNorm.length < 2) return 0;

  const phrases = [
    normalize(meta.title),
    normalize(meta.subtitle ?? ""),
    normalize(meta.slug.replace(/-/g, " ")),
    ...(meta.queries ?? []).map(normalize),
  ].filter(Boolean);

  if (meta.slug === qSlug || phrases.some((phrase) => phrase === qNorm)) return 1;
  if ((meta.queries ?? []).some((saved) => slugify(saved) === qSlug)) return 1;

  if (
    qSlug.length >= 4 &&
    (meta.slug.startsWith(`${qSlug}-`) || qSlug.startsWith(`${meta.slug}-`))
  ) {
    return 0.96;
  }

  const queryTokens = significantTokens(query);
  if (queryTokens.length === 0) return 0;

  if (queryTokens.length === 1) {
    const token = queryTokens[0];
    const slugTokens = new Set(meta.slug.split("-").filter(Boolean));
    if (slugTokens.has(token) && token.length >= 4) return 0.84;
    return 0;
  }

  const pool = new Set(phrases.flatMap(significantTokens));
  const hits = queryTokens.filter((token) => pool.has(token));
  const ratio = hits.length / queryTokens.length;
  if (ratio >= 0.75 && hits.length >= 2) return 0.7 + ratio * 0.25;
  return 0;
}

/** The saved story this query already refers to, if the match is confident. */
export function findExistingStory(query: string, metas: StoryMeta[]): StoryMeta | null {
  let best: { meta: StoryMeta; score: number } | null = null;
  for (const meta of metas) {
    const score = scoreStoryQuery(query, meta);
    if (score < 0.72) continue;
    if (!best || score > best.score) best = { meta, score };
  }
  return best?.meta ?? null;
}
