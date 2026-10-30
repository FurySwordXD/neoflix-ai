import { describe, expect, it, vi } from "vitest";
import type { StoryMeta } from "@/lib/stories";
import type { Classification } from "@/lib/trendSync/classify";
import type { SyncSettings } from "@/lib/trendSync/config";
import { runCycle, type CycleDeps } from "@/lib/trendSync/decide";
import type { Candidate } from "@/lib/trendSync/selection";
import { makeStory } from "../storyStore/fixtures";

const NOW = new Date("2026-10-28T12:00:00.000Z");

const SETTINGS: SyncSettings = {
  trafficFloor: 1000,
  intervalMinutes: 30,
};

function candidate(name: string, cached: Candidate["cached"] = null): Candidate {
  return { key: name.toLowerCase(), name, traffic: 5000, latestAt: NOW.toISOString(), cached, headlines: [] };
}

function worthy(name: string, query = name): Classification {
  return { key: name.toLowerCase(), name, worthy: true, query, category: "politics" };
}

function unworthy(name: string): Classification {
  return { key: name.toLowerCase(), name, worthy: false, query: null, category: null };
}

function meta(slug: string): StoryMeta {
  const { events: _events, ...rest } = makeStory(slug);
  return rest;
}

interface FakeOptions {
  candidates?: Candidate[];
  classifications?: Classification[] | null;
  metas?: StoryMeta[];
  findStory?: (query: string) => Promise<StoryMeta | null>;
  signal?: AbortSignal;
}

function fakeDeps(opts: FakeOptions = {}) {
  const deps = {
    loadCandidates: vi.fn(async () => opts.candidates ?? []),
    classify: vi.fn(async () => (opts.classifications === undefined ? [] : opts.classifications)),
    saveClassifications: vi.fn(async (_list: Classification[]) => undefined),
    findStory: vi.fn(
      opts.findStory ??
        (async (query: string) => opts.metas?.find((meta) => meta.slug === query.toLowerCase().replace(/\s+/g, "-")) ?? null)
    ),
    linkStory: vi.fn(async (_slug: string, _key: string) => undefined),
    markSynced: vi.fn(async (_key: string) => undefined),
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
      metas: [meta("brexit-deal")],
    });
    const summary = await runCycle(deps);
    expect(deps.classify).toHaveBeenCalledWith([candidate("Lakers score")]);
    const saved = deps.saveClassifications.mock.calls[0][0];
    expect(saved.map((c) => [c.key, c.worthy])).toEqual([
      ["brexit deal", true],
      ["lakers score", false],
    ]);
    expect(summary).toMatchObject({ candidates: 2, classified: 1, worthy: 1, linked: 1, stocked: 0 });
    expect(deps.linkStory).toHaveBeenCalledWith("brexit-deal", "brexit deal");
  });

  it("stocks a worthy topic with no matching story instead of researching", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Typhoon Koinu")],
      classifications: [worthy("Typhoon Koinu", "Typhoon Koinu landfall")],
    });
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ worthy: 1, stocked: 1, linked: 0, failed: 0 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/stocked as "Typhoon Koinu landfall"/));
    // The topic is fully handled: it comes back only when it trends again.
    expect(deps.markSynced).toHaveBeenCalledWith(["typhoon koinu"].toString());
  });

  it("links a worthy topic whose story already exists, whatever its age", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Brexit deal")],
      classifications: [worthy("Brexit deal")],
      metas: [meta("brexit-deal")],
    });
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ linked: 1, stocked: 0 });
    expect(deps.linkStory).toHaveBeenCalledWith("brexit-deal", "brexit deal");
  });

  it("marks nothing when classification fails, but still handles cached topics", async () => {
    const cached = candidate("Brexit deal", { worthy: true, query: "Brexit deal", category: "politics" });
    const deps = fakeDeps({
      candidates: [cached, candidate("Lakers score")],
      classifications: null,
      metas: [meta("brexit-deal")],
    });
    const summary = await runCycle(deps);
    const saved = deps.saveClassifications.mock.calls[0][0];
    expect(saved.map((c) => c.key)).toEqual(["brexit deal"]);
    expect(summary).toMatchObject({ classified: 0, linked: 1 });
  });

  it("does not save anything when nothing was classified or cached", async () => {
    const deps = fakeDeps({ candidates: [candidate("Lakers score")], classifications: null });
    await runCycle(deps);
    expect(deps.saveClassifications).not.toHaveBeenCalled();
  });

  it("keeps going when one topic fails and marks the rest synced", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Bad topic"), candidate("Good topic")],
      classifications: [worthy("Bad topic"), worthy("Good topic")],
      metas: [meta("bad-topic"), meta("good-topic")],
    });
    deps.linkStory.mockRejectedValueOnce(new Error("graph down"));
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ linked: 1, failed: 1 });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/"Bad topic" failed: graph down/));
    expect(deps.markSynced.mock.calls).toEqual([["good topic"]]);
  });

  it("stops before the next topic once aborted", async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      candidates: [candidate("One topic"), candidate("Two topic")],
      classifications: [worthy("One topic"), worthy("Two topic")],
      signal: controller.signal,
    });
    deps.findStory.mockImplementation(async () => {
      controller.abort();
      return null;
    });
    await runCycle(deps);
    expect(deps.findStory).toHaveBeenCalledTimes(1);
  });

  it("marks stocked topics synced too, so they do not retry every cycle", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Typhoon Koinu"), candidate("Other topic")],
      classifications: [worthy("Typhoon Koinu"), worthy("Other topic")],
    });
    await runCycle(deps);
    expect(deps.markSynced.mock.calls).toEqual([["typhoon koinu"], ["other topic"]]);
  });

  it("warns but still counts the topic when marking it synced fails", async () => {
    const deps = fakeDeps({
      candidates: [candidate("Typhoon Koinu")],
      classifications: [worthy("Typhoon Koinu")],
    });
    deps.markSynced.mockRejectedValueOnce(new Error("graph blip"));
    const summary = await runCycle(deps);
    expect(summary).toMatchObject({ stocked: 1, failed: 0 });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/graph blip/));
  });
});
