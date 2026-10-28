import type {
  FactualRating,
  PoliticalLean,
  StoryBeat,
  StoryEvent,
} from "./types";

/** Category → marker color on the globe and timeline. */
export const CATEGORY_COLORS: Record<StoryEvent["category"], string> = {
  outbreak: "#ef4444",
  response: "#f59e0b",
  science: "#22d3ee",
  politics: "#a855f7",
  economy: "#84cc16",
  milestone: "#fbbf24",
};

export const CATEGORY_LABELS: Record<StoryEvent["category"], string> = {
  outbreak: "Outbreak",
  response: "Response",
  science: "Science",
  politics: "Politics",
  economy: "Economy",
  milestone: "Milestone",
};

/** Act names for the story's arc, shown as chapter headers on the timeline. */
export const BEAT_LABELS: Record<StoryBeat, string> = {
  setup: "The setup",
  spark: "The spark",
  escalation: "Escalation",
  "turning-point": "Turning point",
  climax: "Climax",
  fallout: "Aftermath",
  now: "Where it stands",
};

/** US political-spectrum convention: blue left, red right. */
export const LEAN_COLORS: Record<PoliticalLean, string> = {
  left: "#3b82f6",
  "lean-left": "#60a5fa",
  center: "#94a3b8",
  "lean-right": "#f87171",
  right: "#ef4444",
  mixed: "#a855f7",
};

export const LEAN_LABELS: Record<PoliticalLean, string> = {
  left: "Left",
  "lean-left": "Lean Left",
  center: "Center",
  "lean-right": "Lean Right",
  right: "Right",
  mixed: "Mixed / State",
};

const FACTUAL_SCORES: Record<FactualRating, number> = {
  "very-high": 5,
  high: 4,
  "mostly-factual": 3,
  mixed: 2,
  low: 1,
  "very-low": 0,
};

export function factualScore(rating: FactualRating): number {
  return FACTUAL_SCORES[rating] ?? 0;
}

export function factualLabel(rating: FactualRating): string {
  return rating
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Point radius for the globe, log-scaled from the event magnitude. */
export function magnitudeToRadius(event: StoryEvent): number {
  if (!event.magnitude) return 0.45;
  return 0.35 + Math.log10(event.magnitude + 1) * 0.32;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatMagnitude(magnitude?: number): string {
  if (!magnitude) return "";
  if (magnitude >= 1e9) return `${(magnitude / 1e9).toFixed(1)}B`;
  if (magnitude >= 1e6) return `${(magnitude / 1e6).toFixed(1)}M`;
  if (magnitude >= 1e3) return `${(magnitude / 1e3).toFixed(1)}K`;
  return `${magnitude}`;
}
