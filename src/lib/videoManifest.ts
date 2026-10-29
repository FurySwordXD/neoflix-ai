import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { getStory } from "./stories";
import { getVoiceover } from "./voiceover";
import type { Story, StoryEvent } from "./types";
import type { VideoManifest } from "../../remotion/types";

/**
 * The video manifest, computed in-process from the story store and the
 * voice-over service. The browser's web-renderer consumes it directly: the
 * composition is played and encoded client-side, so nothing is staged on
 * disk and nothing is rendered server-side.
 */

const FPS = 30;
const TITLE_FRAMES = 4 * FPS;
const END_FRAMES = 4.5 * FPS;
const AUDIO_DELAY_FRAMES = 12;
const AUDIO_TAIL_FRAMES = 18;

function silentFrames(event: StoryEvent, script: string | null): number {
  const words = (script ?? event.summary ?? "").split(/\s+/).filter(Boolean).length;
  const seconds = Math.min(14, Math.max(5.5, words / 2.6));
  return Math.round(seconds * FPS);
}

/** Decodes an audio clip's duration from its bytes, wherever they came from. */
async function audioDurationSeconds(url: string): Promise<number | null> {
  try {
    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(bytes),
    });
    try {
      const seconds = await input.computeDuration();
      return Number.isFinite(seconds) ? seconds : null;
    } finally {
      input.dispose();
    }
  } catch {
    return null; // undecodable or unreachable clip: fall back to the silent estimate
  }
}

export async function buildVideoManifest(story: Story): Promise<VideoManifest> {
  const { slug, events: unsorted, ...meta } = story;
  const events = [...(unsorted ?? [])].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  if (events.length === 0) {
    throw new Error(`${slug} has no events`);
  }

  let cursor = TITLE_FRAMES;
  const staged = [];
  for (const event of events) {
    const vo = await getVoiceover(slug, event.id).catch(() => null);
    const script = vo?.script ?? event.narration ?? null;
    // The clip is served straight from Firebase Storage; null when it was
    // never generated or Firebase isn't configured for this deployment.
    const audioUrl = vo?.audioUrl ?? null;

    const audioSeconds = audioUrl ? await audioDurationSeconds(audioUrl) : null;
    const audioFrames = audioSeconds ? Math.ceil(audioSeconds * FPS) : 0;
    const durationInFrames = audioFrames
      ? AUDIO_DELAY_FRAMES + audioFrames + AUDIO_TAIL_FRAMES
      : silentFrames(event, script);

    staged.push({
      id: event.id,
      title: event.title,
      summary: event.summary,
      timestamp: event.timestamp,
      category: event.category,
      ...(event.magnitude ? { magnitude: event.magnitude } : {}),
      location: event.location,
      ...(event.motion ? { motion: event.motion } : {}),
      images: (event.images ?? []).slice(0, 2).map((image) => ({
        url: image.url,
        ...(image.caption ? { caption: image.caption } : {}),
      })),
      sources: (event.sources ?? []).map((source) => ({
        id: source.id,
        publisher: source.publisher,
        politicalLean: source.bias?.politicalLean ?? "mixed",
      })),
      script,
      audio: audioUrl,
      audioSeconds,
      from: cursor,
      durationInFrames,
    });
    cursor += durationInFrames;
  }

  return {
    slug,
    title: meta.title,
    subtitle: meta.subtitle,
    description: meta.description,
    ...(meta.hook ? { hook: meta.hook } : {}),
    ...(meta.epilogue ? { epilogue: meta.epilogue } : {}),
    status: meta.status,
    startAt: meta.startAt,
    ...(meta.endAt ? { endAt: meta.endAt } : {}),
    eventCount: staged.length,
    narratedCount: staged.filter((event) => event.audio).length,
    relatedStories: meta.relatedStories ?? [],
    titleFrames: TITLE_FRAMES,
    endFrames: END_FRAMES,
    audioDelayFrames: AUDIO_DELAY_FRAMES,
    durationInFrames: cursor + END_FRAMES,
    events: staged,
  };
}

/** Convenience wrapper used by the preview route. */
export async function buildVideoManifestForSlug(slug: string): Promise<VideoManifest | null> {
  const story = await getStory(slug);
  if (!story) return null;
  return buildVideoManifest(story);
}
