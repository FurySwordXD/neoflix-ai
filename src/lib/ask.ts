import type { BiasClassification, SourceRef, Story, StoryEvent } from "./types";

/**
 * Grounded story Q&A ("Ask the story"): pure helpers shared by the ask API
 * route, the browser history store, and tests. Everything here must stay
 * side-effect free.
 */

/** One earlier conversation turn the client sends back for follow-ups. */
export interface AskHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** A source as the ask UI shows it: enough for a labelled link. */
export interface AskSourceRef extends Pick<SourceRef, "publisher" | "title" | "url"> {
  id: string;
  bias: BiasClassification;
}

/** An event an answer cited, with the sources backing it. */
export interface AskCitation {
  eventId: string;
  title: string;
  timestamp: string;
  sources: AskSourceRef[];
}

/** One message of a story chat, as kept in the reader's browser. */
export interface AskTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant turns only: the events the answer cited. */
  citations?: AskCitation[];
  /** When the turn was written, ms since the epoch. */
  at: number;
}

/** A citation marker in canonical form: `[e01]`, `[g003]`. */
export const CANONICAL_CITATION = /\[(e\d{2}|g\d{3})\]/;
/** `[ e01 ]`, `[E1]`, `[ g12 ]` … — the marker shapes Nemotron tends to emit. */
const CITATION_MARKER = /\[\s*([egEG])\s*(\d+)\s*\]/g;

/** Event ids are `e01` (two digits) and `g001` (three). */
function canonicalId(kind: string, digits: string): string {
  const width = kind.toLowerCase() === "g" ? 3 : 2;
  return `${kind.toLowerCase()}${digits.padStart(width, "0")}`;
}

/** Rewrite every citation marker into its canonical `[e01]` form. */
export function normalizeCitations(text: string): string {
  return text.replace(CITATION_MARKER, (_match, kind: string, digits: string) => {
    return `[${canonicalId(kind, digits)}]`;
  });
}

/** Event ids cited in an answer, deduped, in order of first mention. */
export function citedEventIds(answer: string): string[] {
  const ids: string[] = [];
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const id = canonicalId(match[1], match[2]);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The events an answer cites, in order of first mention, with their sources. */
export function citationsFor(story: Story, answer: string): AskCitation[] {
  const byId = new Map(story.events.map((event) => [event.id, event]));
  return citedEventIds(answer)
    .map((id) => byId.get(id))
    .filter((event): event is StoryEvent => event !== undefined)
    .map((event) => ({
      eventId: event.id,
      title: event.title,
      timestamp: event.timestamp,
      sources: event.sources.map(
        (s): AskSourceRef => ({
          id: s.id,
          publisher: s.publisher,
          title: s.title,
          url: s.url,
          bias: s.bias,
        })
      ),
    }));
}

/** Drop closed thinking blocks, cut an unclosed one, then trim. */
export function stripThinking(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/** Longest question the route accepts. */
export const MAX_QUESTION_CHARS = 500;
/** Most recent messages the client may send back, keeping the prompt bounded. */
export const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;

/** The question, trimmed and capped, or null when there is nothing usable. */
export function sanitizeQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_QUESTION_CHARS);
}

/**
 * The conversation the client sent back, made safe for the prompt: only
 * user/assistant turns with non-empty text, content capped, markers
 * canonicalized, and only the most recent messages kept.
 */
export function sanitizeHistory(raw: unknown): AskHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const turns: AskHistoryMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    turns.push({
      role,
      content: normalizeCitations(content.trim().slice(0, MAX_MESSAGE_CHARS)),
    });
  }
  return turns.slice(-MAX_HISTORY_MESSAGES);
}
