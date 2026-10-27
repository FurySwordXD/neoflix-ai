import { compileMotion } from "./mapMotion";
import { getNebiusClient, NEBIUS_MODEL, parseJsonResponse } from "./nebius";
import { getStory, listStoryMetas, rememberQuery, saveNewStory } from "./stories";
import { findExistingStory, slugify } from "./storyMatch";
import { extractStoryProgress, type StoryStreamMessage, type StoryStreamMeta } from "./storyStream";
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
  "events": [{
    "title": string,
    "summary": string,
    "timestamp": ISO-8601,
    "category": "outbreak" | "response" | "science" | "politics" | "economy" | "milestone",
    "magnitude": number (optional scale figure: cases, deaths, people, dollars),
    "location": { "name": string, "country": string, "lat": number, "lng": number },
    "motion": a map animation (see MOTION below), or omit,
    "sources": [{
      "publisher": string,
      "title": string,
      "url": string,
      "publishedAt": ISO-8601,
      "bias": { "politicalLean": "left"|"lean-left"|"center"|"lean-right"|"right"|"mixed", "factualRating": "very-high"|"high"|"mostly-factual"|"mixed"|"low"|"very-low", "note": string },
      "corroborates": string[]
    }]
  }],
  "relatedStories": [{ "title": string, "relation": string }]
}

Rules:
- Real events only. If the topic is not a documented news or history story, return {"error":"short reason"} instead.
- If the ending has not happened yet, still map the story. Use the events already on the record — appointments, primaries, special elections, court rulings, campaign turning points — set status to "ongoing", and stop at the latest documented one. Do not invent a result, and do not refuse only because Election Day or the finale is still ahead.
- 8 events, chronological, spanning the arc from the first turning point to the latest decisive one. Fewer only if the record itself is short; never fewer than 5.
- Write events before relatedStories. Finish each event object, including its sources, before starting the next one.
- Unopinionated, fact-first, vivid. No invented numbers, dates, or quotes.
- Each event needs a real city or place with accurate lat/lng, and 2 sources from real outlets.
- Pick events that show the story in motion on a map: forces advancing, people fleeing, ships sailing, aid arriving, a disease or storm spreading, envoys meeting, sanctions biting. Where the record allows, prefer those turning points over a string of speeches and votes in one capital, and spread events across the places the story actually touched.

MOTION — how the event plays on a campaign-style animated map. Places are { "name": string, "lat": number, "lng": number }. Every motion may add "actor" to choose the counter that rides the arrow: "troops" | "people" | "ships" | "aircraft" | "goods" | "aid" | "disease" | "news".
- { "kind": "impact" } — a battle, explosion, attack, earthquake, or crash at the event place.
- { "kind": "spread", "radius": deg } — something widening from the event place: an outbreak, a fire, fallout, protests, a blackout. Radius is how far it reached in degrees (1 ≈ 111 km): city 1.5–4, region 5–12, continent 13–24.
- { "kind": "sweep", "heading": 0–359, "radius": deg } — a directional push across an area: a hurricane track, an offensive front, an ash or smoke plume, a tsunami. heading is the compass direction it travelled (0 north, 90 east).
- { "kind": "encircle", "radius": deg } — the event place surrounded: a siege, blockade, cordon, quarantine, or lockdown. Radius 1–6.
- { "kind": "flow", "to": place } — one movement out from the event place. { "kind": "flow", "from": place } — one movement arriving at it.
- { "kind": "path", "points": [3–6 places] } — an ordered route: a march, convoy, voyage, campaign, flight path, or storm track through named places.
- { "kind": "converge", "from": [2–4 places] } — several origins arriving at the event place: delegations to a summit, reinforcements, refugees reaching a border.
- { "kind": "radiate", "to": [2–4 places] } — the event place sending out to several destinations: evacuations, exports, a contagion seeding cities, envoys dispatched.
- { "kind": "exchange", "with": place } — two-way traffic between the event place and one other: trade, talks, a prisoner swap, a shuttle of aid.
- { "kind": "launch", "to": place } — a high arc through the air or space: a missile or rocket, an airlift, a landmark flight.

MOTION rules:
- Give a motion to every event that genuinely moved, spread, struck, or connected places. Aim for at least 6 of 8 events with motion, and use at least 4 different kinds across the story. Do not reuse one kind more than 3 times.
- Choose the kind and actor that match what happened (refugees → people, a fleet → ships, a pandemic → disease, a sanction or broadcast → news, a loan or embargo → goods).
- A stationary act (a speech, a vote, a ruling, a signing) may still use converge, radiate, or exchange when the record names the places involved — the delegations that came, or the capitals that responded. Otherwise omit motion.
- Motion places must be real, with accurate coordinates, and close to what the sources describe. Illustrate this event, not the hop to the next timeline event. Never invent a route; if you cannot name the places, use impact, spread, sweep, or encircle, or omit motion.

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
  motion?: unknown;
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
  const motion = compileMotion(raw.motion, { name, lat, lng });
  if (motion) event.motion = motion;
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

