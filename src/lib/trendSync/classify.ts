import { getNebiusClient, NEBIUS_MODEL, parseJsonResponse } from "../nebius";
import { INTERESTS } from "../recommend";
import { topicKey } from "../storyStore/neo4j";
import type { GraphConnection } from "./graph";
import { HEADLINES_PER_TOPIC, type Candidate } from "./selection";

/**
 * One batched model call that sorts trending searches into story-worthy news
 * and everything else, with a search query and a dashboard subject for each.
 * Each term goes with its traffic and a few recent headlines, so the model
 * judges the news event behind the search rather than the bare words.
 * The answer is validated strictly: anything malformed and nothing is stored.
 */

/** The subjects the static TRENDS list and reader profiles use. */
export const CATEGORIES: readonly string[] = INTERESTS.map((interest) => interest.id);

export interface Classification {
  key: string;
  name: string;
  worthy: boolean;
  /** What the story is generated from; null for a topic that is not worthy. */
  query: string | null;
  category: string | null;
}

export interface ClassifyDeps {
  complete: (system: string, user: string) => Promise<string>;
  warn: (message: string) => void;
}

const QUERY_MAX = 120;

const HEADLINE_MAX = 200;

const SYSTEM = `You triage trending search terms for a news app that turns real events into dated, geolocated story timelines.
You get a JSON array of trending topics: {"name": the search term, "traffic": approximate searches or null, "headlines": up to ${HEADLINES_PER_TOPIC} recent news headlines about it, each {"title", "source"}}.
Judge the news event the headlines describe, not the bare search term: a person's name or a generic phrase is worthy when its headlines report a real development.
Answer with STRICT JSON only, no markdown:
{"topics": [{"name": string, "worthy": boolean, "query": string, "category": string | null}]}
Rules:
- One entry per input topic, with "name" copied exactly from the input. Never add or drop topics.
- "worthy" is true when the headlines show a real news development that supports a dated timeline story: a chain of documented events with a before and after, such as conflicts, elections, disasters, outbreaks, court cases, policy decisions, business or market upheavals, accidents, deaths or health news of public figures, scientific milestones.
- "worthy" is false for sports scores, fixtures, results and standings; shopping, deal, price and product lookups; weather forecasts; lottery results, TV listings, recipes; and bare name searches whose headlines show no specific event. With no headlines, judge the term alone and say false unless it plainly names a real news event.
- "query" names the story to research in at most 10 words, built from the headlines, e.g. "2026 Gaza ceasefire negotiations" or "Michael Douglas health scare". Use "" when not worthy.
- "category" is one of: ${CATEGORIES.join(", ")}. Pick the closest when worthy; use null when not worthy.`;

interface TopicPayload {
  name: string;
  traffic: number | null;
  headlines: Array<{ title: string; source: string }>;
}

/** What the model sees for one topic: its name, traffic and up to 3 clipped headlines. */
export function topicPayload(topic: Candidate): TopicPayload {
  return {
    name: topic.name,
    traffic: topic.traffic,
    headlines: topic.headlines
      .slice(0, HEADLINES_PER_TOPIC)
      .map(({ title, source }) => ({ title: title.slice(0, HEADLINE_MAX), source })),
  };
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

function invalid(reason: string): never {
  throw new Error(`invalid classification: ${reason}`);
}

function entriesOf(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse<unknown>(raw.replace(THINK_BLOCK, ""));
  } catch {
    invalid("not JSON");
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { topics?: unknown } | null)?.topics;
  if (!Array.isArray(list)) invalid('expected a list or {"topics": [...]}');
  return list;
}

