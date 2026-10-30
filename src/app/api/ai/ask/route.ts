import { NextRequest, NextResponse } from "next/server";
import { getNebiusClient, NEBIUS_ASK_MODEL } from "@/lib/nebius";
import {
  citationsFor,
  normalizeCitations,
  sanitizeHistory,
  sanitizeQuestion,
  stripThinking,
  type AskCitation,
} from "@/lib/ask";
import { getStory } from "@/lib/stories";
import type { Story } from "@/lib/types";

/**
 * Grounded Q&A over a story ("Ask the story"), answered by Nemotron Nano on
 * Nebius. The model may ONLY use the story events passed in the prompt and
 * must cite events by id like [e01].
 *
 * Chat history lives in the reader's browser: the client sends the recent
 * turns with each request and this route stays stateless. The answer
 * streams token-by-token as NDJSON so the chat reads as it is written.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** One line of the ask stream. */
type AskStreamMessage =
  | { type: "delta"; delta: string }
  | { type: "answer"; answer: string; citations: AskCitation[] }
  | { type: "error"; error: string };

/** The event records, one block per event, cited by id. */
function eventsContext(story: Story): string {
  return story.events
    .map((e) => {
      const sources = e.sources
        .map((s) => `${s.publisher} "${s.title}" (${s.publishedAt.slice(0, 10)})`)
        .join("; ");
      return `[${e.id}] ${e.timestamp.slice(0, 10)} — ${e.title} (${e.location.name}, ${e.location.country})\nSummary: ${e.summary}\nSources: ${sources}`;
    })
    .join("\n\n");
}

export async function POST(req: NextRequest) {
  let slug: unknown;
  let question: unknown;
  let history: unknown;
  try {
    const body = await req.json();
    slug = body?.slug;
    question = body?.question;
    history = body?.history;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const questionText = sanitizeQuestion(question);
  if (typeof slug !== "string" || !slug.trim() || !questionText) {
    return NextResponse.json(
      { error: "A story slug and a question are required." },
      { status: 400 }
    );
  }

  const story = await getStory(slug);
  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  const priorTurns = sanitizeHistory(history);

  const system = `You are a rigorous, strictly neutral news analyst embedded in an interactive story explorer.
Rules:
- Answer ONLY from the provided event records. NEVER introduce outside facts — not even as context, asides or corrections. If you know something relevant that is absent from the records, do not mention it; simply state the records do not cover it.
- Cite events inline using their ids exactly like [e01] or [g003], with no spaces inside the brackets. Every factual claim needs a citation. Your earlier answers in the conversation already use this form; keep it.
- The conversation may already cover part of the question; you may build on your earlier answers, but every claim still needs a citation from the records.
- Be factual and unopinionated. If the record supports multiple framings, present them side by side and note which sources lean which way.
- Keep answers under 200 words, vivid but never editorial.
- If the events do not contain the answer, say exactly that.
- Output only the answer text: no thinking, no markdown fences, no headings.`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Story: ${story.title}\n\nEvent records:\n\n${eventsContext(story)}\n\nThese records are the only facts you may use. The conversation with the reader follows; answer the final question.`,
    },
    ...priorTurns,
    { role: "user", content: questionText },
  ];

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: AskStreamMessage) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
        } catch {
          // The client already went away.
        }
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

      let answer = "";
      try {
        const client = getNebiusClient();
        const completion = await client.chat.completions.create({
          model: NEBIUS_ASK_MODEL,
          temperature: 0.2,
          stream: true,
          messages,
        });

        // Stream the visible text as it arrives, holding back anything the
        // model emits inside a thinking block.
        let inText = false;
        let visible = "";
        for await (const chunk of completion) {
          const delta: string = chunk.choices[0]?.delta?.content ?? "";
          if (!delta) continue;
          if (!inText) {
            const merged = stripThinking(visible + delta);
            if (!merged) continue; // still inside (or opening) a think block
            inText = true;
            visible = merged;
          } else {
            visible += delta;
          }
          const emit = visible.slice(answer.length);
          if (emit) {
            answer = visible;
            send({ type: "delta", delta: emit });
          }
        }

        // The stream may end mid-block or trail with whitespace; trust the
        // fully stripped text over what the incremental pass emitted.
        const finalText = normalizeCitations(stripThinking(visible));
        if (finalText.startsWith(answer)) {
          const tail = finalText.slice(answer.length);
          if (tail) {
            answer = finalText;
            send({ type: "delta", delta: tail });
          }
        } else {
          // The incremental pass mis-split the text (rare); replace it.
          answer = finalText;
          send({ type: "answer", answer, citations: citationsFor(story, answer) });
          finish();
          return;
        }

        if (!answer.trim()) throw new Error("The model returned an empty answer.");

        send({ type: "answer", answer, citations: citationsFor(story, answer) });
      } catch (err) {
        if (req.signal.aborted) {
          finish();
          return;
        }
        const message = err instanceof Error ? err.message : "AI request failed";
        send({ type: "error", error: message });
      }
      finish();
    },
    cancel() {
      closed = true;
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
