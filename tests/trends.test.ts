import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "neo4j-driver";
import {
  FRESHNESS_WINDOW_MS,
  fetchArticleCoverage,
  freshnessAt,
  loadDashboardTrends,
  loadGraphTrends,
  parseTrendRow,
  savedStoryTrends,
  toTrendItems,
  type GraphTrendRow,
} from "@/lib/trends";
import { resetStoryStore, setStoryStore } from "@/lib/stories";
import { createFileStore } from "@/lib/storyStore/fileStore";
import { makeStory } from "./storyStore/fixtures";
import type { Story } from "@/lib/types";
import { regionsForGeos } from "@/lib/trendRegions";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const HOUR = 3_600_000;

function row(overrides: Partial<GraphTrendRow> = {}): GraphTrendRow {
  return {
    key: "mpox outbreak",
    name: "Mpox outbreak",
    query: "the 2026 mpox outbreak",
    category: "health",
    slug: null,
    storyTitle: null,
    storyDescription: null,
    storyStatus: null,
    geos: ["US"],
    traffic: 50_000,
    latestAtMs: NOW,
    ...overrides,
  };
}

describe("regionsForGeos", () => {
  it("maps country codes to the dashboard region vocabulary", () => {
    expect(regionsForGeos(["US", "GB", "NG", "JP", "IL"])).toEqual([
      "americas",
      "europe",
      "africa",
      "asia",
      "mena",
    ]);
  });

  it("dedupes, ignores case and sub-region suffixes, and omits unknown codes", () => {
    expect(regionsForGeos(["us", "CA", "US-CA", "ZZ", ""])).toEqual(["americas"]);
  });
});

describe("freshnessAt", () => {
  it("is 1 now and decays to 0 over the window", () => {
    expect(freshnessAt(NOW, NOW)).toBe(1);
    expect(freshnessAt(NOW - FRESHNESS_WINDOW_MS / 2, NOW)).toBeCloseTo(0.5);
    expect(freshnessAt(NOW - FRESHNESS_WINDOW_MS, NOW)).toBe(0);
    expect(freshnessAt(NOW - 200 * HOUR, NOW)).toBe(0);
  });

  it("clamps future timestamps to 1 and treats missing ones as stale", () => {
    expect(freshnessAt(NOW + HOUR, NOW)).toBe(1);
    expect(freshnessAt(null, NOW)).toBe(0);
  });
});

describe("parseTrendRow", () => {
  it("accepts a well-formed row", () => {
    expect(parseTrendRow(row())).toEqual(row());
  });

  it("rejects rows without a key or name", () => {
    expect(parseTrendRow({ ...row(), key: null })).toBeNull();
    expect(parseTrendRow({ ...row(), name: 3 })).toBeNull();
    expect(parseTrendRow(null)).toBeNull();
  });

  it("drops malformed optional fields instead of trusting them", () => {
    const parsed = parseTrendRow({
      ...row(),
      query: "  ",
      traffic: "lots",
      latestAtMs: Number.NaN,
      geos: ["US", 7, null],
      slug: 12,
    });
    expect(parsed).toMatchObject({
      query: null,
      traffic: null,
      latestAtMs: null,
      geos: ["US"],
      slug: null,
    });
  });
});

