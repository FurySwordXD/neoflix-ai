import type { StoryStore } from "./types";

export interface ImportResult {
  imported: number;
  skipped: number;
}

/** Copy every story from one store into another. Stories already in `to` are left untouched. */
export async function importStories(from: StoryStore, to: StoryStore): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  for (const meta of await from.listStoryMetas()) {
    if (await to.getStory(meta.slug)) {
      skipped += 1;
      continue;
    }
    const story = await from.getStory(meta.slug);
    if (!story) throw new Error(`Story "${meta.slug}" disappeared during import`);
    await to.saveNewStory(story);
    imported += 1;
  }
  return { imported, skipped };
}
