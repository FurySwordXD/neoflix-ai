import { describe, expect, it, vi } from "vitest";
import {
  CATEGORIES,
  classifyTopics,
  parseClassifications,
  type ClassifyDeps,
} from "@/lib/trendSync/classify";
import type { Candidate } from "@/lib/trendSync/selection";

function candidate(name: string, traffic: number | null = 5000, headlines: Candidate["headlines"] = []): Candidate {
  return { key: name.toLowerCase(), name, traffic, latestAt: "2026-10-28T10:00:00.000Z", cached: null, headlines };
}

const TOPICS = [
  candidate("Gaza ceasefire", 5000, [
    { title: "Ceasefire talks resume in Cairo", source: "reuters.com" },
    { title: "Hostage deal nears, officials say", source: "apnews.com" },
  ]),
  candidate("Lakers score", null),
];

const VALID = JSON.stringify({
  topics: [
    { name: "Gaza ceasefire", worthy: true, query: "Gaza ceasefire talks", category: "conflict" },
    { name: "Lakers score", worthy: false, query: "", category: null },
  ],
});

function deps(raw: string | Error) {
  return {
    complete: vi.fn(async (_system: string, _user: string) => {
      if (raw instanceof Error) throw raw;
      return raw;
    }),
    warn: vi.fn((_message: string) => undefined),
  } satisfies ClassifyDeps;
}

describe("CATEGORIES", () => {
  it("are the subjects the static TRENDS list uses", () => {
    expect([...CATEGORIES].sort()).toEqual(
      ["climate", "conflict", "economy", "energy", "environment", "health", "politics", "rights", "science", "tech"]
    );
  });
});

describe("parseClassifications", () => {
  it("maps each answer back to its topic key", () => {
    expect(parseClassifications(VALID, TOPICS)).toEqual([
      { key: "gaza ceasefire", name: "Gaza ceasefire", worthy: true, query: "Gaza ceasefire talks", category: "conflict" },
      { key: "lakers score", name: "Lakers score", worthy: false, query: null, category: null },
    ]);
  });

  it("accepts a bare array, a code fence and a thinking block", () => {
    const bare = JSON.stringify(JSON.parse(VALID).topics);
    expect(parseClassifications(bare, TOPICS)).toHaveLength(2);
    expect(parseClassifications("```json\n" + VALID + "\n```", TOPICS)).toHaveLength(2);
    expect(parseClassifications("<think>hmm {</think>" + VALID, TOPICS)).toHaveLength(2);
  });

  it("matches names case- and whitespace-insensitively", () => {
    const raw = JSON.stringify([
      { name: "  gaza   CEASEFIRE ", worthy: true, query: "Gaza ceasefire", category: "conflict" },
      { name: "lakers score", worthy: false, query: "", category: "" },
    ]);
    expect(parseClassifications(raw, TOPICS).map((c) => c.key)).toEqual(["gaza ceasefire", "lakers score"]);
  });

  it("falls back to the topic name when a worthy answer has no query", () => {
    const raw = JSON.stringify([
      { name: "Gaza ceasefire", worthy: true, query: " ", category: "conflict" },
      { name: "Lakers score", worthy: false, query: "", category: null },
    ]);
    expect(parseClassifications(raw, TOPICS)[0].query).toBe("Gaza ceasefire");
  });

  const invalid: Array<[string, unknown]> = [
    ["not JSON", "sorry, I cannot"],
    ["not a list", { result: "ok" }],
    ["a missing topic", [{ name: "Gaza ceasefire", worthy: true, query: "q", category: "conflict" }]],
    [
      "an unknown topic",
      [
        { name: "Gaza ceasefire", worthy: true, query: "q", category: "conflict" },
        { name: "Mars landing", worthy: true, query: "q", category: "science" },
      ],
    ],
    [
      "a duplicate topic",
      [
        { name: "Gaza ceasefire", worthy: true, query: "q", category: "conflict" },
        { name: "gaza ceasefire", worthy: false, query: "", category: null },
      ],
    ],
    [
      "a non-boolean worthy",
      [
        { name: "Gaza ceasefire", worthy: "yes", query: "q", category: "conflict" },
        { name: "Lakers score", worthy: false, query: "", category: null },
      ],
    ],
    [
      "a worthy topic with an unknown category",
      [
        { name: "Gaza ceasefire", worthy: true, query: "q", category: "sports" },
        { name: "Lakers score", worthy: false, query: "", category: null },
      ],
    ],
    [
      "a non-string query",
      [
        { name: "Gaza ceasefire", worthy: true, query: 42, category: "conflict" },
        { name: "Lakers score", worthy: false, query: "", category: null },
      ],
    ],
    [
      "an entry that is not an object",
      ["Gaza ceasefire", { name: "Lakers score", worthy: false, query: "", category: null }],
    ],
  ];

  it.each(invalid)("rejects %s", (_label, value) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    expect(() => parseClassifications(raw, TOPICS)).toThrow();
  });

  it("drops an off-list category on a non-worthy topic instead of failing", () => {
    const raw = JSON.stringify([
      { name: "Gaza ceasefire", worthy: true, query: "q", category: "conflict" },
      { name: "Lakers score", worthy: false, query: "", category: "sports" },
    ]);
    expect(parseClassifications(raw, TOPICS)[1].category).toBeNull();
  });

  it("clips very long queries", () => {
    const raw = JSON.stringify([
      { name: "Gaza ceasefire", worthy: true, query: "x".repeat(500), category: "conflict" },
      { name: "Lakers score", worthy: false, query: "", category: null },
    ]);
    expect(parseClassifications(raw, TOPICS)[0].query?.length).toBe(120);
  });
});

