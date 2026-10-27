import { NextRequest, NextResponse } from "next/server";
import { generateStoryStream } from "@/lib/generateStory";
import { listStories } from "@/lib/stories";
import type { StoryStreamMessage } from "@/lib/storyStream";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ stories: listStories() });
}

/**
 * Open a saved story for this query, or generate one.
 * The body is newline-delimited JSON: meta, then one message per event,
 * then the saved story.
 */
export async function POST(req: NextRequest) {
  let query = "";
  try {
    const body = await req.json();
    query = typeof body?.query === "string" ? body.query.trim() : "";
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (query.length < 2 || query.length > 200) {
    return NextResponse.json(
      { error: "Enter a story topic, from a couple of words up to a sentence." },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const generator = generateStoryStream(query, req.signal);
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
        if (req.signal.aborted) {
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
