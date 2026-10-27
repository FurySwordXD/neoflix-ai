import { getNebiusClient, NEBIUS_MODEL, parseJsonResponse } from "./nebius";
import { getStory, listStoryMetas, saveNewStory } from "./stories";
import { findExistingStory, slugify } from "./storyMatch";
import type {
  FactualRating,
  PoliticalLean,
  Story,
  StoryEvent,
} from "./types";

const CATEGORIES = new Set<StoryEvent["category"]>([
  "outbreak",
  "response",
  "science",
  "politics",
  "economy",
  "milestone",
]);

const LEANS = new Set<PoliticalLean>([
  "left",
  "lean-left",
  "center",
  "lean-right",
  "right",
  "mixed",
]);

const RATINGS = new Set<FactualRating>([
  "very-high",
  "high",
  "mostly-factual",
  "mixed",
  "low",
  "very-low",
]);

const SYSTEM = `You compile one interactive news story for a 3D globe timeline.
The reader typed a topic. You do the research from documented history. They will not provide links.

Return STRICT JSON only, no markdown, with this shape:
{
  "title": string,
  "subtitle": string,
  "description": string,
  "status": "ongoing" | "concluded",
  "startAt": ISO-8601,
  "endAt": ISO-8601 or omit if ongoing,
  "relatedStories": [{ "title": string, "relation": string }],
  "events": [{
    "title": string,
    "summary": string,
    "timestamp": ISO-8601,
    "category": "outbreak" | "response" | "science" | "politics" | "economy" | "milestone",
    "magnitude": number (optional scale figure: cases, deaths, people, dollars),
    "location": { "name": string, "country": string, "lat": number, "lng": number },
    "sources": [{
      "publisher": string,
      "title": string,
      "url": string,
      "publishedAt": ISO-8601,
      "bias": { "politicalLean": "left"|"lean-left"|"center"|"lean-right"|"right"|"mixed", "factualRating": "very-high"|"high"|"mostly-factual"|"mixed"|"low"|"very-low", "note": string },
      "corroborates": string[]
    }]
  }]
}

Rules:
- Real events only. If the topic is not a documented news or history story, return {"error":"short reason"} instead.
- If the ending has not happened yet, still map the story. Use the events already on the record — appointments, primaries, special elections, court rulings, campaign turning points — set status to "ongoing", and stop at the latest documented one. Do not invent a result, and do not refuse only because Election Day or the finale is still ahead.
- 8 events, chronological, spanning the arc from the first turning point to the latest decisive one. Fewer only if the record itself is short; never fewer than 5.
- Unopinionated, fact-first, vivid. No invented numbers, dates, or quotes.
- Each event needs a real city or place with accurate lat/lng, and 2 sources from real outlets.
- URLs must be real pages you know (the article, a WHO/UN/government report, or that event's Wikipedia page). If you are not sure of a specific article path, use the Wikipedia page for the event. Never invent a URL path.
- Classify each outlet's bias from your knowledge of that publisher.
- relatedStories: 0 to 3 adjacent real stories, title and one-line relation only.`;

interface RawSource {
  publisher?: unknown;
  title?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  bias?: { politicalLean?: unknown; factualRating?: unknown; note?: unknown };
  corroborates?: unknown;
}

interface RawEvent {
  title?: unknown;
  summary?: unknown;
  timestamp?: unknown;
  category?: unknown;
  magnitude?: unknown;
  location?: { name?: unknown; country?: unknown; lat?: unknown; lng?: unknown };
  sources?: RawSource[];
}

interface RawStory {
  error?: unknown;
  title?: unknown;
  subtitle?: unknown;
  description?: unknown;
  status?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  relatedStories?: Array<{ title?: unknown; relation?: unknown; slug?: unknown }>;
  events?: RawEvent[];
}

