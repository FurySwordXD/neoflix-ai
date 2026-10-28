import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryStreamMessage } from "@/lib/storyStream";
import { makeStory } from "../storyStore/fixtures";

/** How generateStoryStream uses the GenerationLock gate; the gate itself is tested in storyLease.test.ts. */

const gate = vi.hoisted(() => ({
  story: null as unknown,
  release: vi.fn(async () => undefined),
  enter: vi.fn(),
}));

vi.mock("@/lib/trendSync/storyLease", () => ({
  enterStoryLease: gate.enter,
}));

vi.mock("@/lib/nebius", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nebius")>()),
  getNebiusClient: () => {
    throw new Error("no model in tests");
  },
}));

const { generateStoryStream } = await import("@/lib/generateStory");
const { setStoryStore, resetStoryStore } = await import("@/lib/stories");

const store = {
  listStoryMetas: vi.fn(async () => []),
  listStories: vi.fn(async () => []),
  getStory: vi.fn(async () => null),
  saveNewStory: vi.fn(),
  appendStoryEvents: vi.fn(),
  saveGeneratedEvent: vi.fn(),
  rememberQuery: vi.fn(async () => undefined),
};

async function collect(stream: AsyncGenerator<StoryStreamMessage>): Promise<StoryStreamMessage[]> {
  const out: StoryStreamMessage[] = [];
  try {
    for await (const message of stream) out.push(message);
  } catch (err) {
    out.push({ type: "error", error: (err as Error).message });
  }
  return out;
}

beforeEach(() => {
  setStoryStore(store as never);
  gate.release.mockClear();
  gate.enter.mockImplementation(async function* (): AsyncGenerator<StoryStreamMessage, unknown> {
    yield { type: "step", step: "waiting" };
    return { story: gate.story, release: gate.release };
  });
});

afterEach(() => {
  resetStoryStore();
  gate.story = null;
});

describe("generateStoryStream with the generation lease", () => {
  it("opens the story another holder saved instead of generating", async () => {
    const story = makeStory("typhoon-koinu");
    gate.story = story;
    const messages = await collect(generateStoryStream("  Typhoon Koinu "));
    expect(gate.enter).toHaveBeenCalledWith("Typhoon Koinu", undefined);
    expect(messages).toEqual([{ type: "step", step: "waiting" }, { type: "cached", story }]);
    expect(store.rememberQuery).toHaveBeenCalledWith("typhoon-koinu", "Typhoon Koinu");
  });

  it("releases the lease even when generation fails", async () => {
    const messages = await collect(generateStoryStream("Typhoon Koinu"));
    expect(messages.at(-1)).toEqual({ type: "error", error: "no model in tests" });
    expect(gate.release).toHaveBeenCalledTimes(1);
  });

  it("skips the lease for a story that is already saved", async () => {
    const story = makeStory("typhoon-koinu", { title: "Typhoon Koinu" });
    const { events: _events, ...meta } = story;
    store.listStoryMetas.mockResolvedValueOnce([meta] as never);
    store.getStory.mockResolvedValueOnce(story as never);
    const messages = await collect(generateStoryStream("Typhoon Koinu"));
    expect(messages).toEqual([{ type: "cached", story }]);
    expect(gate.enter).not.toHaveBeenCalled();
  });

  it("releases the lease when aborted after taking it, without generating", async () => {
    const controller = new AbortController();
    gate.enter.mockImplementationOnce(async function* (): AsyncGenerator<StoryStreamMessage, unknown> {
      controller.abort();
      return { story: null, release: gate.release };
    });
    const messages = await collect(generateStoryStream("Typhoon Koinu", controller.signal));
    expect(messages).toEqual([]);
    expect(gate.release).toHaveBeenCalledTimes(1);
  });
});
