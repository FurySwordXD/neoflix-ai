import type { Story, StoryEvent } from "./types";
import type { StoryStreamMessage, StoryStreamMeta } from "./storyStream";

export interface StoryStreamHandlers {
  signal?: AbortSignal;
  onMeta?: (meta: StoryStreamMeta) => void;
  onEvent?: (event: StoryEvent) => void | Promise<void>;
  onStep?: (step: string) => void;
  onStory?: (story: Story, created: boolean) => void | Promise<void>;
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
    let message = "Could not open that story";
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === "string" && data.error.trim()) message = data.error;
    } catch {
      // The error body was not JSON.
    }
    throw new Error(message);
  }

  if (!res.body) throw new Error("Could not open that story");

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
    await handlers.onStory?.(message.story, created);
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
