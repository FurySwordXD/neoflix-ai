import { describe, expect, it } from "vitest";
import {
  CANONICAL_CITATION,
  MAX_HISTORY_MESSAGES,
  citedEventIds,
  citationsFor,
  normalizeCitations,
  sanitizeHistory,
  sanitizeQuestion,
  stripThinking,
} from "@/lib/ask";
import { makeStory } from "../storyStore/fixtures";

describe("normalizeCitations", () => {
  it("canonicalizes the marker shapes the model actually emits", () => {
    expect(normalizeCitations("[ e01 ]")).toBe("[e01]");
    expect(normalizeCitations("[E1]")).toBe("[e01]");
    expect(normalizeCitations("[ g12 ]")).toBe("[g012]");
    expect(normalizeCitations("text [e01] more [ e02 ] end")).toBe("text [e01] more [e02] end");
  });

  it("leaves non-citation brackets alone", () => {
    expect(normalizeCitations("[see this]")).toBe("[see this]");
    expect(normalizeCitations("[]")).toBe("[]");
  });
});

describe("citedEventIds", () => {
  it("collects ids deduped in first-mention order", () => {
    expect(citedEventIds("a [e02] b [e01] c [e02]")).toEqual(["e02", "e01"]);
  });

  it("matches canonical markers too", () => {
    expect(citedEventIds("[e01] and [g003]")).toEqual(["e01", "g003"]);
  });
});

describe("citationsFor", () => {
  const story = makeStory("test-story");

  it("resolves cited events with their sources, in mention order", () => {
    const citations = citationsFor(story, "[e01] then [e03]");
    expect(citations.map((c) => c.eventId)).toEqual(["e01", "e03"]);
    expect(citations[0].sources[0].publisher).toBe("Reuters");
    expect(citations[0].sources[0].url).toContain("reuters.com");
  });

  it("skips ids the story does not have", () => {
    expect(citationsFor(story, "[e99] unknown")).toEqual([]);
  });
});

describe("stripThinking", () => {
  it("drops closed and unclosed thinking blocks", () => {
    expect(stripThinking("<think>reasoning</think>Answer")).toBe("Answer");
    expect(stripThinking("<think>still going")).toBe("");
    expect(stripThinking("  Answer text  ")).toBe("Answer text");
  });
});

describe("sanitizeQuestion", () => {
  it("trims and caps the question", () => {
    expect(sanitizeQuestion("  What happened?  ")).toBe("What happened?");
    expect(sanitizeQuestion("x".repeat(600))).toHaveLength(500);
  });

  it("rejects unusable questions", () => {
    expect(sanitizeQuestion("   ")).toBeNull();
    expect(sanitizeQuestion(null)).toBeNull();
    expect(sanitizeQuestion(42)).toBeNull();
  });
});

describe("sanitizeHistory", () => {
  it("keeps only real user/assistant turns with text", () => {
    const turns = sanitizeHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello [ e01 ]" },
      { role: "system", content: "sneaky" },
      { role: "user", content: "  " },
      "junk",
      null,
    ]);
    expect(turns).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello [e01]" },
    ]);
  });

  it("keeps only the most recent messages", () => {
    const many = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
      role: "user" as const,
      content: `q${i}`,
    }));
    const kept = sanitizeHistory(many);
    expect(kept).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(kept[0].content).toBe(`q${MAX_HISTORY_MESSAGES + 5 - MAX_HISTORY_MESSAGES}`);
  });

  it("rejects non-array history", () => {
    expect(sanitizeHistory(undefined)).toEqual([]);
    expect(sanitizeHistory({})).toEqual([]);
  });
});

describe("CANONICAL_CITATION", () => {
  it("matches two-digit e ids and three-digit g ids only", () => {
    expect(CANONICAL_CITATION.test("[e01]")).toBe(true);
    expect(CANONICAL_CITATION.test("[g003]")).toBe(true);
    expect(CANONICAL_CITATION.test("[e1]")).toBe(false);
    expect(CANONICAL_CITATION.test("[e001]")).toBe(false);
    expect(CANONICAL_CITATION.test("[x01]")).toBe(false);
  });
});
