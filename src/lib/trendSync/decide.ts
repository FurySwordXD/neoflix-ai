import type { StoryMeta } from "../stories";
import { findExistingStory } from "../storyMatch";
import type { Classification } from "./classify";
import type { Candidate } from "./selection";

/**
 * One lazy sync cycle: candidates → classification → link the stories that
 * already exist. The worker never researches: a worthy topic without a story
 * is stocked on the dashboard, and its story is compiled by the agentic
 * pipeline when a reader opens it. Every step is injected so the cycle runs
 * on fakes in tests; worker.ts wires the real graph and model.
 */

export interface CycleDeps {
  loadCandidates: () => Promise<Candidate[]>;
  classify: (topics: Candidate[]) => Promise<Classification[] | null>;
  saveClassifications: (classifications: Classification[]) => Promise<void>;
  /** The saved story this topic's query already refers to, if any. */
  findStory: (query: string) => Promise<StoryMeta | null>;
  linkStory: (slug: string, topicKey: string) => Promise<void>;
  /** Sets story_synced_at once a topic was classified and handled; until then it is retried each cycle. */
  markSynced: (topicKey: string) => Promise<void>;
  log: (line: string) => void;
  warn: (line: string) => void;
  signal?: AbortSignal;
}

export interface CycleSummary {
  candidates: number;
  classified: number;
  worthy: number;
  linked: number;
  /** Worthy topics stocked without a story; a reader opening one triggers the research. */
  stocked: number;
  failed: number;
}

/** Cached results plus fresh ones, in candidate (traffic) order. */
async function classifyCandidates(
  candidates: Candidate[],
  deps: CycleDeps
): Promise<{ all: Classification[]; classified: number }> {
  const fresh = (await deps.classify(candidates.filter((c) => !c.cached))) ?? [];
  const byKey = new Map(fresh.map((c) => [c.key, c]));
  const all = candidates
    .map((candidate) => (candidate.cached ? { key: candidate.key, name: candidate.name, ...candidate.cached } : byKey.get(candidate.key) ?? null))
    .filter((c): c is Classification => c !== null);
  if (all.length > 0) await deps.saveClassifications(all);
  return { all, classified: fresh.length };
}

/** A failed bookkeeping write only means the topic comes back next cycle; it does not undo the action. */
async function markSynced(topic: Classification, deps: CycleDeps): Promise<void> {
  try {
    await deps.markSynced(topic.key);
  } catch (err) {
    deps.warn(`sync: "${topic.name}" done but not marked synced: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    linked: 0,
    stocked: 0,
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

  for (const topic of worthy) {
    if (deps.signal?.aborted) break;
    try {
      const existing = await deps.findStory(topic.query!);
      if (existing) {
        await deps.linkStory(existing.slug, topic.key);
        deps.log(`sync: "${topic.name}" -> link ${existing.slug}`);
        summary = { ...summary, linked: summary.linked + 1 };
      } else {
        deps.log(`sync: "${topic.name}" -> stocked as "${topic.query}" (researched when a reader opens it)`);
        summary = { ...summary, stocked: summary.stocked + 1 };
      }
      await markSynced(topic, deps);
    } catch (err) {
      deps.warn(`sync: "${topic.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      summary = { ...summary, failed: summary.failed + 1 };
    }
  }
  deps.log(formatSummary(summary));
  return summary;
}