function closedMeta(meta: ReturnType<typeof extractStoryProgress>["meta"]): StoryStreamMeta | null {
  if (!meta.title) return null;
  const message: StoryStreamMeta = { title: meta.title };
  if (meta.subtitle) message.subtitle = meta.subtitle;
  if (meta.description) message.description = meta.description;
  if (meta.status) message.status = meta.status;
  return message;
}

/**
 * Compile a topic into a story, yielding the title and each finished event
 * as the model writes them. A topic that already matches a saved story
 * yields that story immediately.
 */
export async function* generateStoryStream(
  query: string,
  signal?: AbortSignal
): AsyncGenerator<StoryStreamMessage> {
  const trimmed = query.trim();
  const existing = findExistingStory(trimmed, listStoryMetas());
  if (existing) {
    const story = getStory(existing.slug);
    if (story) {
      rememberQuery(story.slug, trimmed);
      yield { type: "cached", story };
      return;
    }
  }

  const client = getNebiusClient();
  const completion = await client.chat.completions.create(
    {
      model: NEBIUS_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Topic: ${trimmed}` },
      ],
      temperature: 0.3,
      // The model reasons before writing; that counts against this budget too.
      max_tokens: 24000,
      stream: true,
    },
    { timeout: 115_000, signal }
  );

  let raw = "";
  let emitted = 0;
  let lastMeta = "";
  let finishReason: string | null = null;
  let reasoningChars = 0;

  for await (const chunk of completion) {
    if (signal?.aborted) return;
    const choice = chunk.choices[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const reasoning = (choice?.delta as { reasoning_content?: unknown } | undefined)
      ?.reasoning_content;
    if (typeof reasoning === "string") reasoningChars += reasoning.length;
    const delta = choice?.delta?.content;
    if (typeof delta !== "string" || !delta) continue;
    raw += delta;

    const progress = extractStoryProgress(raw);
    if (progress.error && !progress.meta.title && progress.events.length === 0) {
      yield { type: "error", error: progress.error };
      return;
    }

    const meta = closedMeta(progress.meta);
    if (meta) {
      const key = JSON.stringify(meta);
      if (key !== lastMeta) {
        lastMeta = key;
        yield { type: "meta", meta };
      }
    }

    while (emitted < progress.events.length) {
      const compiled = compileEvent(progress.events[emitted] as RawEvent, emitted);
      emitted += 1;
      if (compiled) yield { type: "event", event: compiled };
    }
  }

  if (signal?.aborted) return;

  let story: Story;
  try {
    let parsed: RawStory;
    try {
      parsed = parseModelJson(raw);
    } catch {
      // The model broke the JSON somewhere. Keep every event that closed cleanly.
      const progress = extractStoryProgress(raw);
      parsed = {
        error: progress.error ?? undefined,
        title: progress.meta.title ?? undefined,
        subtitle: progress.meta.subtitle ?? undefined,
        description: progress.meta.description ?? undefined,
        status: progress.meta.status ?? undefined,
        events: progress.events as RawEvent[],
      };
    }
    story = compileStory(trimmed, parsed);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[generateStory] failed for "${trimmed}": finish=${finishReason} content=${raw.length} reasoning=${reasoningChars}\n${raw.slice(-1500)}`
      );
    }
    yield {
      type: "error",
      error: err instanceof Error ? err.message : "Could not create that story",
    };
    return;
  }

  const again =
    getStory(story.slug) ??
    (() => {
      const meta = findExistingStory(story.title, listStoryMetas());
      return meta ? getStory(meta.slug) : null;
    })();
  if (again) {
    rememberQuery(again.slug, trimmed);
    yield { type: "done", story: again, created: false };
    return;
  }

  yield { type: "done", story: saveNewStory(story), created: true };
}

/**
 * Build a full story from a topic alone and save it.
 * If that topic already landed on a saved story, return the saved one.
 */
export async function generateStory(query: string): Promise<{ story: Story; created: boolean }> {
  let result: { story: Story; created: boolean } | null = null;
  for await (const message of generateStoryStream(query)) {
    if (message.type === "error") throw new Error(message.error);
    if (message.type === "cached") return { story: message.story, created: false };
    if (message.type === "done") result = { story: message.story, created: message.created };
  }
  if (!result) throw new Error("Could not create that story");
  return result;
}
