import type { StoryStreamMessage } from "./storyStream";

/**
 * Wrap an async generator of story-stream messages as a chunked NDJSON
 * response: one JSON message per line, flushed as it is produced. Shared by
 * every endpoint that streams story progress to the client.
 */
export function ndjsonResponse(
  generator: AsyncGenerator<StoryStreamMessage>,
  signal: AbortSignal
): Response {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: StoryStreamMessage) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };

      try {
        for await (const message of generator) {
          send(message);
        }
        finish();
      } catch (err) {
        if (signal.aborted) {
          finish();
          return;
        }
        const message = err instanceof Error ? err.message : "Could not create that story";
        try {
          send({ type: "error", error: message });
        } catch {
          // The client already went away.
        }
        finish();
      }
    },
    cancel() {
      closed = true;
      void generator.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
