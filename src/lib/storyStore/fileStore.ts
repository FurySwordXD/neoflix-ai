import fs from "fs";
import path from "path";
import { limitMotions } from "../mapMotion";
import type { GeneratedEvent, Story, StoryEvent } from "../types";
import {
  concludedEndAt,
  generatedEventId,
  toListItem,
  toSavedEvent,
  toStoryMeta,
  withRememberedQuery,
} from "./shared";
import type { StoryMeta, StoryPatch, StoryStore } from "./types";

/**
 * File-backed story store: one directory per story under `dataDir`, with a
 * meta.json and one JSON file per event.
 */
export function createFileStore(dataDir: string): StoryStore {
  const metaPath = (slug: string) => path.join(dataDir, slug, "meta.json");
  const eventsDir = (slug: string) => path.join(dataDir, slug, "events");

  function readMeta(slug: string): StoryMeta {
    return JSON.parse(fs.readFileSync(metaPath(slug), "utf8")) as StoryMeta;
  }

  function writeMeta(slug: string, meta: StoryMeta): void {
    fs.writeFileSync(metaPath(slug), JSON.stringify(meta, null, 2) + "\n");
  }

  function writeEvent(slug: string, event: StoryEvent): void {
    fs.writeFileSync(
      path.join(eventsDir(slug), eventFileName(event.id, event.title)),
      JSON.stringify(event, null, 2) + "\n"
    );
  }

  function loadStory(slug: string): Story | null {
    if (!fs.existsSync(metaPath(slug))) return null;
    const meta = readMeta(slug);
    const events: StoryEvent[] = fs
      .readdirSync(eventsDir(slug))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(eventsDir(slug), f), "utf8")))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Stories saved under an older, busier prompt get the same motion budget.
    return { ...meta, events: limitMotions(events) };
  }

  function listMetas(): StoryMeta[] {
    if (!fs.existsSync(dataDir)) return [];
    return fs
      .readdirSync(dataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => (fs.existsSync(metaPath(d.name)) ? readMeta(d.name) : null))
      .filter((s): s is StoryMeta => s !== null && typeof s.slug === "string");
  }

  /** The "now" beat marks the newest development; demote it once newer events land. */
  function demoteNowBeat(slug: string, eventId: string): void {
    for (const file of fs.readdirSync(eventsDir(slug))) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(eventsDir(slug), file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoryEvent;
      if (data.id !== eventId) continue;
      fs.writeFileSync(
        filePath,
        JSON.stringify({ ...data, beat: "escalation" } satisfies StoryEvent, null, 2) + "\n"
      );
      return;
    }
  }

  function appendStoryEvents(slug: string, events: StoryEvent[], patch?: StoryPatch): Story {
    const existing = loadStory(slug);
    if (!existing) throw new Error(`Story "${slug}" not found`);
    fs.mkdirSync(eventsDir(slug), { recursive: true });
    for (const event of events) writeEvent(slug, event);

    const prevLast = existing.events[existing.events.length - 1];
    if (events.length > 0 && prevLast?.beat === "now") demoteNowBeat(slug, prevLast.id);

    const meta = readMeta(slug);
    const needsEndAt = patch?.status === "concluded" && !meta.endAt;
    writeMeta(slug, {
      ...meta,
      ...(patch?.status ? { status: patch.status } : {}),
      ...(patch?.epilogue ? { epilogue: patch.epilogue } : {}),
      ...(needsEndAt ? { endAt: concludedEndAt(existing.events, events) } : {}),
    });

    const updated = loadStory(slug);
    if (!updated) throw new Error(`Story "${slug}" not found`);
    return updated;
  }

  function saveGeneratedEvent(slug: string, generated: GeneratedEvent): StoryEvent {
    if (!fs.existsSync(eventsDir(slug))) throw new Error(`Story "${slug}" not found`);
    const count = fs.readdirSync(eventsDir(slug)).filter((f) => f.endsWith(".json")).length;
    const event = toSavedEvent(generatedEventId(count), generated);
    writeEvent(slug, event);
    return event;
  }

  function saveNewStory(story: Story): Story {
    if (fs.existsSync(metaPath(story.slug))) {
      const existing = loadStory(story.slug);
      if (existing) return existing;
    }
    fs.mkdirSync(eventsDir(story.slug), { recursive: true });
    for (const event of story.events) writeEvent(story.slug, event);
    writeMeta(story.slug, toStoryMeta(story));
    return story;
  }

  function rememberQuery(slug: string, query: string): void {
    if (!fs.existsSync(metaPath(slug))) return;
    const meta = readMeta(slug);
    const queries = withRememberedQuery(meta.queries, query);
    if (queries) writeMeta(slug, { ...meta, queries });
  }

  /** The whole story directory goes: meta, events and the voice-over cache. */
  function deleteStory(slug: string): void {
    // Destructive, so refuse anything that could reach outside the data dir.
    if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) return;
    fs.rmSync(path.join(dataDir, slug), { recursive: true, force: true });
  }

  return {
    listStoryMetas: async () => listMetas(),
    listStories: async () => listMetas().map(toListItem),
    getStory: async (slug) => loadStory(slug),
    saveNewStory: async (story) => saveNewStory(story),
    appendStoryEvents: async (slug, events, patch) => appendStoryEvents(slug, events, patch),
    saveGeneratedEvent: async (slug, generated) => saveGeneratedEvent(slug, generated),
    rememberQuery: async (slug, query) => rememberQuery(slug, query),
    deleteStory: async (slug) => deleteStory(slug),
  };
}

/** `e01-bear-stearns-collapse.json`: the event id plus a short title slug. */
function eventFileName(id: string, title: string): string {
  const fileSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${id}${fileSlug ? `-${fileSlug}` : ""}.json`;
}
