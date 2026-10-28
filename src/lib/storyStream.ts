import type { Story, StoryEvent } from "./types";

/** Fields the model has closed so far. Missing fields are still being written. */
export interface StoryStreamMeta {
  title?: string;
  subtitle?: string;
  description?: string;
  status?: "ongoing" | "concluded";
  hook?: string;
}

export type StoryStreamMessage =
  | { type: "meta"; meta: StoryStreamMeta }
  | { type: "event"; event: StoryEvent }
  | { type: "step"; step: string }
  | { type: "cached"; story: Story }
  /** `added` counts events an update pass appended; omitted for a fresh compile. */
  | { type: "done"; story: Story; created: boolean; added?: number }
  | { type: "error"; error: string };

export interface StoryJsonProgress {
  error: string | null;
  meta: {
    title: string | null;
    subtitle: string | null;
    description: string | null;
    status: "ongoing" | "concluded" | null;
    hook: string | null;
  };
  events: unknown[];
}

/** Drop an unclosed thinking block, then keep the JSON object. */
export function visibleJson(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const thinkAt = text.search(/<think>/i);
  if (thinkAt >= 0) {
    const braceAt = text.indexOf("{");
    if (braceAt < 0 || thinkAt < braceAt) return "";
    text = text.slice(0, thinkAt);
  }
  text = text.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  return start >= 0 ? text.slice(start) : "";
}

function readJsonString(source: string, quoteAt: number): string | null {
  if (source[quoteAt] !== '"') return null;
  let escape = false;
  for (let i = quoteAt + 1; i < source.length; i++) {
    const char = source[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      try {
        return JSON.parse(source.slice(quoteAt, i + 1)) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** First closed string value for a key, ignoring keys that appear inside strings. */
function readField(json: string, field: string): string | null {
  const needle = `"${field}"`;
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char !== '"') continue;
    if (json.startsWith(needle, i)) {
      let cursor = i + needle.length;
      while (cursor < json.length && /\s/.test(json[cursor])) cursor++;
      if (json[cursor] === ":") {
        cursor++;
        while (cursor < json.length && /\s/.test(json[cursor])) cursor++;
        if (json[cursor] !== '"') return null;
        return readJsonString(json, cursor);
      }
    }
    inString = true;
  }
  return null;
}

/** Index of the `[` that opens the events array, or -1 if it has not started. */
function eventsArrayStart(json: string): number {
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char !== '"') continue;
    if (json.startsWith('"events"', i)) {
      let cursor = i + '"events"'.length;
      while (cursor < json.length && /\s/.test(json[cursor])) cursor++;
      if (json[cursor] === ":") {
        cursor++;
        while (cursor < json.length && /\s/.test(json[cursor])) cursor++;
        return json[cursor] === "[" ? cursor : -1;
      }
    }
    inString = true;
  }
  return -1;
}

function objectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractEventObjects(json: string, arrayStart: number): unknown[] {
  const events: unknown[] = [];
  let cursor = arrayStart + 1;
  while (cursor < json.length) {
    while (cursor < json.length && /[\s,]/.test(json[cursor])) cursor++;
    if (cursor >= json.length || json[cursor] === "]") break;
    if (json[cursor] !== "{") break;
    const end = objectEnd(json, cursor);
    if (end < 0) break;
    try {
      events.push(JSON.parse(json.slice(cursor, end + 1)));
    } catch {
      // One malformed event should not hide the ones after it.
    }
    cursor = end + 1;
  }
  return events;
}

/**
 * Read whatever story JSON has finished arriving.
 * Header fields are taken from the text before the events array so an event
 * title cannot be mistaken for the story title.
 */
export function extractStoryProgress(raw: string): StoryJsonProgress {
  const json = visibleJson(raw);
  const empty: StoryJsonProgress = {
    error: null,
    meta: { title: null, subtitle: null, description: null, status: null, hook: null },
    events: [],
  };
  if (!json) return empty;

  const arrayAt = eventsArrayStart(json);
  const header = arrayAt >= 0 ? json.slice(0, arrayAt) : json;
  const statusRaw = readField(header, "status");
  const status = statusRaw === "ongoing" || statusRaw === "concluded" ? statusRaw : null;

  return {
    error: readField(header, "error"),
    meta: {
      title: readField(header, "title"),
      subtitle: readField(header, "subtitle"),
      description: readField(header, "description"),
      status,
      hook: readField(header, "hook"),
    },
    events: arrayAt >= 0 ? extractEventObjects(json, arrayAt) : [],
  };
}
