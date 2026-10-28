import { describe, expect, it, vi } from "vitest";
import type { StoryMeta } from "@/lib/stories";
import type { StoryStreamMessage } from "@/lib/storyStream";
import type { Classification } from "@/lib/trendSync/classify";
import type { SyncSettings } from "@/lib/trendSync/config";
import {
  EMPTY_BUDGET,
  decideTopic,
  drainStoryStream,
  runCycle,
  storyAgeHours,
  type CycleDeps,
  type StoryOutcome,
} from "@/lib/trendSync/decide";
import type { Candidate } from "@/lib/trendSync/selection";
import { makeStory } from "../storyStore/fixtures";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const HOUR_MS = 3_600_000;

const SETTINGS: SyncSettings = {
  trafficFloor: 1000,
  refreshMinHours: 6,
  maxNewStories: 3,
  maxRefreshes: 5,
  intervalMinutes: 30,
};

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

function meta(slug: string, title: string, refreshedHoursAgo: number | null, createdHoursAgo = 100): StoryMeta {
  const { events: _events, ...rest } = makeStory(slug);
  return {
    ...rest,
    title,
    queries: [title],
    createdAt: hoursAgo(createdHoursAgo),
    ...(refreshedHoursAgo === null ? {} : { refreshedAt: hoursAgo(refreshedHoursAgo) }),
  };
}

function candidate(name: string, cached: Candidate["cached"] = null): Candidate {
  return { key: name.toLowerCase(), name, traffic: 5000, latestAt: NOW.toISOString(), cached, headlines: [] };
}

function worthy(name: string, query = name): Classification {
  return { key: name.toLowerCase(), name, worthy: true, query, category: "politics" };
}

function unworthy(name: string): Classification {
  return { key: name.toLowerCase(), name, worthy: false, query: null, category: null };
}

describe("storyAgeHours", () => {
  it("prefers refreshedAt, then createdAt", () => {
    expect(storyAgeHours(meta("a", "A", 2), NOW)).toBeCloseTo(2);
    expect(storyAgeHours(meta("a", "A", null, 9), NOW)).toBeCloseTo(9);
  });

  it("is null when the story has no usable timestamp", () => {
    const { createdAt: _c, refreshedAt: _r, ...bare } = meta("a", "A", 1);
    expect(storyAgeHours(bare, NOW)).toBeNull();
    expect(storyAgeHours({ ...bare, refreshedAt: "not a date" }, NOW)).toBeNull();
  });
});

describe("decideTopic", () => {
  const metas = [meta("brexit-deal", "Brexit deal", 10), meta("mars-landing", "Mars landing", 1)];

  it("refreshes a matching story older than REFRESH_MIN_HOURS", () => {
    expect(decideTopic("Brexit deal", metas, EMPTY_BUDGET, SETTINGS, NOW)).toEqual({
      kind: "refresh",
      slug: "brexit-deal",
      ageHours: 10,
    });
  });

  it("only links a matching story refreshed recently", () => {
    expect(decideTopic("Mars landing", metas, EMPTY_BUDGET, SETTINGS, NOW)).toMatchObject({
      kind: "link",
      slug: "mars-landing",
      reason: expect.stringMatching(/fresh/),
    });
  });

  it("refreshes a story with no timestamps", () => {
    const { createdAt: _c, refreshedAt: _r, ...bare } = meta("old", "Old story", 1);
    expect(decideTopic("Old story", [bare], EMPTY_BUDGET, SETTINGS, NOW)).toMatchObject({ kind: "refresh" });
  });

  it("generates when nothing matches", () => {
    expect(decideTopic("Typhoon Koinu", metas, EMPTY_BUDGET, SETTINGS, NOW)).toEqual({
      kind: "generate",
      query: "Typhoon Koinu",
    });
  });

  it("skips new stories once the cap is reached", () => {
    const budget = { ...EMPTY_BUDGET, newStories: 3 };
    expect(decideTopic("Typhoon Koinu", metas, budget, SETTINGS, NOW)).toMatchObject({
      kind: "skip",
      reason: expect.stringMatching(/new-story cap/),
    });
  });

  it("links without refreshing once the refresh cap is reached", () => {
    const budget = { ...EMPTY_BUDGET, refreshes: 5 };
    expect(decideTopic("Brexit deal", metas, budget, SETTINGS, NOW)).toMatchObject({
      kind: "link",
      slug: "brexit-deal",
      reason: expect.stringMatching(/refresh cap/),
    });
  });

  it("does not refresh one story twice in a cycle", () => {
    const budget = { ...EMPTY_BUDGET, refreshedSlugs: new Set(["brexit-deal"]) };
    expect(decideTopic("Brexit deal", metas, budget, SETTINGS, NOW)).toMatchObject({
      kind: "link",
      reason: expect.stringMatching(/earlier this cycle/),
    });
  });
});

