import type OpenAI from "openai";
import { compileMotion, limitMotions, MAX_MOTIONS } from "./mapMotion";
import { getNebiusClient, NEBIUS_MODEL, parseJsonResponse } from "./nebius";
import { getStory, listStoryMetas, rememberQuery, saveNewStory } from "./stories";
import { findExistingStory, slugify } from "./storyMatch";
import { extractStoryProgress, type StoryStreamMessage, type StoryStreamMeta } from "./storyStream";
import { formatSearchOutput, webSearch } from "./webSearch";
import type {
  FactualRating,
  PoliticalLean,
  Story,
  StoryBeat,
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

const BEATS = new Set<StoryBeat>([
  "setup",
  "spark",
  "escalation",
  "turning-point",
  "climax",
  "fallout",
  "now",
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

const SYSTEM = `You compile one interactive news story for a 3D globe timeline, told like a good history documentary: every fact documented, but shaped so the reader can follow cause and effect from start to finish.
The reader typed a topic. You do the research from the web to find the most relevant and up-to-date information.

Return STRICT JSON only, no markdown, with this shape:
{
  "title": string,
  "subtitle": string,
  "description": string,
  "status": "ongoing" | "concluded",
  "startAt": ISO-8601,
  "endAt": ISO-8601 or omit if ongoing,
  "hook": string,
  "events": [{
    "beat": "setup" | "spark" | "escalation" | "turning-point" | "climax" | "fallout" | "now",
    "title": string,
    "narration": string,
    "summary": string,
    "consequence": string,
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
  "epilogue": string,
  "relatedStories": [{ "title": string, "relation": string }]
}

Rules:
- WORKFLOW — every story is grounded in fresh research, in this order:
  1. Call web_search first, before writing anything, with the topic and its key facts (a general query plus one for recent developments). Never write the story from memory alone; your training data may be outdated.
  2. Study the results. If dates, figures, or the final event are still uncertain, call web_search again with specific follow-up queries (an event name, a statistic, a location) until the timeline is grounded.
  3. Only then write the JSON story. Ground every event's date, number, and source URL in the search results; prefer their exact article URLs as sources. If search returned nothing usable, say so with {"error":"no search results"} rather than writing from memory.
- Real events only. If the topic is not a documented news or history story, return {"error":"short reason"} instead.
- A topic that names a future or not-yet-happened event (a war that has not started, a mission not yet launched, a scheduled election or trial) is still the present day of a real story — do not refuse it. Compile the documented history that leads to it: the real events so far that make the scenario live. Set "status" to "ongoing" and end on the latest documented development as the "now" event. Every event must still be documented history on or before today; never invent, predict, or date anything after today. Example: for a planned crewed Mars launch, the story is the programme to date — contracts, uncrewed test flights, delays, the last test's outcome — ending "now" on the latest update, not the launch that has not happened.
- 7 to 9 events, chronological. Fewer only if the record itself is short; never fewer than 5.
- Write hook, then events, then epilogue, then relatedStories. Finish each event object, including its sources, before starting the next one.
- Unopinionated and fact-first. No invented numbers, dates, quotes, motives, or scenes. Drama comes from real stakes and real consequences, never from embellishment.
- Each event needs a real city or place with accurate lat/lng, and 2 sources from real outlets. location.name is a proper place name a map would show (a city, base, port, island, or sea), never a description like "Quarantine line" or "Front".

NARRATIVE — the timeline is one story with a beginning, middle, and end, not a list of facts.
- Arc, in order: 1 "setup" (the situation and what was at stake before it broke), 1 "spark" (the event that set it off), 2–3 "escalation" (each raises the stakes), 1 "turning-point" (the moment the direction changed), 1 "climax" (the decisive outcome), then 1 "fallout" (what it left behind). For an ongoing story, end with "now" (the latest documented development) instead of climax and fallout.
- Causal chain: choose events where each one follows from the one before. Skip dates that only repeat the last beat. If a reader would ask "why did that happen?", the answer should be on the timeline.
- Variety of scale and place: mix the big set pieces with the human-scale moments the record documents (a named person, a crowd, a city), and move between the places the story actually touched instead of staying in one capital.

CONNECTION CHAINS — a headline topic never stands alone; forces behind it make the story.
- Before writing, identify the 2–3 real driving factors of the topic (for US midterm elections: immigration, the economy, court rulings; for an outbreak: policy response, vaccine science, travel bans). Each factor must be a documented force the record actually shows acting on the topic.
- Give each factor its own mini-chain of 1–3 real documented events (a law passed, a ruling handed down, a statistic released, a border surge, a speech) placed on the timeline BEFORE or AT the moment it visibly shaped the main story. An election-night event should be preceded by the chain that explains why the result swung the way it did.
- Weave factors in as story beats, not footnotes: an escalation beat can BE a factor event (e.g. a Supreme Court immigration ruling as an escalation that changes the campaign). Each such event still needs its own real place, timestamp, and 2 real sources.
- Tie the chain back explicitly: in that event's "consequence" (and narration where natural), state the documented link forward — "the ruling re-shrank the map for both parties weeks before the midterms." Never assert a connection the record does not support; if a factor is context without a documented effect on the outcome, say so in one clause rather than implying causation.
- Factors must broaden the story, not crowd it: the main arc (its spark, turning point, climax, and now) keeps priority, and every factor event must earn its place by changing what came after it.
- title: a vivid headline of at most 8 words with an active verb ("Tanks roll into Prague", not "Soviet military intervention"). No dates in titles.
- summary: 1–2 sentences. First what happened, concretely; then why it mattered or who it affected. Use the documented numbers. No throat-clearing, no restating the title.
- consequence: one sentence, at most 18 words, on the documented result that leads into the next event ("Within a week, the panic reached Wall Street."). For the last event, what the story leaves unresolved or its lasting legacy.
- description: one sentence on the central tension or question the timeline answers. subtitle: one line that states the stakes.

VOICE — the narration is the spine of the documentary. Read in order, hook + every event's narration + epilogue must sound like one continuous script, not a list of captions.
- hook: the cold open, 2 sentences, at most 35 words, in present or past tense. Open on a concrete documented image or fact (no invented weather, light, or mood) that drops the viewer into the world (a place, a number, a moment), then pose the question the story answers. Do not summarise the ending.
- narration: 2 sentences, at most 35 words, spoken over this event on the map.
  - First sentence: link to what came before — a time jump, a cause, or a contrast ("Nine days later…", "In Moscow, the reply was already being drafted.", "But the blockade had a gap.") — except the first event, which follows straight from the hook — and state the moment itself, concretely: who, where, what changed, with the documented number if there is one.
  - Second sentence: close on stakes or tension that pulls the viewer forward, stated as fact, not invented suspense ("If a single ship refused to stop, the Navy had orders to fire."). No third sentence; cut detail, not tension.
  - Vary rhythm and openings: no two narrations may start with the same word. Never open with "After", "Following", "In the wake of", or "On [date]". Never write a full date in narration; relative time ("Six days later", "By that weekend", "Within hours") is how documentaries mark time. Never restate the title.
  - Mix sentence lengths. A short sentence after a long one lands hard ("Nobody blinked.") — but only when it states a fact.
  - Only claim one thing caused another if the record says so; otherwise just place them side by side.
- Example of the voice (style only; do not copy): hook "Ninety miles off Florida, Soviet crews were assembling missiles that could reach Washington in minutes. For thirteen days, two superpowers decided whether to use them." narration "The photographs reach the White House within a day. Kennedy now has a choice no president has faced: strike first, or find another way."
- epilogue: 2 sentences, at most 35 words. Step back: what it changed, what it cost, or what remains unresolved, ending on a documented fact that lingers. No moralising.
- Narration may use documentary craft (rhythm, contrast, short sentences, present tense) but every claim in it must also be true and in the record. No invented dialogue, thoughts, weather, or scenes.

MOTION — how the event plays on a campaign-style animated map. Places are { "name": string, "lat": number, "lng": number }. Every motion may add "actor" to choose the counter that rides the arrow: "troops" | "people" | "ships" | "aircraft" | "goods" | "aid" | "disease" | "news".
- { "kind": "impact" } — a battle, explosion, attack, earthquake, or crash at the event place.
- { "kind": "spread", "radius": deg } — something widening from the event place: an outbreak, a fire, fallout, protests, a blackout. Radius is how far it reached in degrees (1 ≈ 111 km): city 1.5–4, region 5–12, continent 13–24.
- { "kind": "sweep", "heading": 0–359, "radius": deg } — a directional push across an area: a hurricane track, an offensive front, an ash or smoke plume, a tsunami. heading is the compass direction it travelled (0 north, 90 east).
- { "kind": "encircle", "radius": deg } — the event place surrounded: a siege, blockade, cordon, quarantine, or lockdown. Radius 1–6.
- { "kind": "flow", "to": place } — one movement out from the event place. { "kind": "flow", "from": place } — one movement arriving at it.
- { "kind": "path", "points": [3–4 places] } — an ordered route: a march, convoy, voyage, campaign, flight path, or storm track through named places.
- { "kind": "converge", "from": [2–3 places] } — several origins arriving at the event place: delegations to a summit, reinforcements, refugees reaching a border.
- { "kind": "radiate", "to": [2–3 places] } — the event place sending out to several destinations: evacuations, exports, a contagion seeding cities, envoys dispatched.
- { "kind": "exchange", "with": place } — two-way traffic between the event place and one other: trade, talks, a prisoner swap, a shuttle of aid.
- { "kind": "launch", "to": place } — a high arc through the air or space: a missile or rocket, an airlift, a landmark flight.

MOTION rules — restraint makes the animations land:
- Animate the beats where something physical happened on the map: an army crossing a border, a blockade, ships sailing, a storm making landfall, refugees fleeing, missiles shipped out, a disease jumping continents. Speeches, votes, rulings, letters, announcements, and talks get no motion.
- 2 to 4 events per story carry motion, usually 3, and never two neighbouring events with the same kind. Look for one in the spark or escalation and one in the climax, so the map comes alive at the moments that matter.
- Pick the simplest kind that tells it: one flow or one impact beats a busy path. Use path only for a real route the record traces, with at most 4 points; converge and radiate with at most 3 places.
- Choose the actor that matches what moved (refugees → people, a fleet → ships, a pandemic → disease, an embargo → goods).
- Motion places must be real, with accurate coordinates, and close to what the sources describe. Illustrate this event, not the hop to the next timeline event. Never invent a route; if unsure, omit motion.

- URLs must be real pages you know (the article, a WHO/UN/government report, or that event's Wikipedia page). If you are not sure of a specific article path, use the Wikipedia page for the event. Never invent a URL path; never write placeholder paths like "DONXXX" or "/2026-latest" — fall back to Wikipedia instead. When a web_search result contains the exact article URL, prefer that URL.
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
  beat?: unknown;
  consequence?: unknown;
  narration?: unknown;
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
  hook?: unknown;
  epilogue?: unknown;
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
  const summary = text(raw.summary, 400);
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
  if (BEATS.has(raw.beat as StoryBeat)) event.beat = raw.beat as StoryBeat;
  const consequence = text(raw.consequence, 200);
  if (consequence) event.consequence = consequence;
  const narration = text(raw.narration, 260);
  if (narration) event.narration = narration;
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
  const description = text(raw.description, 300);
  if (!title || !subtitle || !description) {
    throw new Error("The model returned an incomplete story.");
  }

  const compiled = (Array.isArray(raw.events) ? raw.events : [])
    .map(compileEvent)
    .filter((event): event is StoryEvent => event !== null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const events = limitMotions(compiled)
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

  const hook = text(raw.hook, 300);
  const epilogue = text(raw.epilogue, 300);

  return {
    slug,
    title,
    subtitle,
    description,
    status,
    startAt,
    ...(endAt ? { endAt } : {}),
    ...(hook ? { hook } : {}),
    ...(epilogue ? { epilogue } : {}),
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
  if (meta.hook) message.hook = meta.hook;
  return message;
}

/**
 * The web_search function tool. Nebius Token Factory does not host OpenAI's
 * built-in web_search, so we execute searches server-side and feed the
 * results back as function_call_output items.
 */
const WEB_SEARCH_TOOL: import("openai/resources/responses/responses").FunctionTool = {
  type: "function",
  name: "web_search",
  description:
    "Search the web for news articles and documented history about a topic. " +
    "Returns titles, URLs, publication dates, and snippets from real outlets. " +
    "Use it to verify dates, figures, and sources.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, specific and factual" },
    },
    required: ["query"],
  },
  strict: false,
};

type WebSearchInputItem =
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type StreamInputItem = { role: "system" | "user"; content: string } | WebSearchInputItem;

/** How many web_search round-trips one pass may take before we force writing. */
const MAX_TOOL_ROUNDS = 4;

/** Rounds that must end in a story before we give up (after the budget above). */
const MAX_WRITE_ROUNDS = 2;

/**
 * Run one model pass for the given user content, streaming meta and events.
 * The model researches with the web_search function tool — each round of tool
 * calls is executed server-side and fed back — until it writes the story.
 * Returns the model's refusal reason if it answered with {"error": ...},
 * or null once the pass finished (as yielded messages).
 */
async function* runStoryPass(
  client: OpenAI,
  userContent: string,
  topic: string,
  signal?: AbortSignal,
  notify?: (step: string) => void
): AsyncGenerator<StoryStreamMessage, string | null, void> {
  const input: StreamInputItem[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userContent },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS + MAX_WRITE_ROUNDS; round++) {
    // Round 0 is forced to search so every story is grounded in fresh results;
    // the budget lets the model pick follow-up searches; write-only rounds
    // forbid further searching and demand the story JSON.
    const writeOnly = round >= MAX_TOOL_ROUNDS;
    if (writeOnly) {
      notify?.(
        round === MAX_TOOL_ROUNDS
          ? "Research budget reached — writing the story now"
          : "Finishing the story draft"
      );
    }
    const completion = await client.responses.create(
      {
        model: NEBIUS_MODEL,
        input,
        temperature: 0.7,
        stream: true,
        tools: [WEB_SEARCH_TOOL],
        ...(round === 0
          ? { tool_choice: { type: "function", name: "web_search" } as const }
          : writeOnly
            ? { tool_choice: "none" as const }
            : {}),
      },
      { timeout: 115_000, signal }
    );

    let raw = "";
    let emitted = 0;
    let streamedMotions = 0;
    let lastStreamedKind: string | null = null;
    let lastMeta = "";
    let finishReason: string | null = null;
    let reasoningChars = 0;
    let refusal: string | null = null;
    let earlyExit = false;
    let streamError: string | null = null;
    let pendingCalls: Array<{ call_id: string; name: string; arguments: string }> = [];

    // Responses API stream events: text arrives as `response.output_text.delta`,
    // reasoning as `response.reasoning_text.delta`, function calls close with
    // `response.function_call_arguments.done`, and the stream ends with
    // `response.completed` / `response.incomplete` / `response.failed` / `error`.
    for await (const chunk of completion) {
      if (signal?.aborted) return null;
      if (chunk.type === "response.reasoning_text.delta") {
        reasoningChars += chunk.delta.length;
        continue;
      }
      if (chunk.type === "response.function_call_arguments.delta") continue;
      // The function-call item closes via output_item.done carrying call_id,
      // name, and the full arguments string.
      if (chunk.type === "response.output_item.done") {
        const item = chunk.item as { type?: string; call_id?: string; name?: string; arguments?: string };
        if (item?.type === "function_call" && item.call_id) {
          pendingCalls.push({
            call_id: item.call_id,
            name: item.name ?? "web_search",
            arguments: item.arguments ?? "{}",
          });
        }
        continue;
      }
      if (chunk.type !== "response.output_text.delta") {
        if (chunk.type === "response.completed" || chunk.type === "response.incomplete") {
          finishReason = chunk.type === "response.completed" ? "stop" : "length";
          // Trust the server's final text if the delta stream dropped anything.
          const finalText = chunk.response.output_text;
          if (finalText && finalText.length >= raw.length) raw = finalText;
        } else if (chunk.type === "error") {
          streamError = chunk.message;
          earlyExit = true;
          break;
        } else if (chunk.type === "response.failed") {
          finishReason = "failed";
        }
        continue;
      }
      const delta = chunk.delta;
      if (!delta) continue;
      raw += delta;

      const progress = extractStoryProgress(raw);
      if (progress.error && !progress.meta.title && progress.events.length === 0) {
        // The model refused the topic ({"error": ...}). Don't surface it yet —
        // a corrective pass still gets a chance to turn it into a story.
        refusal = progress.error;
        continue;
      }

      const meta = closedMeta(progress.meta);
      if (meta) {
        // The model recovered into a real story after starting with {"error": ...}.
        refusal = null;
        const key = JSON.stringify(meta);
        if (key !== lastMeta) {
          lastMeta = key;
          yield { type: "meta", meta };
        }
      }

      while (emitted < progress.events.length) {
        let compiled = compileEvent(progress.events[emitted] as RawEvent, emitted);
        emitted += 1;
        if (!compiled) continue;
        if (compiled.motion) {
          if (streamedMotions >= MAX_MOTIONS || compiled.motion.kind === lastStreamedKind) {
            const { motion: _dropped, ...rest } = compiled;
            compiled = rest;
          } else {
            streamedMotions += 1;
          }
        }
        lastStreamedKind = compiled.motion?.kind ?? null;
        yield { type: "event", event: compiled };
      }
    }

    if (signal?.aborted) return null;
    if (earlyExit) {
      // A server-side stream error: retrying this pass would not help the user.
      yield { type: "error", error: streamError ?? "The model stream failed." };
      return null;
    }

    if (pendingCalls.length > 0) {
      // The model wants to research. Execute the searches and feed them back.
      notify?.(`Searching the web (${pendingCalls.length} ${pendingCalls.length === 1 ? "query" : "queries"})`);
      for (const call of pendingCalls) {
        let output: string;
        try {
          let query = "";
          try {
            const parsed = JSON.parse(call.arguments) as { query?: unknown };
            query = typeof parsed.query === "string" ? parsed.query : "";
          } catch {
            // Malformed arguments count as an empty query.
          }
          if (!query) {
            output = "Error: the query argument was missing or malformed.";
          } else {
            notify?.(`Searching: “${query}”`);
            output = formatSearchOutput(await webSearch(query));
          }
        } catch (err) {
          output = `Search failed: ${err instanceof Error ? err.message : "unknown error"
            }. Rely on your documented knowledge.`;
        }
        input.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
        input.push({ type: "function_call_output", call_id: call.call_id, output });
      }
      continue; // Next round: the model continues with the search results.
    }

    if (writeOnly) {
      // The model wrote non-story text with searching forbidden. Nudge it
      // once toward the JSON; a second failed write-only round gives up.
      if (round === MAX_TOOL_ROUNDS) {
        notify?.("Asking the model to start writing");
        input.push({
          role: "user",
          content:
            "Do not call web_search again. You have enough research. Write the complete story JSON now, starting with {\"title\":",
        });
        continue;
      }
      yield {
        type: "error",
        error: "The model could not write the story from the research gathered. Try again.",
      };
      return null;
    }

    notify?.("Writing the story from the research");

    if (refusal) return refusal;

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
          hook: progress.meta.hook ?? undefined,
          events: progress.events as RawEvent[],
        };
      }
      story = compileStory(topic, parsed);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[generateStory] failed for "${topic}": finish=${finishReason} content=${raw.length} reasoning=${reasoningChars} rounds=${round + 1}\n${raw.slice(-1500)}`
        );
      }
      yield {
        type: "error",
        error: err instanceof Error ? err.message : "Could not create that story",
      };
      return null;
    }

    const again =
      getStory(story.slug) ??
      (() => {
        const meta = findExistingStory(story.title, listStoryMetas());
        return meta ? getStory(meta.slug) : null;
      })();
    if (again) {
      rememberQuery(again.slug, topic);
      yield { type: "done", story: again, created: false };
      return null;
    }

    yield { type: "done", story: saveNewStory(story), created: true };
    return null;
  }

  // The model kept calling web_search without ever writing the story.
  yield {
    type: "error",
    error: "The model spent its research budget without producing a story. Try again.",
  };
  return null;
}