describe("toTrendItems", () => {
  it("maps a topic onto the dashboard trend shape", () => {
    const [item] = toTrendItems([row()], NOW);
    expect(item).toEqual({
      id: "graph:mpox outbreak",
      title: "the 2026 mpox outbreak",
      blurb: "Trending now in US.",
      query: "the 2026 mpox outbreak",
      topics: ["health"],
      regions: ["americas"],
      heat: 1,
      freshness: 1,
      ongoing: true,
    });
  });

  it("uses the linked story for slug, title, blurb and status", () => {
    const [item] = toTrendItems(
      [
        row({
          slug: "mpox-outbreak",
          storyTitle: "The mpox outbreak",
          storyDescription: "How the virus spread.",
          storyStatus: "concluded",
        }),
      ],
      NOW
    );
    expect(item).toMatchObject({
      slug: "mpox-outbreak",
      title: "The mpox outbreak",
      blurb: "How the virus spread.",
      ongoing: false,
    });
  });

  it("falls back to the topic name when no query was classified", () => {
    const [item] = toTrendItems([row({ query: null })], NOW);
    expect(item.query).toBe("Mpox outbreak");
    expect(item.title).toBe("Mpox outbreak");
  });

  it("titles a story-less topic with its classified query, not the raw search term", () => {
    const [item] = toTrendItems(
      [row({ name: "微博", query: "Mbappe apology sparks China controversy" })],
      NOW
    );
    expect(item.title).toBe("Mbappe apology sparks China controversy");
  });

  it("drops categories outside the interest vocabulary", () => {
    const [item] = toTrendItems([row({ category: "sports" })], NOW);
    expect(item.topics).toEqual([]);
  });

  it("normalizes heat on a log scale across the result set", () => {
    const items = toTrendItems(
      [
        row({ key: "a", traffic: 1_000_000 }),
        row({ key: "b", traffic: 1_000 }),
        row({ key: "c", traffic: null }),
      ],
      NOW
    );
    const heat = Object.fromEntries(items.map((item) => [item.id, item.heat]));
    expect(heat["graph:a"]).toBe(1);
    expect(heat["graph:b"]).toBeCloseTo(Math.log1p(1_000) / Math.log1p(1_000_000));
    expect(heat["graph:c"]).toBe(0);
  });

  it("gives zero heat when no topic has traffic", () => {
    const items = toTrendItems([row({ traffic: null }), row({ key: "b", traffic: 0 })], NOW);
    expect(items.map((item) => item.heat)).toEqual([0, 0]);
  });

  it("says plainly when no geo is known", () => {
    const [item] = toTrendItems([row({ geos: [] })], NOW);
    expect(item.blurb).toBe("Trending now.");
    expect(item.regions).toEqual([]);
  });
});

