import { describe, expect, it, vi } from "vitest";
import type { StoryStreamMessage } from "@/lib/storyStream";
import type { Lease } from "@/lib/trendSync/lock";
import { enterStoryLease, type StoryLeaseDeps, type StoryLeaseGate } from "@/lib/trendSync/storyLease";
import type { Story } from "@/lib/types";
import { makeStory } from "../storyStore/fixtures";

const CONNECTION = { driver: {} as never };

function lease(release = vi.fn(async () => undefined)): Lease {
  return { key: "story:typhoon koinu", holder: "me", release };
}

/** Runs the gate to completion, collecting what it yielded. */
async function runGate(
  deps: Partial<StoryLeaseDeps>,
  signal?: AbortSignal
): Promise<{ messages: StoryStreamMessage[]; gate: StoryLeaseGate }> {
  const messages: StoryStreamMessage[] = [];
  const gen = enterStoryLease("Typhoon  Koinu", signal, deps);
  for (;;) {
    const next = await gen.next();
    if (next.done) return { messages, gate: next.value };
    messages.push(next.value);
  }
}

function baseDeps(overrides: Partial<StoryLeaseDeps>): Partial<StoryLeaseDeps> {
  let clock = 0;
  return {
    connection: CONNECTION,
    findStory: vi.fn(async () => null),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    pollMs: 3000,
    waitMs: 9000,
    warn: vi.fn(),
    ...overrides,
  };
}

describe("enterStoryLease", () => {
  it("does nothing in file mode", async () => {
    const acquire = vi.fn();
    const { messages, gate } = await runGate({ connection: null, acquire });
    expect(messages).toEqual([]);
    expect(gate.story).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
    await gate.release();
  });

  it("holds the lease under the normalized query key and releases it once", async () => {
    const held = lease();
    const acquire = vi.fn(async () => held);
    const { gate } = await runGate(baseDeps({ acquire }));
    expect(acquire).toHaveBeenCalledWith(CONNECTION, "story:typhoon koinu", expect.any(Number));
    expect(gate.story).toBeNull();
    await gate.release();
    await gate.release();
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("re-checks for a story right after taking the lease, and lets it go if one appeared", async () => {
    const held = lease();
    const story = makeStory("typhoon-koinu");
    const { gate } = await runGate(baseDeps({ acquire: async () => held, findStory: async () => story }));
    expect(gate.story).toBe(story);
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("waits for another holder's story and returns it", async () => {
    const story = makeStory("typhoon-koinu");
    const found: Array<Story | null> = [null, null, story];
    const findStory = vi.fn(async () => found.shift() ?? null);
    const { messages, gate } = await runGate(baseDeps({ acquire: async () => null, findStory }));
    expect(messages).toEqual([{ type: "step", step: expect.stringMatching(/already writing this story/) }]);
    expect(gate.story).toBe(story);
  });

  it("takes the lease once the other holder gives up without a story", async () => {
    const held = lease();
    const results: Array<Lease | null> = [null, held];
    const { gate } = await runGate(baseDeps({ acquire: async () => results.shift() ?? null }));
    expect(gate.story).toBeNull();
    await gate.release();
    expect(held.release).toHaveBeenCalled();
  });

  it("proceeds without the lease when the story never appears", async () => {
    const deps = baseDeps({ acquire: async () => null });
    const { gate } = await runGate(deps);
    expect(gate.story).toBeNull();
    expect(deps.sleep).toHaveBeenCalledTimes(3);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/gave up waiting/));
    await gate.release();
  });

  it("proceeds without the lease when the graph lock fails", async () => {
    const deps = baseDeps({
      acquire: async () => {
        throw new Error("bolt down");
      },
    });
    const { gate } = await runGate(deps);
    expect(gate.story).toBeNull();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/bolt down/));
  });

  it("warns instead of throwing when releasing fails", async () => {
    const held = lease(vi.fn(async () => Promise.reject(new Error("gone"))));
    const deps = baseDeps({ acquire: async () => held });
    const { gate } = await runGate(deps);
    await expect(gate.release()).resolves.toBeUndefined();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/gone/));
  });

  it("stops waiting once aborted", async () => {
    const controller = new AbortController();
    const deps = baseDeps({
      acquire: async () => null,
      sleep: vi.fn(async () => controller.abort()),
    });
    const { gate } = await runGate(deps, controller.signal);
    expect(gate.story).toBeNull();
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("releases the lease and rethrows when the re-check after acquiring fails", async () => {
    const held = lease();
    const findStory = vi.fn(async () => {
      throw new Error("graph read failed");
    });
    await expect(runGate(baseDeps({ acquire: async () => held, findStory }))).rejects.toThrow("graph read failed");
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when aborted right after acquiring it", async () => {
    const controller = new AbortController();
    const held = lease();
    const findStory = vi.fn(async () => {
      controller.abort();
      return null;
    });
    const { gate } = await runGate(baseDeps({ acquire: async () => held, findStory }), controller.signal);
    expect(gate.story).toBeNull();
    expect(held.release).toHaveBeenCalledTimes(1);
  });
});
