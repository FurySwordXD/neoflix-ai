import type { Story, StoryEvent } from "./types";
import type { StoryStreamMessage, StoryStreamMeta } from "./storyStream";

export interface StoryStreamHandlers {
  signal?: AbortSignal;
  onMeta?: (meta: StoryStreamMeta) => void;
  onEvent?: (event: StoryEvent) => void | Promise<void>;
  onStep?: (step: string) => void;
  /** `added` counts the events an update appended (0 for a fresh compile). */
  onStory?: (story: Story, created: boolean, added: number) => void | Promise<void>;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    // The error body was not JSON.
  }
  return fallback;
}

/** Read an NDJSON story stream to completion, dispatching each message. */
async function consumeStream(
  res: Response,
  handlers: StoryStreamHandlers
): Promise<void> {
  if (!res.body) throw new Error("Could not read the story stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;

  const handle = async (message: StoryStreamMessage) => {
    if (message.type === "meta") {
      handlers.onMeta?.(message.meta);
      return;
    }
    if (message.type === "event") {
      await handlers.onEvent?.(message.event);
      return;
    }
    if (message.type === "step") {
      handlers.onStep?.(message.step);
      return;
    }
    if (message.type === "error") throw new Error(message.error);
    settled = true;
    const created = message.type === "done" ? message.created : false;
    const added = message.type === "done" ? (message.added ?? 0) : 0;
    await handlers.onStory?.(message.story, created, added);
  };

  const take = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: StoryStreamMessage;
    try {
      message = JSON.parse(trimmed) as StoryStreamMessage;
    } catch {
      throw new Error("Could not read the story stream.");
    }
    await handle(message);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) await take(line);
  }

  buffer += decoder.decode();
  if (buffer.trim()) await take(buffer);
  if (!settled) throw new Error("The story stopped before it finished.");
}

/**
 * Read the story-generation stream. Resolves when a saved or cached story
 * arrives. Rejects with the server's error message otherwise.
 */
export async function readStoryStream(
  query: string,
  handlers: StoryStreamHandlers
): Promise<void> {
  const res = await fetch("/api/stories", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({ query }),
    signal: handlers.signal,
  });

  if (!res.ok) {
    throw new Error(await errorMessage(res, "Could not open that story"));
  }

  await consumeStream(res, handlers);
}

/**
 * Read a story refresh stream: the saved story catches up on the latest
 * news, streaming each new event before the updated story arrives.
 */
export async function readStoryRefresh(
  slug: string,
  handlers: StoryStreamHandlers
): Promise<void> {
  const res = await fetch(`/api/stories/${encodeURIComponent(slug)}/refresh`, {
    method: "POST",
    headers: { Accept: "application/x-ndjson" },
    signal: handlers.signal,
  });

  if (!res.ok) {
    throw new Error(await errorMessage(res, "Could not refresh that story"));
  }

  await consumeStream(res, handlers);
}
