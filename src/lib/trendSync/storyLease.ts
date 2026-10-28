import { getStory, listStoryMetas } from "../stories";
import { findExistingStory } from "../storyMatch";
import type { StoryStreamMessage } from "../storyStream";
import type { Story } from "../types";
import { graphConnectionFromEnv, type GraphConnection } from "./graph";
import { acquireLease, storyLockKey, type Lease } from "./lock";

/**
 * The GenerationLock gate in front of a new story. With STORY_STORE=neo4j the
 * first requester takes the "story:<query>" lease and generates; anyone else
 * asking for the same story meanwhile polls for it and opens the saved copy.
 * If it never appears (the holder failed or is slow), they generate anyway.
 * In file mode the gate is a no-op.
 */

export interface StoryLeaseDeps {
  connection: GraphConnection | null;
  acquire: (conn: GraphConnection, key: string, ttlSeconds: number) => Promise<Lease | null>;
  findStory: (query: string) => Promise<Story | null>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  ttlSeconds: number;
  pollMs: number;
  waitMs: number;
  warn: (line: string) => void;
}

export interface StoryLeaseGate {
  /** The story another holder saved while we waited; generate only when null. */
  story: Story | null;
  /** Frees our lease, if we hold one. Safe to call more than once; never throws. */
  release: () => Promise<void>;
}

/** Long enough for a full multi-round generation, short enough to recover from a crash. */
const LEASE_TTL_SECONDS = 600;
const POLL_MS = 3_000;
const WAIT_MS = 180_000;

async function findSavedStory(query: string): Promise<Story | null> {
  const meta = findExistingStory(query, await listStoryMetas());
  return meta ? getStory(meta.slug) : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function defaultDeps(overrides: Partial<StoryLeaseDeps>): StoryLeaseDeps {
  return {
    // Only read the env when no connection (or explicit null) was injected.
    connection: "connection" in overrides ? (overrides.connection ?? null) : graphConnectionFromEnv(),
    acquire: acquireLease,
    findStory: findSavedStory,
    sleep,
    now: Date.now,
    ttlSeconds: LEASE_TTL_SECONDS,
    pollMs: POLL_MS,
    waitMs: WAIT_MS,
    warn: (line) => console.warn(line),
    ...overrides,
  };
}

const NO_LEASE: StoryLeaseGate = { story: null, release: async () => undefined };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function heldGate(lease: Lease, warn: (line: string) => void): StoryLeaseGate {
  let released = false;
  return {
    story: null,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await lease.release();
      } catch (err) {
        warn(`[storyLease] could not release ${lease.key}: ${message(err)}`);
      }
    },
  };
}

/**
 * Re-checks for a saved story under a freshly taken lease. The lease is
 * released on every path that does not hand it to the caller: a story that
 * appeared meanwhile, an abort, or an error (which is rethrown).
 */
async function checkHeldLease(
  query: string,
  gate: StoryLeaseGate,
  signal: AbortSignal | undefined,
  deps: StoryLeaseDeps
): Promise<StoryLeaseGate> {
  let handedOver = false;
  try {
    // The previous holder may have saved it between our first check and now.
    const story = await deps.findStory(query);
    if (story) return { story, release: NO_LEASE.release };
    if (signal?.aborted) return NO_LEASE;
    handedOver = true;
    return gate;
  } finally {
    if (!handedOver) await gate.release();
  }
}

/**
 * Yields a step message while it waits on another holder, then returns the
 * gate. The caller generates only when `gate.story` is null, and must call
 * `gate.release()` when done.
 */
export async function* enterStoryLease(
  query: string,
  signal?: AbortSignal,
  overrides: Partial<StoryLeaseDeps> = {}
): AsyncGenerator<StoryStreamMessage, StoryLeaseGate> {
  const deps = defaultDeps(overrides);
  const { connection } = deps;
  if (!connection) return NO_LEASE;

  const key = storyLockKey(query);
  const deadline = deps.now() + deps.waitMs;
  let announced = false;
  for (;;) {
    let lease: Lease | null;
    try {
      lease = await deps.acquire(connection, key, deps.ttlSeconds);
    } catch (err) {
      deps.warn(`[storyLease] lease ${key} unavailable, generating without it: ${message(err)}`);
      return NO_LEASE;
    }
    if (lease) return await checkHeldLease(query, heldGate(lease, deps.warn), signal, deps);
    if (!announced) {
      announced = true;
      yield { type: "step", step: "Another reader is already writing this story — waiting for it" };
    }
    if (signal?.aborted) return NO_LEASE;
    if (deps.now() >= deadline) {
      deps.warn(`[storyLease] gave up waiting for ${key}; generating it here`);
      return NO_LEASE;
    }
    await deps.sleep(deps.pollMs, signal);
    if (signal?.aborted) return NO_LEASE;
    const story = await deps.findStory(query);
    if (story) return { story, release: NO_LEASE.release };
  }
}
