import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aboveScoreCutoff,
  graphResearchSettings,
  graphSearch,
  luceneQuery,
  mergeSearchResponses,
  persistSearchResults,
  researchQuery,
  type ResearchDeps,
} from "@/lib/graphResearch";
import type { WebSearchResponse, WebSearchResult } from "@/lib/webSearch";
import type { Driver } from "neo4j-driver";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function hit(url: string, overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { title: `Title ${url}`, url, snippet: `Snippet ${url}`, ...overrides };
}

function response(urls: string[], images: string[] = []): WebSearchResponse {
  return { results: urls.map((url) => hit(url)), images: images.map((url) => ({ url })) };
}

function urlsOf(found: WebSearchResponse): string[] {
  return found.results.map((r) => r.url);
}

/** A driver that fails the test if anything touches it. */
function forbiddenDriver(): Driver {
  const fail = vi.fn(() => {
    throw new Error("the graph must not be called");
  });
  return { executeQuery: fail, session: fail } as unknown as Driver;
}

function fakeDeps(overrides: Partial<ResearchDeps> = {}): ResearchDeps & {
  lines: string[];
  warnings: unknown[][];
} {
  const lines: string[] = [];
  const warnings: unknown[][] = [];
  return {
    graphSearch: vi.fn(async () => response([])),
    webSearch: vi.fn(async () => response([])),
    persist: vi.fn(async () => {}),
    minHits: 5,
    log: (line: string) => lines.push(line),
    warn: (...args: unknown[]) => warnings.push(args),
    lines,
    warnings,
    ...overrides,
  };
}

describe("luceneQuery", () => {
  it("requires every significant term, lowercased and escaped", () => {
    expect(luceneQuery("  Gaza   ceasefire \t talks ")).toBe("gaza AND ceasefire AND talks");
    expect(luceneQuery('C++ AND (Rust) "quote" a:b')).toBe('\\(rust\\) AND \\"quote\\"');
    expect(luceneQuery("x-ray release: what's next?")).toBe("x\\-ray AND release\\: AND next\\?");
  });

  it("drops stopwords and 1-2 letter tokens", () => {
    expect(luceneQuery("The wind farm in the UK is on fire")).toBe("wind AND farm AND fire");
    expect(luceneQuery("Michael Douglas")).toBe("michael AND douglas");
  });

  it("falls back to any-term matching when no significant term is left", () => {
    expect(luceneQuery("to be or not")).toBe("to be or not");
    expect(luceneQuery("x-ray !not {a} [b] ^c ~d *e ?f \\g /h &i |j")).toBe("x\\-ray");
    expect(luceneQuery("&& || ??")).toBe("\\&\\& \\|\\| \\?\\?");
    expect(luceneQuery("   ")).toBe("");
  });
});

