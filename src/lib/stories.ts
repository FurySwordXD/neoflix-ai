import fs from "fs";
import path from "path";
import { limitMotions } from "./mapMotion";
import type { Story, StoryEvent, GeneratedEvent } from "./types";

/**
 * File-backed story store. Today: JSON files on disk. Tomorrow: swap this
 * module for a graph DB client — nothing else in the app needs to change.
 */
export const DATA_DIR = path.join(process.cwd(), "src/data/stories");

function loadStory(slug: string): Story | null {
  const storyDir = path.join(DATA_DIR, slug);
  const metaPath = path.join(storyDir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const eventsDir = path.join(storyDir, "events");
  const events: StoryEvent[] = fs
    .readdirSync(eventsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(eventsDir, f), "utf8")))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Stories saved under an older, busier prompt get the same motion budget.
  return { ...meta, events: limitMotions(events) };
}

export type StoryMeta = Omit<Story, "events">;

/** Story records without their event files — enough to match a query. */
export function listStoryMetas(): StoryMeta[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const metaPath = path.join(DATA_DIR, d.name, "meta.json");
      if (!fs.existsSync(metaPath)) return null;
      return JSON.parse(fs.readFileSync(metaPath, "utf8")) as StoryMeta;
    })
    .filter((s): s is StoryMeta => s !== null && typeof s.slug === "string");
}

export function listStories(): Array<Pick<Story, "slug" | "title" | "subtitle" | "status" | "startAt" | "endAt">> {
  return listStoryMetas().map(({ slug, title, subtitle, status, startAt, endAt }) => ({
    slug,
    title,
    subtitle,
    status,
    startAt,
    endAt,
  }));
}

/** Remember a query that resolved to this story so the same ask opens it next time. */
export function rememberQuery(slug: string, query: string): void {
  const metaPath = path.join(DATA_DIR, slug, "meta.json");
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as StoryMeta;
  const trimmed = query.trim().slice(0, 200);
  if (!trimmed) return;
  const queries = Array.isArray(meta.queries) ? meta.queries : [];
  if (queries.some((q) => q.toLowerCase() === trimmed.toLowerCase())) return;
  meta.queries = [...queries, trimmed].slice(-24);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

/** Write a brand-new story. Refuses to overwrite a slug that already has a meta file. */
export function saveNewStory(story: Story): Story {
  const dir = path.join(DATA_DIR, story.slug);
  const metaPath = path.join(dir, "meta.json");
  if (fs.existsSync(metaPath)) {
    const existing = loadStory(story.slug);
    if (existing) return existing;
  }

  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  for (const event of story.events) {
    const fileSlug = event.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40);
    fs.writeFileSync(
      path.join(dir, "events", `${event.id}${fileSlug ? `-${fileSlug}` : ""}.json`),
      JSON.stringify(event, null, 2) + "\n"
    );
  }

  const meta: StoryMeta = {
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
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return story;
}

export function getStory(slug: string): Story | null {
  return loadStory(slug);
}

/** Persist a generated event as a new JSON file in the story's events dir. */
export function saveGeneratedEvent(slug: string, generated: GeneratedEvent): StoryEvent {
  const eventsDir = path.join(DATA_DIR, slug, "events");
  if (!fs.existsSync(eventsDir)) {
    throw new Error(`Story "${slug}" not found`);
  }

  const existing = fs
    .readdirSync(eventsDir)
    .filter((f) => f.endsWith(".json"));
  const id = `g${String(existing.length + 1).padStart(3, "0")}`;
  const fileSlug = generated.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);

  const event: StoryEvent = {
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

  fs.writeFileSync(
    path.join(eventsDir, `${id}-${fileSlug}.json`),
    JSON.stringify(event, null, 2) + "\n"
  );
  return event;
}
