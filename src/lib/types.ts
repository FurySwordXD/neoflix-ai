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
  sources: SourceRef[];
}

export interface Story {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  status: "ongoing" | "concluded";
  startAt: string;
  endAt?: string;
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
