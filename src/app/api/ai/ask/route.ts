import { NextRequest, NextResponse } from "next/server";
import { getStory } from "@/lib/stories";
import { getNebiusClient, NEBIUS_MODEL } from "@/lib/nebius";
import type { SourceRef } from "@/lib/types";

/**
 * Grounded Q&A over a story. The model may ONLY use the story events
 * passed in the prompt and must cite events by id.
 */
export async function POST(req: NextRequest) {
  const { slug, question } = await req.json();
  if (typeof slug !== "string" || typeof question !== "string") {
    return NextResponse.json({ error: "slug and question are required" }, { status: 400 });
  }

  const story = await getStory(slug);
  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  const eventsContext = story.events
    .map((e) => {
      const sources = e.sources
        .map((s) => `${s.publisher} "${s.title}" (${s.publishedAt.slice(0, 10)})`)
        .join("; ");
      return `[${e.id}] ${e.timestamp.slice(0, 10)} — ${e.title} (${e.location.name}, ${e.location.country})\nSummary: ${e.summary}\nSources: ${sources}`;
    })
    .join("\n\n");

  const system = `You are a rigorous, strictly neutral news analyst embedded in an interactive story explorer.
Rules:
- Answer ONLY from the provided event records. NEVER introduce outside facts — not even as context, asides or corrections. If you know something relevant that is absent from the records, do not mention it; simply state the records do not cover it.
- Cite events inline using their ids like [e01] or [e06]. Every factual claim needs a citation.
- Be factual and unopinionated. If the record supports multiple framings, present them side by side and note which sources lean which way.
- Keep answers under 200 words, vivid but never editorial.
- If the events do not contain the answer, say exactly that.`;

  try {
    const client = getNebiusClient();
    const completion = await client.chat.completions.create({
      model: NEBIUS_MODEL,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Story: ${story.title}\n\nEvent records:\n\n${eventsContext}\n\nQuestion: ${question}`,
        },
      ],
      temperature: 0.2,
    });

    const answer = completion.choices[0]?.message?.content ?? "";

    // Collect cited events + their sources so the UI can show attribution.
    const citedIds = Array.from(new Set(answer.match(/\[(e\d+|g\d+)\]/g) ?? [])).map(
      (m) => m.slice(1, -1)
    );
    const citations = story.events
      .filter((e) => citedIds.includes(e.id))
      .map((e) => ({
        eventId: e.id,
        title: e.title,
        timestamp: e.timestamp,
        sources: e.sources.map((s: SourceRef) => ({
          id: s.id,
          publisher: s.publisher,
          title: s.title,
          url: s.url,
          bias: s.bias,
        })),
      }));

    return NextResponse.json({ answer, citations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
