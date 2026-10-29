import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoryStore,
  getStoryStore,
  listStories,
  appendStoryEvents,
  getStory,
  listStoryMetas,
  rememberQuery,
  resetStoryStore,
  saveGeneratedEvent,
  saveNewStory,
  setStoryStore,
  storeKindFromEnv,
} from "@/lib/stories";
import { createFileStore } from "@/lib/storyStore/fileStore";
import { closeDriver, neo4jConfigFromEnv, sourceDomain, topicKey } from "@/lib/storyStore/neo4j";
import { makeEvent, makeGenerated, makeStory } from "./storyStore/fixtures";

afterEach(async () => {
  vi.unstubAllEnvs();
  resetStoryStore();
  await closeDriver();
});

describe("storeKindFromEnv", () => {
  it("defaults to the file store", () => {
    expect(storeKindFromEnv({})).toBe("file");
    expect(storeKindFromEnv({ STORY_STORE: "  " })).toBe("file");
  });

  it("accepts file and neo4j in any case", () => {
    expect(storeKindFromEnv({ STORY_STORE: "File" })).toBe("file");
    expect(storeKindFromEnv({ STORY_STORE: "NEO4J" })).toBe("neo4j");
  });

  it("rejects unknown stores", () => {
    expect(() => storeKindFromEnv({ STORY_STORE: "postgres" })).toThrow(/must be "file" or "neo4j"/);
  });
});

describe("createStoryStore", () => {
  it("builds a file store over the given directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neoflix-facade-"));
    try {
      const store = createStoryStore({}, dir);
      await store.saveNewStory(makeStory("alpha"));
      expect(fs.existsSync(path.join(dir, "alpha", "meta.json"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the missing settings when neo4j is selected without them", () => {
    expect(() => createStoryStore({ STORY_STORE: "neo4j" })).toThrow(/NEO4J_URI and NEO4J_PASSWORD/);
    expect(() => createStoryStore({ STORY_STORE: "neo4j", NEO4J_URI: "bolt://x:7687" })).toThrow(
      /needs NEO4J_PASSWORD/
    );
  });

  it("builds a neo4j store without connecting when it is configured", () => {
    const store = createStoryStore({ STORY_STORE: "neo4j", NEO4J_URI: "bolt://127.0.0.1:1", NEO4J_PASSWORD: "x" });
    expect(typeof store.getStory).toBe("function");
  });
});

describe("facade first use", () => {
  it("throws at first use, not at import, when neo4j is misconfigured", async () => {
    vi.stubEnv("STORY_STORE", "neo4j");
    vi.stubEnv("NEO4J_URI", "");
    vi.stubEnv("NEO4J_PASSWORD", "");
    expect(() => listStories()).toThrow(/NEO4J_URI and NEO4J_PASSWORD/);
  });

  it("caches the store until reset", () => {
    vi.stubEnv("STORY_STORE", "file");
    const first = getStoryStore();
    expect(getStoryStore()).toBe(first);
    resetStoryStore();
    expect(getStoryStore()).not.toBe(first);
  });
});

describe("neo4j helpers", () => {
  it("normalizes topic keys like news-scraper's normalize_key", () => {
    expect(topicKey("  2008   Financial\tCrisis \n")).toBe("2008 financial crisis");
    expect(topicKey("")).toBe("");
  });

  it("reads the connection settings with defaults", () => {
    expect(neo4jConfigFromEnv({ NEO4J_URI: " bolt://db:7687 ", NEO4J_PASSWORD: "pw" })).toEqual({
      uri: "bolt://db:7687",
      user: "neo4j",
      password: "pw",
    });
    expect(
      neo4jConfigFromEnv({ NEO4J_URI: "bolt://db", NEO4J_PASSWORD: "pw", NEO4J_USER: "app", NEO4J_DATABASE: "news" })
    ).toEqual({ uri: "bolt://db", user: "app", password: "pw", database: "news" });
  });

  it("derives Source domains like news-scraper", () => {
    expect(sourceDomain("https://www.Reuters.com/a")).toBe("reuters.com");
    expect(sourceDomain("https://apnews.com/x")).toBe("apnews.com");
    expect(sourceDomain("not a url")).toBe("unknown");
  });
});

describe("facade delegation", () => {
  it("routes every call to the active store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neoflix-facade-"));
    try {
      setStoryStore(createFileStore(dir));
      await saveNewStory(makeStory("alpha"));
      await rememberQuery("alpha", "another");
      await appendStoryEvents("alpha", [makeEvent("e04", "2024-04-01T00:00:00.000Z")]);
      const generated = await saveGeneratedEvent("alpha", makeGenerated("x", "2024-05-01T00:00:00.000Z"));
      expect(generated.id).toBe("g005");
      expect((await listStoryMetas()).map((m) => m.slug)).toEqual(["alpha"]);
      expect((await listStories())[0].slug).toBe("alpha");
      expect((await getStory("alpha"))?.queries).toEqual(["first query", "another"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