function streamOf(messages: StoryStreamMessage[]): AsyncGenerator<StoryStreamMessage> {
  return (async function* () {
    yield* messages;
  })();
}

describe("drainStoryStream", () => {
  const story = makeStory("alpha");

  it("returns the saved story from done", async () => {
    const outcome = await drainStoryStream(
      streamOf([{ type: "step", step: "x" }, { type: "done", story, created: true }])
    );
    expect(outcome).toEqual({ slug: "alpha", created: true });
  });

  it("carries the number of refreshed events", async () => {
    const outcome = await drainStoryStream(streamOf([{ type: "done", story, created: false, added: 2 }]));
    expect(outcome).toEqual({ slug: "alpha", created: false, added: 2 });
  });

  it("treats a cached story as not created", async () => {
    expect(await drainStoryStream(streamOf([{ type: "cached", story }]))).toEqual({ slug: "alpha", created: false });
  });

  it("throws the stream's error", async () => {
    await expect(drainStoryStream(streamOf([{ type: "error", error: "model refused" }]))).rejects.toThrow(
      "model refused"
    );
  });

  it("throws when the stream ends without a story", async () => {
    await expect(drainStoryStream(streamOf([{ type: "step", step: "x" }]))).rejects.toThrow(/without a story/);
  });

  it("reports an aborted run as aborted, not as a stream that ended without a story", async () => {
    const controller = new AbortController();
    controller.abort();
    const drained = drainStoryStream(streamOf([{ type: "step", step: "x" }]), controller.signal);
    await expect(drained).rejects.toThrow(/aborted/);
  });
});

interface FakeOptions {
  candidates?: Candidate[];
  classifications?: Classification[] | null;
  metas?: StoryMeta[];
  generate?: (query: string) => Promise<StoryOutcome>;
  refresh?: (slug: string) => Promise<StoryOutcome>;
  settings?: Partial<SyncSettings>;
  signal?: AbortSignal;
}

function fakeDeps(opts: FakeOptions = {}) {
  const deps = {
    loadCandidates: vi.fn(async () => opts.candidates ?? []),
    classify: vi.fn(async () => (opts.classifications === undefined ? [] : opts.classifications)),
    saveClassifications: vi.fn(async (_list: Classification[]) => undefined),
    listMetas: vi.fn(async () => opts.metas ?? []),
    generate: vi.fn(opts.generate ?? (async (query: string) => ({ slug: query.toLowerCase().replace(/\s+/g, "-"), created: true }))),
    refresh: vi.fn(opts.refresh ?? (async (slug: string) => ({ slug, created: false, added: 1 }))),
    linkStory: vi.fn(async (_slug: string, _key: string) => undefined),
    markSynced: vi.fn(async (_key: string) => undefined),
    settings: { ...SETTINGS, ...opts.settings },
    now: () => NOW,
    log: vi.fn(),
    warn: vi.fn(),
    signal: opts.signal,
  } satisfies CycleDeps;
  return deps;
}

