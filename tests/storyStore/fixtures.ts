import type { GeneratedEvent, Story, StoryEvent } from "@/lib/types";

export function makeEvent(id: string, timestamp: string, overrides: Partial<StoryEvent> = {}): StoryEvent {
  return {
    id,
    title: `Event ${id}`,
    summary: `What happened in ${id}.`,
    location: { name: "Geneva", country: "Switzerland", lat: 46.2044, lng: 6.1432 },
    timestamp,
    category: "politics",
    sources: [
      {
        id: `${id}-s1`,
        publisher: "Reuters",
        title: `Reuters on ${id}`,
        url: `https://www.reuters.com/world/${id}`,
        publishedAt: timestamp,
        bias: { politicalLean: "center", factualRating: "high", note: "Wire service" },
        corroborates: ["the main claim"],
      },
    ],
    ...overrides,
  };
}

export function makeStory(slug: string, overrides: Partial<Story> = {}): Story {
  return {
    slug,
    title: `Story ${slug}`,
    subtitle: "A subtitle",
    description: "A description",
    status: "ongoing",
    startAt: "2024-01-01T00:00:00.000Z",
    hook: "It began quietly.",
    relatedStories: [{ slug: "other-story", title: "Other story", relation: "Came after it." }],
    queries: ["first query"],
    events: [
      // Saved out of order on purpose: reads must sort by timestamp.
      makeEvent("e02", "2024-02-01T00:00:00.000Z", {
        beat: "escalation",
        motion: { kind: "flow", from: { name: "A", lat: 1, lng: 2 }, to: { name: "B", lat: 3, lng: 4 }, actor: "troops" },
        images: [{ url: "https://img.example.com/a.jpg", caption: "A photo", sourceUrl: "https://www.reuters.com/world/e02" }],
        magnitude: 1200,
        consequence: "Which led on.",
        narration: "Then it grew.",
      }),
      makeEvent("e01", "2024-01-01T00:00:00.000Z", { beat: "spark" }),
      makeEvent("e03", "2024-03-01T00:00:00.000Z", { beat: "now" }),
    ],
    ...overrides,
  };
}

export function makeGenerated(title: string, timestamp: string): GeneratedEvent {
  return {
    id: "ignored",
    title,
    summary: `${title} summary`,
    location: { name: "Paris", country: "France", lat: 48.85, lng: 2.35 },
    timestamp,
    category: "response",
    sources: [
      { publisher: "AP", title: `AP on ${title}`, url: "https://apnews.com/x", publishedAt: timestamp },
      {
        publisher: "BBC",
        title: `BBC on ${title}`,
        url: "https://www.bbc.co.uk/y",
        publishedAt: timestamp,
        bias: { politicalLean: "center", factualRating: "very-high" },
        corroborates: ["a claim"],
      },
    ],
  };
}
