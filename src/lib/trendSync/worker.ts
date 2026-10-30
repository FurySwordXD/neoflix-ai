import { findExistingStory } from "../storyMatch";
import { listStoryMetas } from "../stories";
import { classifyTopics, markTopicsSynced, saveClassifications } from "./classify";
import type { SyncSettings } from "./config";
import type { CycleDeps } from "./decide";
import type { GraphConnection } from "./graph";
import { linkStoryToTopic } from "./graph";
import { loadCandidates } from "./selection";

/**
 * Wires one lazy sync cycle to the real graph and model. The worker only
 * stocks and classifies trending topics and links stories that already
 * exist; the agentic research runs when a reader opens a story.
 */

export function createCycleDeps(conn: GraphConnection, settings: SyncSettings, signal?: AbortSignal): CycleDeps {
  return {
    loadCandidates: () => loadCandidates(conn, { trafficFloor: settings.trafficFloor }),
    classify: (topics) => classifyTopics(topics),
    saveClassifications: (list) => saveClassifications(conn, list),
    findStory: async (query) => {
      const meta = findExistingStory(query, await listStoryMetas());
      return meta ?? null;
    },
    linkStory: (slug, key) => linkStoryToTopic(conn, slug, key),
    markSynced: (key) => markTopicsSynced(conn, [key]),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    signal,
  };
}