describe("runCycle", () => {
  it("logs and stops when there are no candidates", async () => {
    const deps = fakeDeps();
    const summary = await runCycle(deps);
    expect(summary.candidates).toBe(0);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/sync: cycle done candidates=0/));
  });

  it("classifies only uncached topics and stores every result", async () => {
    const cached = candidate("Brexit deal", { worthy: true, query: "Brexit deal", category: "politics" });
    const deps = fakeDeps({
      candidates: [cached, candidate("Lakers score")],
      classifications: [unworthy("Lakers score")],
      metas: [meta("brexit-deal", "Brexit deal", 1)],
    });
    const summary = await runCycle(deps);
    expect(deps.classify).toHaveBeenCalledWith([candidate("Lakers score")]);
    const saved = deps.saveClassifications.mock.calls[0][0];
    expect(saved.map((c) => [c.key, c.worthy])).toEqual([
      ["brexit deal", true],
      ["lakers score", false],
    ]);
    expect(summary).toMatchObject({ candidates: 2, classified: 1, worthy: 1, linked: 1 });
    expect(deps.linkStory).toHaveBeenCalledWith("brexit-deal", "brexit deal");
  });

  it("marks nothing when classification fails, but still handles cached topics", async () => {
    const cached = candidate("Brexit deal", { worthy: true, query: "Brexit deal", category: "politics" });
    const deps = fakeDeps({
      candidates: [cached, candidate("Lakers score")],
      classifications: null,
      metas: [meta("brexit-deal", "Brexit deal", 12)],
    });
    const summary = await runCycle(deps);
    const saved = deps.saveClassifications.mock.calls[0][0];
    expect(saved.map((c) => c.key)).toEqual(["brexit deal"]);
    expect(summary).toMatchObject({ classified: 0, refreshed: 1 });
  });

  it("does not save anything when nothing was classified or cached", async () => {
    const deps = fakeDeps({ candidates: [candidate("Lakers score")], classifications: null });
    await runCycle(deps);
    expect(deps.saveClassifications).not.toHaveBeenCalled();
  });

  it("creates, refreshes and links, then logs one line per topic and a summary", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Brexit deal"), candidate("Typhoon Koinu"), candidate("Lakers score")],
      classifications: [worthy("Brexit deal"), worthy("Typhoon Koinu", "Typhoon Koinu landfall"), unworthy("Lakers score")],
      metas: [meta("brexit-deal", "Brexit deal", 12)],
    });
    const summary = await runCycle(deps);
    expect(deps.refresh).toHaveBeenCalledWith("brexit-deal", undefined);
    expect(deps.generate).toHaveBeenCalledWith("Typhoon Koinu landfall", undefined);
    expect(deps.linkStory.mock.calls).toEqual([
      ["brexit-deal", "brexit deal"],
      ["typhoon-koinu-landfall", "typhoon koinu"],
    ]);
    expect(summary).toEqual({
      candidates: 3,
      classified: 3,
      worthy: 2,
      created: 1,
      refreshed: 1,
      linked: 0,
      skipped: 0,
      failed: 0,
    });
    const lines = deps.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"Brexit deal" -> refresh brexit-deal/),
        expect.stringMatching(/"Typhoon Koinu" -> generate/),
        expect.stringMatching(/"Lakers score" -> not story-worthy/),
        expect.stringMatching(/sync: cycle done .*created=1 refreshed=1/),
      ])
    );
  });

  it("respects MAX_NEW_STORIES_PER_CYCLE", async () => {
    const names = ["One topic", "Two topic", "Three topic"];
    const deps = fakeDeps({
      candidates: names.map((n) => candidate(n)),
      classifications: names.map((n) => worthy(n)),
      settings: { maxNewStories: 2 },
    });
    const summary = await runCycle(deps);
    expect(deps.generate).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ created: 2, skipped: 1 });
  });

  it("respects MAX_REFRESHES_PER_CYCLE", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Brexit deal"), candidate("Mars landing")],
      classifications: [worthy("Brexit deal"), worthy("Mars landing")],
      metas: [meta("brexit-deal", "Brexit deal", 12), meta("mars-landing", "Mars landing", 12)],
      settings: { maxRefreshes: 1 },
    });
    const summary = await runCycle(deps);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ refreshed: 1, linked: 1 });
    expect(deps.linkStory).toHaveBeenCalledTimes(2);
  });

  it("links without counting a refresh another process was already running", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Brexit deal")],
      classifications: [worthy("Brexit deal")],
      metas: [meta("brexit-deal", "Brexit deal", 12)],
      refresh: async (slug) => ({ slug, created: false, busy: true }),
    });
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ refreshed: 0, linked: 1 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/refresh already running/));
  });

  it("counts a generate that landed on an existing story as linked", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Typhoon Koinu")],
      classifications: [worthy("Typhoon Koinu")],
      generate: async () => ({ slug: "koinu", created: false }),
    });
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ created: 0, linked: 1 });
    expect(deps.linkStory).toHaveBeenCalledWith("koinu", "typhoon koinu");
  });

  it("keeps going when one topic fails", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Bad topic"), candidate("Good topic")],
      classifications: [worthy("Bad topic"), worthy("Good topic")],
      generate: async (query) => {
        if (query === "Bad topic") throw new Error("Nebius down");
        return { slug: "good-topic", created: true };
      },
    });
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ created: 1, failed: 1 });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/"Bad topic" failed: Nebius down/));
    expect(deps.linkStory).toHaveBeenCalledWith("good-topic", "good topic");
  });

  it("counts a topic whose story link fails as failed", async () => {
    const deps = fakeDeps({ candidates: [candidate("Typhoon Koinu")], classifications: [worthy("Typhoon Koinu")] });
    deps.linkStory.mockRejectedValueOnce(new Error("graph down"));
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ created: 0, failed: 1 });
  });

  it("stops before the next topic once aborted", async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      candidates: [candidate("One topic"), candidate("Two topic")],
      classifications: [worthy("One topic"), worthy("Two topic")],
      signal: controller.signal,
      generate: async (query) => {
        controller.abort();
        return { slug: query, created: true };
      },
    });
    await runCycle(deps);
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });

  it("marks a topic synced only after its story action succeeded", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Bad topic"), candidate("Good topic"), candidate("Lakers score")],
      classifications: [worthy("Bad topic"), worthy("Good topic"), unworthy("Lakers score")],
      generate: async (query) => {
        if (query === "Bad topic") throw new Error("Nebius down");
        return { slug: "good-topic", created: true };
      },
    });
    await runCycle(deps);
    expect(deps.markSynced.mock.calls).toEqual([["good topic"]]);
  });

  it("does not mark a topic synced when its story link fails", async () => {
    const deps = fakeDeps({ candidates: [candidate("Typhoon Koinu")], classifications: [worthy("Typhoon Koinu")] });
    deps.linkStory.mockRejectedValueOnce(new Error("graph down"));
    await runCycle(deps);
    expect(deps.markSynced).not.toHaveBeenCalled();
  });

  it("leaves a topic skipped by MAX_NEW_STORIES_PER_CYCLE unsynced, so a later cycle retries it", async () => {
    const names = ["One topic", "Two topic"];
    const deps = fakeDeps({
      candidates: names.map((n) => candidate(n)),
      classifications: names.map((n) => worthy(n)),
      settings: { maxNewStories: 1 },
    });
    await runCycle(deps);
    expect(deps.markSynced.mock.calls).toEqual([["one topic"]]);
  });

  it("leaves a topic linked only because MAX_REFRESHES_PER_CYCLE was reached unsynced", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Brexit deal"), candidate("Mars landing")],
      classifications: [worthy("Brexit deal"), worthy("Mars landing")],
      metas: [meta("brexit-deal", "Brexit deal", 12), meta("mars-landing", "Mars landing", 12)],
      settings: { maxRefreshes: 1 },
    });
    await runCycle(deps);
    expect(deps.markSynced.mock.calls).toEqual([["brexit deal"]]);
  });

  it("marks fresh links and refreshes another process is running as synced", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Brexit deal"), candidate("Mars landing")],
      classifications: [worthy("Brexit deal"), worthy("Mars landing")],
      metas: [meta("brexit-deal", "Brexit deal", 1), meta("mars-landing", "Mars landing", 12)],
      refresh: async (slug) => ({ slug, created: false, busy: true }),
    });
    await runCycle(deps);
    expect(deps.markSynced.mock.calls).toEqual([["brexit deal"], ["mars landing"]]);
  });

  it("warns but still counts the action when marking it synced fails", async () => {
    const deps = fakeDeps({ candidates: [candidate("Typhoon Koinu")], classifications: [worthy("Typhoon Koinu")] });
    deps.markSynced.mockRejectedValueOnce(new Error("graph blip"));
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ created: 1, failed: 0 });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/graph blip/));
  });
});