function text(value: unknown, max = 400): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function asIso(value: unknown): string | null {
  const raw = text(value, 40);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function asUrl(value: unknown, fallbackTitle: string): string {
  const raw = text(value, 400);
  if (/^https?:\/\/\S+$/i.test(raw)) return raw;
  const q = encodeURIComponent(fallbackTitle || "news");
  return `https://en.wikipedia.org/w/index.php?search=${q}`;
}

function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseModelJson(raw: string): RawStory {
  const cleaned = stripThinking(raw);
  try {
    return parseJsonResponse<RawStory>(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as RawStory;
    }
    throw new Error("The model did not return a story.");
  }
}

function compileEvent(raw: RawEvent, index: number): StoryEvent | null {
  const title = text(raw.title, 140);
  const summary = text(raw.summary, 700);
  const timestamp = asIso(raw.timestamp);
  const name = text(raw.location?.name, 80);
  const country = text(raw.location?.country, 80);
  const lat = Number(raw.location?.lat);
  const lng = Number(raw.location?.lng);
  if (!title || !summary || !timestamp || !name || !country) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const category = CATEGORIES.has(raw.category as StoryEvent["category"])
    ? (raw.category as StoryEvent["category"])
    : "milestone";
  const id = `e${String(index + 1).padStart(2, "0")}`;

  const sources: StoryEvent["sources"] = [];
  for (const [sourceIndex, source] of (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 3).entries()) {
    const publisher = text(source.publisher, 80);
    const sourceTitle = text(source.title, 180);
    if (!publisher || !sourceTitle) continue;
    const lean = LEANS.has(source.bias?.politicalLean as PoliticalLean)
      ? (source.bias?.politicalLean as PoliticalLean)
      : "mixed";
    const rating = RATINGS.has(source.bias?.factualRating as FactualRating)
      ? (source.bias?.factualRating as FactualRating)
      : "mixed";
    const corroborates = Array.isArray(source.corroborates)
      ? source.corroborates.map((item) => text(item, 80)).filter(Boolean).slice(0, 4)
      : [];
    sources.push({
      id: `${id}-s${sourceIndex + 1}`,
      publisher,
      title: sourceTitle,
      url: asUrl(source.url, sourceTitle),
      publishedAt: asIso(source.publishedAt) ?? timestamp,
      bias: {
        politicalLean: lean,
        factualRating: rating,
        note: text(source.bias?.note, 180) || "Classification from the outlet's known record",
      },
      corroborates,
    });
  }

  if (sources.length === 0) return null;

  const magnitude = Number(raw.magnitude);
  const event: StoryEvent = {
    id,
    title,
    summary,
    location: { name, country, lat, lng },
    timestamp,
    category,
    sources,
  };
  if (Number.isFinite(magnitude) && magnitude >= 0) event.magnitude = magnitude;
  return event;
}

function compileStory(query: string, raw: RawStory): Story {
  if (typeof raw.error === "string" && raw.error.trim()) {
    throw new Error(raw.error.trim());
  }

  const title = text(raw.title, 140);
  const subtitle = text(raw.subtitle, 180);
  const description = text(raw.description, 600);
  if (!title || !subtitle || !description) {
    throw new Error("The model returned an incomplete story.");
  }

  const events = (Array.isArray(raw.events) ? raw.events : [])
    .map(compileEvent)
    .filter((event): event is StoryEvent => event !== null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((event, index) => ({
      ...event,
      id: `e${String(index + 1).padStart(2, "0")}`,
      sources: event.sources.map((source, sourceIndex) => ({
        ...source,
        id: `e${String(index + 1).padStart(2, "0")}-s${sourceIndex + 1}`,
      })),
    }));

  if (events.length < 5) {
    throw new Error("The model could not ground enough events for that story.");
  }

  const status = raw.status === "ongoing" ? "ongoing" : "concluded";
  const firstAt = events[0].timestamp;
  const lastAt = events[events.length - 1].timestamp;
  const parsedStart = asIso(raw.startAt);
  const startAt = parsedStart && parsedStart < firstAt ? parsedStart : firstAt;
  const parsedEnd = asIso(raw.endAt);
  const endAt =
    status === "ongoing"
      ? parsedEnd && parsedEnd > lastAt
        ? parsedEnd
        : undefined
      : parsedEnd && parsedEnd > lastAt
        ? parsedEnd
        : lastAt;

  const slug = slugify(title);
  const relatedStories = (Array.isArray(raw.relatedStories) ? raw.relatedStories : [])
    .slice(0, 3)
    .flatMap((item) => {
      const relTitle = text(item?.title, 140);
      const relation = text(item?.relation, 180);
      if (!relTitle || !relation) return [];
      const relSlug = slugify(text(item?.slug, 80) || relTitle);
      if (relSlug === slug) return [];
      return [{ slug: relSlug, title: relTitle, relation }];
    });

  return {
    slug,
    title,
    subtitle,
    description,
    status,
    startAt,
    ...(endAt ? { endAt } : {}),
    queries: [query.trim().slice(0, 200)],
    relatedStories,
    events,
  };
}

/**
 * Build a full story from a topic alone and save it.
 * If that topic already landed on a saved story, return the saved one.
 */
export async function generateStory(query: string): Promise<{ story: Story; created: boolean }> {
  const existing = findExistingStory(query, listStoryMetas());
  if (existing) {
    const story = getStory(existing.slug);
    if (story) return { story, created: false };
  }

  const client = getNebiusClient();
  const completion = await client.chat.completions.create(
    {
      model: NEBIUS_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Topic: ${query.trim()}` },
      ],
      temperature: 0.3,
      max_tokens: 7000,
    },
    { timeout: 90_000 }
  );

  const raw = completion.choices[0]?.message?.content ?? "";
  const story = compileStory(query, parseModelJson(raw));

  const again =
    getStory(story.slug) ??
    (() => {
      const meta = findExistingStory(story.title, listStoryMetas());
      return meta ? getStory(meta.slug) : null;
    })();
  if (again) return { story: again, created: false };

  return { story: saveNewStory(story), created: true };
}
