import type { EventMotion, PoliticalLean, StoryEvent } from "../src/lib/types";

export const FPS = 30;

export interface VideoSource {
  id: string;
  publisher: string;
  politicalLean: PoliticalLean;
}

/** One story event, timed onto the video timeline. */
export interface VideoEvent {
  id: string;
  title: string;
  summary: string;
  timestamp: string;
  category: StoryEvent["category"];
  magnitude?: number;
  location: StoryEvent["location"];
  motion?: EventMotion;
  sources: VideoSource[];
  /** Spoken line, when a voice-over script has been generated. */
  script: string | null;
  /** Public-folder path of the narration mp3, or null when this event is silent. */
  audio: string | null;
  audioSeconds: number | null;
  from: number;
  durationInFrames: number;
}

export interface VideoManifest {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  hook?: string;
  epilogue?: string;
  status: "ongoing" | "concluded";
  startAt: string;
  endAt?: string;
  eventCount: number;
  narratedCount: number;
  relatedStories: Array<{ slug: string; title: string; relation: string }>;
  titleFrames: number;
  endFrames: number;
  audioDelayFrames: number;
  durationInFrames: number;
  events: VideoEvent[];
}