describe("aboveScoreCutoff", () => {
  it("keeps only rows scoring at least half the top score", () => {
    const rows = [{ id: "a", score: 4 }, { id: "b", score: 2 }, { id: "c", score: 1.9 }, { id: "d", score: 0.1 }];
    expect(aboveScoreCutoff(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps rows in their original order and does not mutate the input", () => {
    const rows = [{ id: "b", score: 2 }, { id: "a", score: 3 }];
    expect(aboveScoreCutoff(rows).map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows).toHaveLength(2);
  });

  it("handles empty input and non-numeric scores", () => {
    expect(aboveScoreCutoff([])).toEqual([]);
    expect(aboveScoreCutoff([{ id: "a", score: 1 }, { id: "b", score: "x" as unknown as number }]).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("graphResearchSettings", () => {
  it("uses the defaults when the env is unset", () => {
    expect(graphResearchSettings({})).toEqual({ minHits: 5, freshDays: 30 });
  });

  it("reads GRAPH_MIN_HITS and GRAPH_FRESH_DAYS", () => {
    expect(graphResearchSettings({ GRAPH_MIN_HITS: "3", GRAPH_FRESH_DAYS: "7" })).toEqual({
      minHits: 3,
      freshDays: 7,
    });
  });

  it("falls back to the defaults for values that are not positive integers", () => {
    expect(graphResearchSettings({ GRAPH_MIN_HITS: "zero", GRAPH_FRESH_DAYS: "-2" })).toEqual({
      minHits: 5,
      freshDays: 30,
    });
  });
});

describe("mergeSearchResponses", () => {
  it("keeps the first response's order and adds only new URLs from the second", () => {
    const merged = mergeSearchResponses(
      response(["https://a.com/1", "https://b.com/2"], ["https://img.com/1.jpg"]),
      response(["https://b.com/2", "https://c.com/3"], ["https://img.com/1.jpg", "https://img.com/2.jpg"])
    );
    expect(urlsOf(merged)).toEqual(["https://a.com/1", "https://b.com/2", "https://c.com/3"]);
    expect(merged.images.map((i) => i.url)).toEqual(["https://img.com/1.jpg", "https://img.com/2.jpg"]);
  });

  it("does not mutate its inputs", () => {
    const first = response(["https://a.com/1"]);
    const second = response(["https://c.com/3"]);
    mergeSearchResponses(first, second);
    expect(urlsOf(first)).toEqual(["https://a.com/1"]);
    expect(urlsOf(second)).toEqual(["https://c.com/3"]);
  });
});

describe("researchQuery", () => {
  it("uses the graph and skips Tavily when there are enough hits", async () => {
    const graph = response(["https://g.com/1", "https://g.com/2", "https://g.com/3"]);
    const deps = fakeDeps({ minHits: 3, graphSearch: vi.fn(async () => graph) });

    const found = await researchQuery("election", deps);

    expect(found).toEqual(graph);
    expect(deps.webSearch).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.lines).toEqual(["research: graph=3 tavily=skipped"]);
  });

  it("falls back to Tavily below the threshold, merges graph hits and persists Tavily's", async () => {
    const graph = response(["https://g.com/1", "https://t.com/2"]);
    const tavily = response(["https://t.com/1", "https://t.com/2"], ["https://img.com/a.jpg"]);
    const deps = fakeDeps({
      graphSearch: vi.fn(async () => graph),
      webSearch: vi.fn(async () => tavily),
    });

    const found = await researchQuery("election", deps);

    expect(deps.webSearch).toHaveBeenCalledWith("election");
    expect(urlsOf(found)).toEqual(["https://t.com/1", "https://t.com/2", "https://g.com/1"]);
    expect(found.images).toEqual([{ url: "https://img.com/a.jpg" }]);
    expect(deps.persist).toHaveBeenCalledWith(tavily);
    expect(deps.lines).toEqual(["research: graph=2 tavily=used"]);
  });

  it("does not persist an empty Tavily response", async () => {
    const deps = fakeDeps();
    await researchQuery("election", deps);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.lines).toEqual(["research: graph=0 tavily=used"]);
  });

  it("logs and survives a failed persist", async () => {
    const tavily = response(["https://t.com/1"]);
    const deps = fakeDeps({
      webSearch: vi.fn(async () => tavily),
      persist: vi.fn(async () => {
        throw new Error("graph down");
      }),
    });

    const found = await researchQuery("election", deps);

    expect(found).toEqual(tavily);
    expect(deps.warnings).toHaveLength(1);
    expect(String(deps.warnings[0])).toContain("graph down");
  });

  it("logs a failed graph search and still answers from Tavily", async () => {
    const tavily = response(["https://t.com/1"]);
    const deps = fakeDeps({
      graphSearch: vi.fn(async () => {
        throw new Error("no such index");
      }),
      webSearch: vi.fn(async () => tavily),
    });

    const found = await researchQuery("election", deps);

    expect(found).toEqual(tavily);
    expect(String(deps.warnings[0])).toContain("no such index");
    expect(deps.lines).toEqual(["research: graph=0 tavily=used"]);
  });

  it("reads GRAPH_MIN_HITS from the env by default", async () => {
    vi.stubEnv("GRAPH_MIN_HITS", "1");
    const graph = response(["https://g.com/1"]);
    const webSearch = vi.fn(async () => response([]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await researchQuery("election", { graphSearch: vi.fn(async () => graph), webSearch });

    expect(webSearch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("research: graph=1 tavily=skipped");
  });
});

describe("file mode", () => {
  it("graphSearch returns nothing without touching the graph", async () => {
    const found = await graphSearch("election", { env: { STORY_STORE: "file" }, driver: forbiddenDriver() });
    expect(found).toEqual({ results: [], images: [] });
  });

  it("persistSearchResults is a no-op", async () => {
    await expect(
      persistSearchResults(response(["https://t.com/1"]), {
        env: {},
        driver: forbiddenDriver(),
      })
    ).resolves.toBeUndefined();
  });

  it("researchQuery goes straight to Tavily with the default graph steps", async () => {
    vi.stubEnv("STORY_STORE", "file");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tavily = response(["https://t.com/1"]);
    const webSearch = vi.fn(async () => tavily);

    const found = await researchQuery("election", { webSearch });

    expect(found).toEqual(tavily);
    expect(webSearch).toHaveBeenCalledOnce();
  });
});