describe("loadGraphTrends", () => {
  const neo4jEnv = { STORY_STORE: "neo4j", NEO4J_URI: "bolt://x", NEO4J_PASSWORD: "p" };

  function fakeDriver(executeQuery: (...args: unknown[]) => Promise<unknown>): Driver {
    return { executeQuery } as unknown as Driver;
  }

  it("returns [] without touching the graph when STORY_STORE is not neo4j", async () => {
    const executeQuery = vi.fn();
    const result = await loadGraphTrends(20, {
      env: { STORY_STORE: "file" },
      driver: fakeDriver(executeQuery),
    });
    expect(result).toEqual([]);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("maps the rows the query returns and skips malformed ones", async () => {
    const records = [
      { toObject: () => row() },
      { toObject: () => ({ key: null }) },
    ];
    const executeQuery = vi.fn().mockResolvedValue({ records });
    const result = await loadGraphTrends(5, {
      env: neo4jEnv,
      driver: fakeDriver(executeQuery),
      now: NOW,
    });
    expect(result.map((item) => item.id)).toEqual(["graph:mpox outbreak"]);
    const params = executeQuery.mock.calls[0][1] as { limit: { toNumber(): number } };
    expect(params.limit.toNumber()).toBe(5);
  });

  it("logs and returns [] when the graph fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const executeQuery = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await loadGraphTrends(20, { env: neo4jEnv, driver: fakeDriver(executeQuery) });
    expect(result).toEqual([]);
    expect(error).toHaveBeenCalledWith("[trends] graph trends unavailable:", "connection refused");
    error.mockRestore();
  });

  it("logs and returns [] when neo4j is selected but not configured", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await loadGraphTrends(20, { env: { STORY_STORE: "neo4j" } });
    expect(result).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects a non-positive limit", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const executeQuery = vi.fn();
    const result = await loadGraphTrends(0, { env: neo4jEnv, driver: fakeDriver(executeQuery) });
    expect(result).toEqual([]);
    expect(executeQuery).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

afterEach(() => {
  resetStoryStore();
});

describe("savedStoryTrends", () => {
  it("stages each saved story as a card, freshest first", () => {
    const items = savedStoryTrends(
      [
        {
          ...makeStory("older"),
          createdAt: new Date(NOW - 48 * HOUR).toISOString(),
          refreshedAt: new Date(NOW - 48 * HOUR).toISOString(),
        },
        {
          ...makeStory("newer"),
          createdAt: new Date(NOW - 2 * HOUR).toISOString(),
          refreshedAt: new Date(NOW - 2 * HOUR).toISOString(),
        },
      ],
      NOW
    );
    expect(items.map((item) => item.id)).toEqual(["story:newer", "story:older"]);
    const [newer, older] = items;
    expect(newer).toMatchObject({
      title: "Story newer",
      blurb: "A description",
      slug: "newer",
      query: "Story newer",
      ongoing: true,
    });
    expect(newer.freshness).toBeCloseTo(1 - 2 / 72);
    expect(older.freshness).toBeCloseTo(1 - 48 / 72);
    expect(newer.heat).toBe(0);
  });

  it("sorts stories with unknown recency last and falls back to title order", () => {
    const items = savedStoryTrends(
      [makeStory("beta", { createdAt: undefined, refreshedAt: undefined }), makeStory("alpha")],
      NOW
    );
    expect(items.map((item) => item.id)).toEqual(["story:alpha", "story:beta"]);
  });

  it("marks concluded stories and drops storyless blanks", () => {
    const items = savedStoryTrends(
      [makeStory("done", { status: "concluded" }), makeStory("blank", { description: "", subtitle: "" })],
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0].ongoing).toBe(false);
  });

  it("ranks by the newest cited article when coverage is known", () => {
    const items = savedStoryTrends(
      [
        {
          ...makeStory("stale-refresh"),
          createdAt: new Date(NOW - 2 * HOUR).toISOString(),
          refreshedAt: new Date(NOW - 2 * HOUR).toISOString(),
        },
        {
          ...makeStory("hot-coverage"),
          createdAt: new Date(NOW - 48 * HOUR).toISOString(),
          refreshedAt: new Date(NOW - 48 * HOUR).toISOString(),
        },
      ],
      NOW,
      // hot-coverage's sources ran an hour ago; stale-refresh cites week-old news.
      {
        "hot-coverage": NOW - HOUR,
        "stale-refresh": NOW - 24 * HOUR,
      }
    );
    expect(items.map((item) => item.id)).toEqual(["story:hot-coverage", "story:stale-refresh"]);
    expect(items[0].freshness).toBeCloseTo(1 - 1 / 72);
    expect(items[1].freshness).toBeCloseTo(1 - 24 / 72);
  });

  it("ignores coverage entries that are not finite times", () => {
    const items = savedStoryTrends(
      [
        {
          ...makeStory("covered"),
          createdAt: new Date(NOW - 60 * HOUR).toISOString(),
          refreshedAt: new Date(NOW - 60 * HOUR).toISOString(),
        },
        {
          ...makeStory("uncovered"),
          createdAt: new Date(NOW - 2 * HOUR).toISOString(),
          refreshedAt: new Date(NOW - 2 * HOUR).toISOString(),
        },
      ],
      NOW,
      { covered: Number.NaN }
    );
    // covered falls back to its refresh stamp; uncovered stays fresher.
    expect(items.map((item) => item.id)).toEqual(["story:uncovered", "story:covered"]);
  });
});

describe("loadDashboardTrends", () => {
  const neo4jEnv = { STORY_STORE: "neo4j", NEO4J_URI: "bolt://x", NEO4J_PASSWORD: "p" };

  function fakeDriver(executeQuery: (...args: unknown[]) => Promise<unknown>): Driver {
    return { executeQuery } as unknown as Driver;
  }

  /** A file store over a temp dir, holding the given stories. */
  function fileStoreWith(stories: Story[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neoflix-trends-"));
    const store = createFileStore(dir);
    for (const story of stories) store.saveNewStory(story);
    setStoryStore(store);
    return () => fs.rmSync(dir, { recursive: true, force: true });
  }

  it("puts graph topics first and the saved-story shelf behind them", async () => {
    const cleanup = fileStoreWith([
      makeStory("shelf-story", {
        createdAt: new Date(NOW - HOUR).toISOString(),
        refreshedAt: new Date(NOW - HOUR).toISOString(),
      }),
    ]);
    try {
      const records = [{ toObject: () => row() }];
      const executeQuery = vi.fn().mockResolvedValue({ records });
      const items = await loadDashboardTrends(20, {
        env: neo4jEnv,
        driver: fakeDriver(executeQuery),
        now: NOW,
      });
      expect(items.map((item) => item.id)).toEqual(["graph:mpox outbreak", "story:shelf-story"]);
      expect(items[0].freshness).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("hides a saved story its graph topic already covers", async () => {
    const cleanup = fileStoreWith([
      makeStory("mpox-outbreak", {
        title: "The mpox outbreak",
        createdAt: new Date(NOW - HOUR).toISOString(),
        refreshedAt: new Date(NOW - HOUR).toISOString(),
      }),
    ]);
    try {
      const records = [
        { toObject: () => row({ slug: "mpox-outbreak", storyTitle: "The mpox outbreak", query: "the 2026 mpox outbreak" }) },
      ];
      const executeQuery = vi.fn().mockResolvedValue({ records });
      const items = await loadDashboardTrends(20, {
        env: neo4jEnv,
        driver: fakeDriver(executeQuery),
        now: NOW,
      });
      expect(items.map((item) => item.id)).toEqual(["graph:mpox outbreak"]);
    } finally {
      cleanup();
    }
  });

  it("shows only the saved-story shelf when the graph is empty", async () => {
    const cleanup = fileStoreWith([
      makeStory("only-saved", {
        createdAt: new Date(NOW - HOUR).toISOString(),
        refreshedAt: new Date(NOW - HOUR).toISOString(),
      }),
    ]);
    try {
      const executeQuery = vi.fn().mockResolvedValue({ records: [] });
      const items = await loadDashboardTrends(20, {
        env: neo4jEnv,
        driver: fakeDriver(executeQuery),
        now: NOW,
      });
      expect(items.map((item) => item.id)).toEqual(["story:only-saved"]);
    } finally {
      cleanup();
    }
  });

  it("returns [] when the db has nothing at all", async () => {
    const cleanup = fileStoreWith([]);
    try {
      const executeQuery = vi.fn().mockResolvedValue({ records: [] });
      const items = await loadDashboardTrends(20, {
        env: neo4jEnv,
        driver: fakeDriver(executeQuery),
        now: NOW,
      });
      expect(items).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("ranks the shelf by the newest article its story cites", async () => {
    const cleanup = fileStoreWith([
      makeStory("refreshed-but-old-news", {
        createdAt: new Date(NOW - 2 * HOUR).toISOString(),
        refreshedAt: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      makeStory("in-the-news", {
        createdAt: new Date(NOW - 48 * HOUR).toISOString(),
        refreshedAt: new Date(NOW - 48 * HOUR).toISOString(),
      }),
    ]);
    try {
      // The trends query comes back empty; the coverage query answers.
      const executeQuery = vi.fn().mockImplementation((query: string) =>
        Promise.resolve(
          query.includes("CITES")
            ? { records: [{ toObject: () => ({ slug: "in-the-news", latestArticle: new Date(NOW - HOUR).toISOString() }) }] }
            : { records: [] }
        )
      );
      const items = await loadDashboardTrends(20, {
        env: neo4jEnv,
        driver: fakeDriver(executeQuery),
        now: NOW,
      });
      expect(items.map((item) => item.id)).toEqual(["story:in-the-news", "story:refreshed-but-old-news"]);
      expect(items[0].freshness).toBeCloseTo(1 - 1 / 72);
    } finally {
      cleanup();
    }
  });
});

describe("fetchArticleCoverage", () => {
  function fakeDriver(records: unknown[]): Driver {
    return { executeQuery: vi.fn().mockResolvedValue({ records }) } as unknown as Driver;
  }

  it("maps slug to the latest cited article, skipping malformed rows", async () => {
    const coverage = await fetchArticleCoverage(
      fakeDriver([
        { toObject: () => ({ slug: "gaza-war", latestArticle: "2026-10-26T12:30:00.000Z" }) },
        { toObject: () => ({ slug: "bad-time", latestArticle: "not a date" }) },
        { toObject: () => ({ slug: null, latestArticle: "2026-10-26T12:30:00.000Z" }) },
        { toObject: () => ({ slug: "blank", latestArticle: "  " }) },
      ])
    );
    expect(coverage).toEqual({ "gaza-war": Date.parse("2026-10-26T12:30:00.000Z") });
  });
});