function toClassification(entry: unknown, topic: Candidate): Classification {
  const value = entry as Record<string, unknown>;
  if (typeof value.worthy !== "boolean") invalid(`"${topic.name}" has no boolean "worthy"`);
  if (value.query !== undefined && value.query !== null && typeof value.query !== "string") {
    invalid(`"${topic.name}" has a non-string "query"`);
  }
  const category = typeof value.category === "string" ? value.category.trim().toLowerCase() : null;
  const known = category !== null && CATEGORIES.includes(category);
  if (value.worthy && !known) invalid(`"${topic.name}" has an unknown category "${String(value.category)}"`);
  const query = typeof value.query === "string" ? value.query.replace(/\s+/g, " ").trim() : "";
  return {
    key: topic.key,
    name: topic.name,
    worthy: value.worthy,
    query: value.worthy ? (query || topic.name).slice(0, QUERY_MAX) : null,
    category: value.worthy && known ? category : null,
  };
}

/** Validates the model's answer against the topics asked about. Throws on any mismatch. */
export function parseClassifications(raw: string, topics: Candidate[]): Classification[] {
  const byKey = new Map(topics.map((topic) => [topicKey(topic.name), topic]));
  const answered = new Map<string, Classification>();
  for (const entry of entriesOf(raw)) {
    if (!entry || typeof entry !== "object" || typeof (entry as { name?: unknown }).name !== "string") {
      invalid("an entry has no name");
    }
    const key = topicKey((entry as { name: string }).name);
    const topic = byKey.get(key);
    if (!topic) invalid(`unknown topic "${(entry as { name: string }).name}"`);
    if (answered.has(key)) invalid(`"${topic.name}" answered twice`);
    answered.set(key, toClassification(entry, topic));
  }
  const missing = topics.filter((topic) => !answered.has(topicKey(topic.name)));
  if (missing.length > 0) invalid(`missing ${missing.map((t) => `"${t.name}"`).join(", ")}`);
  return topics.map((topic) => answered.get(topicKey(topic.name))!);
}

async function nebiusComplete(system: string, user: string): Promise<string> {
  const completion = await getNebiusClient().chat.completions.create({
    model: NEBIUS_MODEL,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
}

const DEFAULT_DEPS: ClassifyDeps = {
  complete: nebiusComplete,
  warn: (message) => console.warn(message),
};

/** Classifies the batch in one model call; null (logged) when the call or its answer fails. */
export async function classifyTopics(
  topics: Candidate[],
  deps: ClassifyDeps = DEFAULT_DEPS
): Promise<Classification[] | null> {
  if (topics.length === 0) return [];
  let raw: string;
  try {
    raw = await deps.complete(SYSTEM, JSON.stringify(topics.map(topicPayload)));
  } catch (err) {
    deps.warn(`sync: classification call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  try {
    return parseClassifications(raw, topics);
  } catch (err) {
    deps.warn(`sync: classification rejected (${(err as Error).message}); no topics marked. Answer: ${raw.slice(0, 500)}`);
    return null;
  }
}

const SAVE = `
UNWIND $rows AS row
MATCH (t:Topic {key: row.key})
SET t.story_checked_at = datetime($now), t.story_worthy = row.worthy,
    t.story_query = row.query, t.story_category = row.category
`;

/** Stores the worker's classification on each Topic. story_synced_at is set separately, by markTopicsSynced. */
export async function saveClassifications(
  conn: GraphConnection,
  classifications: Classification[],
  now: Date = new Date()
): Promise<void> {
  if (classifications.length === 0) return;
  const rows = classifications.map(({ key, worthy, query, category }) => ({ key, worthy, query, category }));
  await conn.driver.executeQuery(SAVE, { rows, now: now.toISOString() }, { database: conn.database });
}

const MARK_SYNCED = `
UNWIND $keys AS key
MATCH (t:Topic {key: key})
SET t.story_synced_at = datetime($now)
`;

/** Records that a worthy topic's story action succeeded, so it waits until it trends again. */
export async function markTopicsSynced(
  conn: GraphConnection,
  keys: string[],
  now: Date = new Date()
): Promise<void> {
  if (keys.length === 0) return;
  await conn.driver.executeQuery(MARK_SYNCED, { keys, now: now.toISOString() }, { database: conn.database });
}
