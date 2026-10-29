import type { GeneratedEvent, Story, StoryEvent } from "../types";

/**
 * A story record without its events: enough to match a query. Graph-backed
 * stores also report when the story was first saved and last refreshed.
 */
export type StoryMeta = Omit<Story, "events"> & {
  createdAt?: string;
  refreshedAt?: string;
};

export type StoryListItem = Pick<Story, "slug" | "title" | "subtitle" | "status" | "startAt" | "endAt">;

/** Meta changes a refresh may carry: the story concluded, or got a closing epilogue. */
export interface StoryPatch {
  status?: "ongoing" | "concluded";
  epilogue?: string;
}

/**
 * Where stories live. Every implementation keeps the same semantics, so the
 * app can switch between JSON files and the shared Neo4j graph by config.
 */
export interface StoryStore {
  /** Story records without their events. */
  listStoryMetas(): Promise<StoryMeta[]>;
  listStories(): Promise<StoryListItem[]>;
  /** The full story with events sorted by timestamp, or null if it is not saved. */
  getStory(slug: string): Promise<Story | null>;
  /** Write a brand-new story. An already-saved slug returns the saved story untouched. */
  saveNewStory(story: Story): Promise<Story>;
  /**
   * Append events to a saved story, demoting the old "now" beat, and apply an
   * optional meta patch. Returns the reloaded story. Throws if it is not saved.
   */
  appendStoryEvents(slug: string, events: StoryEvent[], patch?: StoryPatch): Promise<Story>;
  /** Persist one generated event under the next `g###` id. Throws if it is not saved. */
  saveGeneratedEvent(slug: string, generated: GeneratedEvent): Promise<StoryEvent>;
  /** Remember a query that resolved to this story so the same ask opens it next time. */
  rememberQuery(slug: string, query: string): Promise<void>;
  /**
   * Remove a saved story and all its events. A missing slug is a silent no-op,
   * so deletes stay idempotent. Media caches are the caller's concern.
   */
  deleteStory(slug: string): Promise<void>;
}
