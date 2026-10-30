"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  MAX_QUESTION_CHARS,
  type AskCitation,
  type AskTurn,
} from "./ask";

/**
 * Ask-the-story chat history, kept in the reader's browser (localStorage),
 * one thread per story slug. The server stays stateless: the client sends
 * the recent turns with each request and the server never stores them.
 */

const KEY_PREFIX = "worldnews.ask.v1:";
/** Store at most this many turns per story, dropping the oldest first. */
const MAX_TURNS_PER_STORY = 40;
/** Longest turn text kept, so a corrupted entry cannot balloon storage. */
const MAX_TURN_CHARS = 4000;

function keyFor(slug: string): string {
  return KEY_PREFIX + slug;
}

const ASK_EVENT = "worldnews-ask-history";

function subscribe(listener: () => void): () => void {
  window.addEventListener(ASK_EVENT, listener);
  // Another tab writing the same thread should appear here too.
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(ASK_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function getServerSnapshot(): string {
  return "";
}

/** Parse and validate raw storage text into turns, throwing away junk. */
export function parseTurns(raw: string | null): AskTurn[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const turns: AskTurn[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const turn = item as Partial<AskTurn>;
    if (
      (turn.role !== "user" && turn.role !== "assistant") ||
      typeof turn.id !== "string" ||
      !turn.id ||
      typeof turn.content !== "string" ||
      !turn.content.trim() ||
      typeof turn.at !== "number" ||
      !Number.isFinite(turn.at)
    ) {
      continue;
    }
    turns.push({
      id: turn.id,
      role: turn.role,
      content: turn.content.slice(0, MAX_TURN_CHARS),
      ...(Array.isArray(turn.citations) ? { citations: turn.citations as AskCitation[] } : {}),
      at: turn.at,
    });
  }
  return turns;
}

function writeTurns(slug: string, turns: AskTurn[]): void {
  const key = keyFor(slug);
  if (turns.length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(turns));
  window.dispatchEvent(new Event(ASK_EVENT));
}

/**
 * The chat thread for one story: the stored turns, plus append and clear
 * actions that write back to the same thread in localStorage.
 */
export function useAskHistory(
  slug: string
): [
  AskTurn[],
  {
    append: (turn: AskTurn) => void;
    clear: () => void;
  },
] {
  const getSnapshot = useCallback(() => {
    try {
      return localStorage.getItem(keyFor(slug)) ?? "";
    } catch {
      return "";
    }
  }, [slug]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const turns = useMemo(() => parseTurns(raw), [raw]);

  const append = useCallback(
    (turn: AskTurn) => {
      try {
        const current = parseTurns(localStorage.getItem(keyFor(slug)));
        writeTurns(slug, [...current, turn].slice(-MAX_TURNS_PER_STORY));
      } catch {
        // Storage is full or blocked; the chat still works this session.
      }
    },
    [slug]
  );

  const clear = useCallback(() => {
    try {
      writeTurns(slug, []);
    } catch {
      // Same as above: never let storage break the chat.
    }
  }, [slug]);

  return [turns, { append, clear }];
}

/** A fresh, unique turn id for the client store. */
export function newTurnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove every stored chat thread at once. */
export function clearAllAskHistory(): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(KEY_PREFIX)) doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
  window.dispatchEvent(new Event(ASK_EVENT));
}

/** Question box cap, re-exported so the UI can hint at the limit. */
export { MAX_QUESTION_CHARS };
