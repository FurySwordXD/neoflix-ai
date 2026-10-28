import path from "path";
import { createFileStore } from "./storyStore/fileStore";
import { getDriver, neo4jConfigFromEnv } from "./storyStore/neo4j";
import { createNeo4jStore } from "./storyStore/neo4jStore";
import type { StoryListItem, StoryMeta, StoryPatch, StoryStore } from "./storyStore/types";
import type { GeneratedEvent, Story, StoryEvent } from "./types";

export type { StoryMeta, StoryListItem, StoryPatch } from "./storyStore/types";

/**
 * The app's story store. STORY_STORE picks where stories live: "file"
 * (default, JSON under DATA_DIR) or "neo4j" (the graph shared with
 * news-scraper). Media caches (voice-overs) always stay under DATA_DIR.
 */
export const DATA_DIR = path.join(process.cwd(), "src/data/stories");

export type StoreKind = "file" | "neo4j";
type Env = Record<string, string | undefined>;

export function storeKindFromEnv(env: Env = process.env): StoreKind {
  const value = (env.STORY_STORE ?? "").trim().toLowerCase() || "file";
  if (value === "file" || value === "neo4j") return value;
  throw new Error(`STORY_STORE must be "file" or "neo4j" (got "${env.STORY_STORE}").`);
}

/** Builds the store the env asks for. Throws a clear error when neo4j is selected but not configured. */
export function createStoryStore(env: Env = process.env, dataDir: string = DATA_DIR): StoryStore {
  if (storeKindFromEnv(env) === "file") return createFileStore(dataDir);
  const config = neo4jConfigFromEnv(env);
  return createNeo4jStore({ driver: getDriver(config), database: config.database });
}

const cache = globalThis as unknown as { __algonewsStoryStore?: StoryStore };

/** The process-wide store, built on first use. */
export function getStoryStore(): StoryStore {
  cache.__algonewsStoryStore ??= createStoryStore();
  return cache.__algonewsStoryStore;
}

/** Use this store for every call from now on (tests, scripts with a fake or temp store). */
export function setStoryStore(store: StoryStore): void {
  cache.__algonewsStoryStore = store;
}

/** Drop the cached store so the next call reads the env again. */
export function resetStoryStore(): void {
  cache.__algonewsStoryStore = undefined;
}

export function listStoryMetas(): Promise<StoryMeta[]> {
  return getStoryStore().listStoryMetas();
}

export function listStories(): Promise<StoryListItem[]> {
  return getStoryStore().listStories();
}

export function getStory(slug: string): Promise<Story | null> {
  return getStoryStore().getStory(slug);
}

/** Write a brand-new story. An already-saved slug returns the saved story untouched. */
export function saveNewStory(story: Story): Promise<Story> {
  return getStoryStore().saveNewStory(story);
}

/**
 * Append new events to a saved story, plus an optional meta patch (a refresh
 * that concluded the story, a closing epilogue). Returns the reloaded story.
 */
export function appendStoryEvents(slug: string, events: StoryEvent[], patch?: StoryPatch): Promise<Story> {
  return getStoryStore().appendStoryEvents(slug, events, patch);
}

/** Persist a generated event under the story's next `g###` id. */
export function saveGeneratedEvent(slug: string, generated: GeneratedEvent): Promise<StoryEvent> {
  return getStoryStore().saveGeneratedEvent(slug, generated);
}

/** Remember a query that resolved to this story so the same ask opens it next time. */
export function rememberQuery(slug: string, query: string): Promise<void> {
  return getStoryStore().rememberQuery(slug, query);
}
