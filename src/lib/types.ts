/**
 * WorldNews core data model.
 *
 * A Story is a sequence of Events. Every Event is grounded: it has a
 * timestamp, a geo-location, and a list of SourceRefs. Every SourceRef
 * carries a bias classification so the reader can weigh the reporting
 * themselves — summaries stay factual and unopinionated on purpose.
 */

export type PoliticalLean =
  | "left"
  | "lean-left"
  | "center"
  | "lean-right"
  | "right"
  | "mixed";

export type FactualRating =
  | "very-high"
  | "high"
  | "mostly-factual"
  | "mixed"
  | "low"
  | "very-low";

export interface BiasClassification {
  /** Perceived editorial / partisan leaning of the outlet. */
  politicalLean: PoliticalLean;
  /** Track record for factual reporting (MBFC-style scale). */
  factualRating: FactualRating;
  /** Short neutral note on why this classification was applied. */
  note?: string;
}

export interface SourceRef {
  id: string;
  publisher: string;
  title: string;
  url: string;
  /** ISO 8601 date the source was published. */
  publishedAt: string;
  bias: BiasClassification;
  /** Which factual claims in the event this source backs up. */
  corroborates?: string[];
}

export interface GeoLocation {
  name: string;
  country: string;
  lat: number;
  lng: number;
}

/** A named point on a map animation. Country is omitted; the event place already has one. */
export interface MapPlace {
  name: string;
  lat: number;
  lng: number;
}

/**
 * How an event plays on the globe. Omitted when a single marker already
 * tells the story (a speech, a vote, a signing).
 */
export type MotionActor =
  | "troops"
  | "people"
  | "ships"
  | "aircraft"
  | "goods"
  | "aid"
  | "disease"
  | "news";

export type EventMotion = (
  | { kind: "spread"; radius: number }
  | { kind: "impact" }
  | { kind: "flow"; from: MapPlace; to: MapPlace }
  | { kind: "path"; points: MapPlace[] }
  | { kind: "converge"; from: MapPlace[] }
  | { kind: "radiate"; to: MapPlace[] }
  /** Two-way traffic: trade, talks, swaps, a shuttle of aid. */
  | { kind: "exchange"; with: MapPlace }
  /** Surrounded from every side: a siege, blockade, cordon, or lockdown. */
  | { kind: "encircle"; radius: number }
  /** High arc through the air or space: missiles, rockets, airlifts, flights. */
  | { kind: "launch"; to: MapPlace }
  /** Directional push across an area: a storm track, plume, wave, or offensive. */
  | { kind: "sweep"; heading: number; radius: number }
) & { actor?: MotionActor };

export interface StoryEvent {
  id: string;
  title: string;
  /** Unopinionated, fact-first summary. Keep it vivid, never editorial. */
  summary: string;
  location: GeoLocation;
  /** ISO 8601 timestamp. */
  timestamp: string;
  category: "outbreak" | "response" | "science" | "politics" | "economy" | "milestone";
  /** Optional intensity figure used to size the globe marker (e.g. cases). */
  magnitude?: number;
  /** Spatial action the globe animates, when the event can be illustrated that way. */
  motion?: EventMotion;
  /** Where this event sits in the story's arc. */
  beat?: StoryBeat;
  /** Documented consequence that carries the reader into the next event. */
  consequence?: string;
  /** Documentary voice-over for this beat: picks up from the last one and moves the story on. */
  narration?: string;
  sources: SourceRef[];
}

export type StoryBeat =
  | "setup"
  | "spark"
  | "escalation"
  | "turning-point"
  | "climax"
  | "fallout"
  | "now";

export interface Story {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  status: "ongoing" | "concluded";
  startAt: string;
  endAt?: string;
  /** Cold open: the narrator's first lines, before the first event. */
  hook?: string;
  /** Closing narration: what it all meant, or what is still unresolved. */
  epilogue?: string;
  events: StoryEvent[];
  /** Queries that already resolved to this story, so the next ask opens it. */
  queries?: string[];
  /** Links to other tracked stories — the graph edges of the news graph. */
  relatedStories: Array<{
    slug: string;
    title: string;
    relation: string;
  }>;
}

/** Enriched runtime view of an event, e.g. after AI generation. */
export interface GeneratedEvent extends Omit<StoryEvent, "sources"> {
  sources: Array<
    Pick<SourceRef, "publisher" | "title" | "url" | "publishedAt"> &
      Partial<Pick<SourceRef, "bias" | "corroborates">>
  >;
}