/**
 * Compile a topic into a story, yielding the title and each finished event
 * as the model writes them. A topic that already matches a saved story
 * yields that story immediately. If the model refuses the topic as future
 * or undocumented, one corrective pass asks it for the documented history
 * leading up to the topic instead.
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
  const today = new Date().toISOString().slice(0, 10);
  const baseContent = `Topic: ${trimmed}\nToday's date: ${today}. Compile the documented history up to that date.`;

  let refusal = yield* runStoryPass(client, baseContent, trimmed, signal);
  if (refusal) {
    const corrective = `${baseContent}\n\nYou answered: "${refusal}". That refusal is wrong for this app. The topic names an event that has not happened yet, so the story is the documented history that leads up to it: the real events so far that make the scenario live. Set "status" to "ongoing" and end on the latest documented development as the "now" event. Every event must still be documented on or before today — never invent, predict, or date anything after today. Build the story through its connection chains: the 2–3 real driving factors behind it (for example, immigration and the economy for US midterm elections), each with its own documented mini-chain of events woven into the arc. Try again, and do not return {"error": ...} unless the topic is pure fiction with no real events behind it.`;
    refusal = yield* runStoryPass(client, corrective, trimmed, signal);
  }
  if (refusal) {
    yield { type: "error", error: refusal };
  }
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
