import { generateStoryStream, refreshStoryStream } from "../generateStory";
import { listStoryMetas } from "../stories";
import { classifyTopics, markTopicsSynced, saveClassifications } from "./classify";
import type { SyncSettings } from "./config";
import { drainStoryStream, linkStoryToTopic, type CycleDeps, type StoryOutcome } from "./decide";
import type { GraphConnection } from "./graph";
import { acquireLease } from "./lock";
import { loadCandidates } from "./selection";

/**
 * Wires one sync cycle to the real graph, model and story streams. New
 * stories take the "story:<query>" GenerationLock inside generateStoryStream;
 * a refresh takes "refresh:<slug>" here, so two workers never refresh the
 * same story at once.
 */

/** A refresh is one or two research rounds plus a write; well under this. */
const REFRESH_LEASE_SECONDS = 600;

async function refreshWithLease(conn: GraphConnection, slug: string, signal?: AbortSignal): Promise<StoryOutcome> {
  const lease = await acquireLease(conn, `refresh:${slug}`, REFRESH_LEASE_SECONDS);
  if (!lease) return { slug, created: false, busy: true };
  try {
    return await drainStoryStream(refreshStoryStream(slug, signal), signal);
  } finally {
    await lease.release().catch((err: unknown) => {
      console.warn(`sync: could not release refresh:${slug}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export function createCycleDeps(conn: GraphConnection, settings: SyncSettings, signal?: AbortSignal): CycleDeps {
  return {
    loadCandidates: () => loadCandidates(conn, { trafficFloor: settings.trafficFloor }),
    classify: (topics) => classifyTopics(topics),
    saveClassifications: (list) => saveClassifications(conn, list),
    listMetas: listStoryMetas,
    generate: (query, abort) => drainStoryStream(generateStoryStream(query, abort), abort),
    refresh: (slug, abort) => refreshWithLease(conn, slug, abort),
    linkStory: (slug, key) => linkStoryToTopic(conn, slug, key),
    markSynced: (key) => markTopicsSynced(conn, [key]),
    settings,
    now: () => new Date(),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    signal,
  };
}
