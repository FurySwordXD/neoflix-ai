import type { StoryMeta } from "../stories";
import { findExistingStory } from "../storyMatch";
import type { StoryStreamMessage } from "../storyStream";
import type { Classification } from "./classify";
import type { SyncSettings } from "./config";
import type { GraphConnection } from "./graph";
import type { Candidate } from "./selection";

/**
 * One sync cycle: candidates → classification → for each worthy topic,
 * refresh its matching story, create one, or just link it, within the
 * per-cycle caps. Every step is injected so the cycle runs on fakes in tests;
 * worker.ts wires the real graph, model and story streams.
 */

export type Decision =
  | { kind: "generate"; query: string }
  | { kind: "refresh"; slug: string; ageHours: number | null }
  /** `capped`: only linked because MAX_REFRESHES_PER_CYCLE was reached. */
  | { kind: "link"; slug: string; reason: string; capped?: boolean }
  | { kind: "skip"; reason: string };

export interface CycleBudget {
  newStories: number;
  refreshes: number;
  refreshedSlugs: ReadonlySet<string>;
}

export const EMPTY_BUDGET: CycleBudget = { newStories: 0, refreshes: 0, refreshedSlugs: new Set() };

export interface StoryOutcome {
  slug: string;
  created: boolean;
  added?: number;
  /** Another process was already refreshing this story, so nothing ran. */
  busy?: boolean;
}

export interface CycleDeps {
  loadCandidates: () => Promise<Candidate[]>;
  classify: (topics: Candidate[]) => Promise<Classification[] | null>;
  saveClassifications: (classifications: Classification[]) => Promise<void>;
  listMetas: () => Promise<StoryMeta[]>;
  generate: (query: string, signal?: AbortSignal) => Promise<StoryOutcome>;
  refresh: (slug: string, signal?: AbortSignal) => Promise<StoryOutcome>;
  linkStory: (slug: string, topicKey: string) => Promise<void>;
  /** Sets story_synced_at once a topic's action succeeded; until then it is retried each cycle. */
  markSynced: (topicKey: string) => Promise<void>;
  settings: SyncSettings;
  now: () => Date;
  log: (line: string) => void;
  warn: (line: string) => void;
  signal?: AbortSignal;
}

export interface CycleSummary {
  candidates: number;
  classified: number;
  worthy: number;
  created: number;
  refreshed: number;
  linked: number;
  skipped: number;
  failed: number;
}

type Tally = "created" | "refreshed" | "linked" | "skipped" | "failed";

const HOUR_MS = 3_600_000;

/** Hours since the story was last refreshed (or created); null when it carries neither. */
export function storyAgeHours(meta: StoryMeta, now: Date): number | null {
  const stamp = Date.parse(meta.refreshedAt ?? meta.createdAt ?? "");
  return Number.isFinite(stamp) ? (now.getTime() - stamp) / HOUR_MS : null;
}

export function decideTopic(
  query: string,
  metas: StoryMeta[],
  budget: CycleBudget,
  settings: SyncSettings,
  now: Date
): Decision {
  const existing = findExistingStory(query, metas);
  if (!existing) {
    if (budget.newStories >= settings.maxNewStories) return { kind: "skip", reason: "new-story cap reached" };
    return { kind: "generate", query };
  }
  const { slug } = existing;
  if (budget.refreshedSlugs.has(slug)) return { kind: "link", slug, reason: "refreshed earlier this cycle" };
  const ageHours = storyAgeHours(existing, now);
  if (ageHours !== null && ageHours < settings.refreshMinHours) {
    return { kind: "link", slug, reason: `fresh (${ageHours.toFixed(1)}h old)` };
  }
  if (budget.refreshes >= settings.maxRefreshes) {
    return { kind: "link", slug, reason: "refresh cap reached", capped: true };
  }
  return { kind: "refresh", slug, ageHours };
}

/** Runs a story stream to its end: the saved story it lands on, or the stream's error. */
export async function drainStoryStream(
  stream: AsyncIterable<StoryStreamMessage>,
  signal?: AbortSignal
): Promise<StoryOutcome> {
  for await (const message of stream) {
    if (message.type === "error") throw new Error(message.error);
    if (message.type === "cached") return { slug: message.story.slug, created: false };
    if (message.type === "done") {
      return {
        slug: message.story.slug,
        created: message.created,
        ...(message.added === undefined ? {} : { added: message.added }),
      };
    }
  }
  // An aborted stream just stops; say so rather than blame the stream.
  if (signal?.aborted) throw new Error("aborted before the story was saved");
  throw new Error("the story stream ended without a story");
}

const LINK = `
MATCH (s:Story {slug: $slug}) WHERE s.createdAt IS NOT NULL
MATCH (t:Topic {key: $key})
MERGE (s)-[:ABOUT]->(t)
RETURN s.slug AS slug
`;

/** MERGE (Story)-[:ABOUT]->(Topic). Throws if either node is missing, instead of creating stubs. */
export async function linkStoryToTopic(conn: GraphConnection, slug: string, key: string): Promise<void> {
  const { records } = await conn.driver.executeQuery(LINK, { slug, key }, { database: conn.database });
  if (records.length === 0) throw new Error(`cannot link story "${slug}" to topic "${key}": one of them is missing`);
}

