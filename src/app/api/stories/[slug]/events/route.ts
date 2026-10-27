import { NextRequest, NextResponse } from "next/server";
import { getStory, saveGeneratedEvent } from "@/lib/stories";
import type { GeneratedEvent } from "@/lib/types";

/**
 * Persist AI-generated events into the story's JSON store.
 * The graph-DB hook replaces saveGeneratedEvent later; the API stays.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!getStory(slug)) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  const { events } = await req.json();
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "events array required" }, { status: 400 });
  }

  try {
    const saved = (events as GeneratedEvent[]).map((e) =>
      saveGeneratedEvent(slug, e)
    );
    const story = getStory(slug);
    return NextResponse.json({ saved, story }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save events";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
