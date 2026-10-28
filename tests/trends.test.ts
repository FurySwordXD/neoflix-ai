import { describe, expect, it, vi } from "vitest";
import type { Driver } from "neo4j-driver";
import {
  FRESHNESS_WINDOW_MS,
  freshnessAt,
  loadGraphTrends,
  parseTrendRow,
  toTrendItems,
  type GraphTrendRow,
} from "@/lib/trends";
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
