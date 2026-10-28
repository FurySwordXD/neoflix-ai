import { beforeEach, describe, expect, it } from "vitest";
import { importStories } from "@/lib/storyStore/importStories";
import type { StoryStore } from "@/lib/storyStore/types";
import { makeEvent, makeGenerated, makeStory } from "./fixtures";

export interface ContractHarness {
  /** A fresh, empty store for each test. */
  fresh(): Promise<StoryStore>;
  /** A second, empty store to import from (always a file store). */
  freshSource(): Promise<StoryStore>;
}

/** The behavior every StoryStore must share, run once per implementation. */
export function runStoreContract(name: string, harness: () => ContractHarness): void {
  describe(`StoryStore contract: ${name}`, () => {
    let store: StoryStore;

    beforeEach(async () => {
      store = await harness().fresh();
    });

    it("returns null and empty lists when nothing is saved", async () => {
      expect(await store.getStory("missing")).toBeNull();
      expect(await store.listStoryMetas()).toEqual([]);
      expect(await store.listStories()).toEqual([]);
    });

    it("saves a story and reads it back with events sorted by timestamp", async () => {
      const story = makeStory("alpha");
      const saved = await store.saveNewStory(story);
      expect(saved).toEqual(story);

      const loaded = await store.getStory("alpha");
      const { events, ...meta } = story;
      expect(loaded).toEqual({
        ...meta,
        events: [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      });
      expect(loaded?.events.map((e) => e.id)).toEqual(["e01", "e02", "e03"]);
    });

    it("lists metas and list items for saved stories", async () => {
      await store.saveNewStory(makeStory("alpha"));
      await store.saveNewStory(makeStory("beta", { status: "concluded", endAt: "2024-04-01T00:00:00.000Z" }));

      const metas = await store.listStoryMetas();
      expect(metas.map((m) => m.slug).sort()).toEqual(["alpha", "beta"]);
      const alpha = metas.find((m) => m.slug === "alpha");
      expect(alpha).toMatchObject({
        title: "Story alpha",
        hook: "It began quietly.",
        queries: ["first query"],
        relatedStories: [{ slug: "other-story", title: "Other story", relation: "Came after it." }],
      });
      expect(alpha).not.toHaveProperty("events");

      const items = await store.listStories();
      expect(items.find((i) => i.slug === "beta")).toEqual({
        slug: "beta",
        title: "Story beta",
        subtitle: "A subtitle",
        status: "concluded",
        startAt: "2024-01-01T00:00:00.000Z",
        endAt: "2024-04-01T00:00:00.000Z",
      });
    });

    it("refuses to overwrite a saved slug and returns the saved story", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const second = await store.saveNewStory(makeStory("alpha", { title: "Different", events: [] }));
      expect(second.title).toBe("Story alpha");
      expect(second.events).toHaveLength(3);
      expect((await store.getStory("alpha"))?.title).toBe("Story alpha");
    });

    it("keeps optional fields absent when they were never set", async () => {
      const story = makeStory("bare", { hook: undefined, queries: undefined, relatedStories: [] });
      await store.saveNewStory(story);
      const loaded = await store.getStory("bare");
      expect(loaded).not.toHaveProperty("hook");
      expect(loaded).not.toHaveProperty("endAt");
      expect(loaded).not.toHaveProperty("queries");
      expect(loaded?.relatedStories).toEqual([]);
    });

    it("round-trips sources with bias and corroborates", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const loaded = await store.getStory("alpha");
      expect(loaded?.events[0].sources).toEqual([
        {
          id: "e01-s1",
          publisher: "Reuters",
          title: "Reuters on e01",
          url: "https://www.reuters.com/world/e01",
          publishedAt: "2024-01-01T00:00:00.000Z",
          bias: { politicalLean: "center", factualRating: "high", note: "Wire service" },
          corroborates: ["the main claim"],
        },
      ]);
    });

    it("trims motions on read like the app expects", async () => {
      const flow = { kind: "impact" as const };
      const events = ["e1", "e2", "e3", "e4", "e5", "e6"].map((id, i) =>
        makeEvent(id, `2024-0${i + 1}-01T00:00:00.000Z`, { motion: flow, beat: "escalation" })
      );
      await store.saveNewStory(makeStory("busy", { events }));
      const loaded = await store.getStory("busy");
      const withMotion = loaded?.events.filter((e) => e.motion) ?? [];
      expect(withMotion.length).toBeLessThan(events.length);
    });

    it("appends events, demotes the old now beat, and reloads sorted", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const added = makeEvent("e04", "2024-04-01T00:00:00.000Z", { beat: "now" });
      const early = makeEvent("e00", "2023-12-01T00:00:00.000Z", { beat: "setup" });

      const updated = await store.appendStoryEvents("alpha", [early, added]);
      expect(updated.events.map((e) => e.id)).toEqual(["e00", "e01", "e02", "e03", "e04"]);
      expect(updated.events.find((e) => e.id === "e03")?.beat).toBe("escalation");
      expect(updated.events.find((e) => e.id === "e04")?.beat).toBe("now");
      expect(updated.status).toBe("ongoing");
      expect(updated).not.toHaveProperty("endAt");
    });

    it("does not demote the now beat when nothing is appended", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const updated = await store.appendStoryEvents("alpha", []);
      expect(updated.events.find((e) => e.id === "e03")?.beat).toBe("now");
    });

    it("concludes a story with an epilogue and the later end date", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const updated = await store.appendStoryEvents(
        "alpha",
        [makeEvent("e04", "2024-05-01T00:00:00.000Z")],
        { status: "concluded", epilogue: "It ended." }
      );
      expect(updated.status).toBe("concluded");
      expect(updated.epilogue).toBe("It ended.");
      expect(updated.endAt).toBe("2024-05-01T00:00:00.000Z");
    });

    it("keeps an existing end date when concluding", async () => {
      await store.saveNewStory(makeStory("alpha", { endAt: "2030-01-01T00:00:00.000Z" }));
      const updated = await store.appendStoryEvents("alpha", [], { status: "concluded" });
      expect(updated.endAt).toBe("2030-01-01T00:00:00.000Z");
    });

    it("uses the old last event as end date when it is later", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const updated = await store.appendStoryEvents("alpha", [], { status: "concluded" });
      expect(updated.endAt).toBe("2024-03-01T00:00:00.000Z");
    });

    it("throws when appending to a missing story", async () => {
      await expect(store.appendStoryEvents("missing", [])).rejects.toThrow(/not found/);
    });

    it("saves generated events under g### ids with filled-in sources", async () => {
      await store.saveNewStory(makeStory("alpha"));
      const first = await store.saveGeneratedEvent("alpha", makeGenerated("New thing", "2024-06-01T00:00:00.000Z"));
      expect(first.id).toBe("g004");
      expect(first.sources).toEqual([
        {
          id: "g004-s1",
          publisher: "AP",
          title: "AP on New thing",
          url: "https://apnews.com/x",
          publishedAt: "2024-06-01T00:00:00.000Z",
          corroborates: [],
          bias: { politicalLean: "mixed", factualRating: "mixed", note: "Bias classification pending review" },
        },
        {
          id: "g004-s2",
          publisher: "BBC",
          title: "BBC on New thing",
          url: "https://www.bbc.co.uk/y",
          publishedAt: "2024-06-01T00:00:00.000Z",
          corroborates: ["a claim"],
          bias: { politicalLean: "center", factualRating: "very-high" },
        },
      ]);

      const second = await store.saveGeneratedEvent("alpha", makeGenerated("Next thing", "2024-07-01T00:00:00.000Z"));
      expect(second.id).toBe("g005");

      const loaded = await store.getStory("alpha");
      expect(loaded?.events.slice(-2)).toEqual([first, second]);
    });

    it("throws when generating into a missing story", async () => {
      await expect(
        store.saveGeneratedEvent("missing", makeGenerated("x", "2024-01-01T00:00:00.000Z"))
      ).rejects.toThrow(/not found/);
    });

    it("remembers queries trimmed, deduped case-insensitively and capped at 24", async () => {
      await store.saveNewStory(makeStory("alpha"));
      await store.rememberQuery("alpha", "  Second Query  ");
      await store.rememberQuery("alpha", "second query");
      await store.rememberQuery("alpha", "FIRST QUERY");
      await store.rememberQuery("alpha", "   ");
      expect((await store.getStory("alpha"))?.queries).toEqual(["first query", "Second Query"]);

      for (let i = 0; i < 30; i++) await store.rememberQuery("alpha", `q${i}`);
      const queries = (await store.getStory("alpha"))?.queries ?? [];
      expect(queries).toHaveLength(24);
      expect(queries[queries.length - 1]).toBe("q29");
      expect(queries[0]).toBe("q6");
    });

    it("starts a query list for a story saved without one, and ignores missing stories", async () => {
      await store.saveNewStory(makeStory("bare", { queries: undefined }));
      await store.rememberQuery("bare", "hello");
      expect((await store.getStory("bare"))?.queries).toEqual(["hello"]);
      await expect(store.rememberQuery("missing", "hello")).resolves.toBeUndefined();
    });

    it("imports stories idempotently", async () => {
      const source = await harness().freshSource();
      await source.saveNewStory(makeStory("alpha"));
      await source.saveNewStory(makeStory("beta"));

      expect(await importStories(source, store)).toEqual({ imported: 2, skipped: 0 });
      expect(await importStories(source, store)).toEqual({ imported: 0, skipped: 2 });
      expect((await store.listStoryMetas()).map((m) => m.slug).sort()).toEqual(["alpha", "beta"]);
      expect(await store.getStory("alpha")).toEqual(await source.getStory("alpha"));
    });
  });
}
