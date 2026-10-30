import type { AskCitation, AskHistoryMessage } from "./ask";

/**
 * Read the ask-story NDJSON stream: `delta` messages as the answer is
 * written, then the canonical `answer` (with citations), or `error`.
 */

export interface AskAnswer {
  answer: string;
  citations: AskCitation[];
}

export interface AskStreamParams {
  slug: string;
  question: string;
  history: AskHistoryMessage[];
  signal?: AbortSignal;
}

type AskStreamMessage =
  | { type: "delta"; delta: string }
  | { type: "answer"; answer: string; citations?: AskCitation[] }
  | { type: "error"; error: string };

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    // The error body was not JSON.
  }
  return fallback;
}

/**
 * Ask a story a question. Deltas stream through `onDelta` as they arrive;
 * the promise resolves with the canonical answer and its citations — which
 * may differ from the streamed text, so always render the resolved value.
 */
export async function streamAsk(
  params: AskStreamParams,
  onDelta: (delta: string) => void
): Promise<AskAnswer> {
  const res = await fetch("/api/ai/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({
      slug: params.slug,
      question: params.question,
      history: params.history,
    }),
    signal: params.signal,
  });

  if (!res.ok) {
    throw new Error(await errorMessage(res, "The story could not answer that."));
  }
  if (!res.body) throw new Error("Could not read the answer stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled: AskAnswer | null = null;

  const take = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: AskStreamMessage;
    try {
      message = JSON.parse(trimmed) as AskStreamMessage;
    } catch {
      throw new Error("Could not read the answer stream.");
    }
    if (message.type === "delta") {
      onDelta(message.delta);
      return;
    }
    if (message.type === "error") {
      throw new Error(message.error);
    }
    settled = { answer: message.answer, citations: message.citations ?? [] };
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) take(line);
  }

  buffer += decoder.decode();
  if (buffer.trim()) take(buffer);
  if (!settled) throw new Error("The answer stopped before it finished.");
  return settled;
}