function asClassification(candidate: Candidate): Classification | null {
  if (!candidate.cached) return null;
  return { key: candidate.key, name: candidate.name, ...candidate.cached };
}

/** Cached results plus fresh ones, in candidate (traffic) order. */
async function classifyCandidates(
  candidates: Candidate[],
  deps: CycleDeps
): Promise<{ all: Classification[]; classified: number }> {
  const fresh = (await deps.classify(candidates.filter((c) => !c.cached))) ?? [];
  const byKey = new Map(fresh.map((c) => [c.key, c]));
  const all = candidates
    .map((candidate) => asClassification(candidate) ?? byKey.get(candidate.key) ?? null)
    .filter((c): c is Classification => c !== null);
  if (all.length > 0) await deps.saveClassifications(all);
  return { all, classified: fresh.length };
}

interface ActResult {
  tally: Tally;
  line: string;
  /** The topic is fully handled; false when a cap held its action back, so a later cycle retries it. */
  synced: boolean;
}

async function act(topic: Classification, decision: Decision, deps: CycleDeps): Promise<ActResult> {
  const label = `sync: "${topic.name}" ->`;
  switch (decision.kind) {
    case "skip":
      return { tally: "skipped", line: `${label} skip (${decision.reason})`, synced: false };
    case "link":
      await deps.linkStory(decision.slug, topic.key);
      return {
        tally: "linked",
        line: `${label} link ${decision.slug} (${decision.reason})`,
        synced: !decision.capped,
      };
    case "refresh": {
      const outcome = await deps.refresh(decision.slug, deps.signal);
      await deps.linkStory(outcome.slug, topic.key);
      if (outcome.busy) {
        return { tally: "linked", line: `${label} link ${decision.slug} (refresh already running)`, synced: true };
      }
      const age = decision.ageHours === null ? "unknown age" : `${decision.ageHours.toFixed(1)}h old`;
      return {
        tally: "refreshed",
        line: `${label} refresh ${decision.slug} (${age}, +${outcome.added ?? 0} events)`,
        synced: true,
      };
    }
    case "generate": {
      const outcome = await deps.generate(decision.query, deps.signal);
      await deps.linkStory(outcome.slug, topic.key);
      const result = outcome.created ? "created" : "matched an existing story";
      return {
        tally: outcome.created ? "created" : "linked",
        line: `${label} generate "${decision.query}" (${result}: ${outcome.slug})`,
        synced: true,
      };
    }
  }
}

/** A failed bookkeeping write only means the topic comes back next cycle; it does not undo the action. */
async function markSynced(topic: Classification, deps: CycleDeps): Promise<void> {
  try {
    await deps.markSynced(topic.key);
  } catch (err) {
    deps.warn(`sync: "${topic.name}" done but not marked synced: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function spend(budget: CycleBudget, decision: Decision): CycleBudget {
  if (decision.kind === "generate") return { ...budget, newStories: budget.newStories + 1 };
  if (decision.kind !== "refresh") return budget;
  return {
    ...budget,
    refreshes: budget.refreshes + 1,
    refreshedSlugs: new Set([...budget.refreshedSlugs, decision.slug]),
  };
}

function formatSummary(summary: CycleSummary): string {
  const parts = Object.entries(summary).map(([name, value]) => `${name}=${value}`);
  return `sync: cycle done ${parts.join(" ")}`;
}

export async function runCycle(deps: CycleDeps): Promise<CycleSummary> {
  const candidates = await deps.loadCandidates();
  let summary: CycleSummary = {
    candidates: candidates.length,
    classified: 0,
    worthy: 0,
    created: 0,
    refreshed: 0,
    linked: 0,
    skipped: 0,
    failed: 0,
  };
  if (candidates.length === 0) {
    deps.log(formatSummary(summary));
    return summary;
  }

  const { all, classified } = await classifyCandidates(candidates, deps);
  for (const topic of all.filter((c) => !c.worthy)) deps.log(`sync: "${topic.name}" -> not story-worthy`);
  const worthy = all.filter((c) => c.worthy && c.query);
  summary = { ...summary, classified, worthy: worthy.length };

  let metas = worthy.length > 0 ? await deps.listMetas() : [];
  let budget = EMPTY_BUDGET;
  for (const topic of worthy) {
    if (deps.signal?.aborted) break;
    const decision = decideTopic(topic.query!, metas, budget, deps.settings, deps.now());
    budget = spend(budget, decision);
    try {
      const { tally, line, synced } = await act(topic, decision, deps);
      deps.log(line);
      summary = { ...summary, [tally]: summary[tally] + 1 };
      if (synced) await markSynced(topic, deps);
      // A new story can match a later topic in the same cycle.
      if (decision.kind === "generate") metas = await deps.listMetas();
    } catch (err) {
      deps.warn(`sync: "${topic.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      summary = { ...summary, failed: summary.failed + 1 };
    }
  }
  deps.log(formatSummary(summary));
  return summary;
}