describe("classifyTopics", () => {
  it("makes one model call for the whole batch", async () => {
    const fake = deps(VALID);
    const result = await classifyTopics(TOPICS, fake);
    expect(fake.complete).toHaveBeenCalledTimes(1);
    const [system, user] = fake.complete.mock.calls[0];
    expect(system).toMatch(/sports scores/i);
    expect(system).toContain("conflict");
    expect(JSON.parse(user)).toEqual([
      {
        name: "Gaza ceasefire",
        traffic: 5000,
        headlines: [
          { title: "Ceasefire talks resume in Cairo", source: "reuters.com" },
          { title: "Hostage deal nears, officials say", source: "apnews.com" },
        ],
      },
      { name: "Lakers score", traffic: null, headlines: [] },
    ]);
    expect(result?.map((c) => c.worthy)).toEqual([true, false]);
  });

  it("sends at most 3 headlines per topic, clipped", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `Headline ${i} ${"x".repeat(400)}`, source: "a.com" }));
    const fake = deps(VALID);
    await classifyTopics([candidate("Gaza ceasefire", 5000, many), candidate("Lakers score")], fake);
    const sent = JSON.parse(fake.complete.mock.calls[0][1]) as Array<{ headlines: Array<{ title: string }> }>;
    expect(sent[0].headlines).toHaveLength(3);
    expect(sent[0].headlines[0].title.length).toBeLessThanOrEqual(200);
    expect(sent[0].headlines[0].title).toMatch(/^Headline 0/);
  });

  it("asks the model to judge the news event in the headlines, not the bare name", async () => {
    const fake = deps(VALID);
    await classifyTopics(TOPICS, fake);
    const [system] = fake.complete.mock.calls[0];
    expect(system).toMatch(/headlines/i);
    expect(system).toMatch(/dated timeline/i);
    for (const rejected of [/sports scores/i, /deal/i, /weather/i, /name search/i]) expect(system).toMatch(rejected);
  });

  it("returns [] without calling the model when there is nothing to classify", async () => {
    const fake = deps(VALID);
    expect(await classifyTopics([], fake)).toEqual([]);
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it("returns null and warns when the answer fails validation", async () => {
    const fake = deps("[]");
    expect(await classifyTopics(TOPICS, fake)).toBeNull();
    expect(fake.warn).toHaveBeenCalledWith(expect.stringMatching(/classification rejected/));
  });

  it("returns null and warns when the model call fails", async () => {
    const fake = deps(new Error("rate limited"));
    expect(await classifyTopics(TOPICS, fake)).toBeNull();
    expect(fake.warn).toHaveBeenCalledWith(expect.stringMatching(/rate limited/));
  });
});
