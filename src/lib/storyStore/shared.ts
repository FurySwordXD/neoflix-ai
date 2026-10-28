import type { GeneratedEvent, Story, StoryEvent } from "../types";
import type { StoryListItem, StoryMeta } from "./types";

/** Rules every store applies the same way, kept here so they cannot drift apart. */

export const MAX_REMEMBERED_QUERIES = 24;
const MAX_QUERY_LENGTH = 200;

/** The query as it is stored, or null when it is blank. */
export function cleanQuery(query: string): string | null {
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
  return trimmed || null;
}

/** The query list with `query` appended, or null when it is blank or already known (any case). */
export function withRememberedQuery(queries: string[] | undefined, query: string): string[] | null {
  const trimmed = cleanQuery(query);
  if (!trimmed) return null;
  const known = Array.isArray(queries) ? queries : [];
  if (known.some((q) => q.toLowerCase() === trimmed.toLowerCase())) return null;
  return [...known, trimmed].slice(-MAX_REMEMBERED_QUERIES);
}

export function sortEvents(events: StoryEvent[]): StoryEvent[] {
  return [...events].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
  );
}

/** `g001`, `g002`, …: the id of the next generated event in a story with `count` events. */
export function generatedEventId(count: number): string {
  return `g${String(count + 1).padStart(3, "0")}`;
}

/** A generated event as it is saved: its id, and every source given an id and a bias. */
export function toSavedEvent(id: string, generated: GeneratedEvent): StoryEvent {
  return {
    ...generated,
    id,
    sources: generated.sources.map((s, i) => ({
      corroborates: [],
      ...s,
      bias: s.bias ?? {
        politicalLean: "mixed",
        factualRating: "mixed",
        note: "Bias classification pending review",
      },
      id: `${id}-s${i + 1}`,
    })),
  };
}

/**
 * The end date a story gets when a refresh concludes it: the later of its old
 * last event and the last appended one.
 */
export function concludedEndAt(existing: StoryEvent[], appended: StoryEvent[]): string {
  const existingLast = existing[existing.length - 1]?.timestamp ?? "";
  const newLast = appended[appended.length - 1]?.timestamp ?? "";
  return existingLast > newLast ? existingLast : newLast;
}

/** The meta record saved for a story: optional fields only when they are set. */
export function toStoryMeta(story: Story): StoryMeta {
  return {
    slug: story.slug,
    title: story.title,
    subtitle: story.subtitle,
    description: story.description,
    status: story.status,
    startAt: story.startAt,
    relatedStories: story.relatedStories,
    ...(story.endAt ? { endAt: story.endAt } : {}),
    ...(story.hook ? { hook: story.hook } : {}),
    ...(story.epilogue ? { epilogue: story.epilogue } : {}),
    ...(story.queries ? { queries: story.queries } : {}),
  };
}

export function toListItem({ slug, title, subtitle, status, startAt, endAt }: StoryMeta): StoryListItem {
  return { slug, title, subtitle, status, startAt, endAt };
}
