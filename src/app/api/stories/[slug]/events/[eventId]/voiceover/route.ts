import { NextRequest, NextResponse } from "next/server";
import { getStory } from "@/lib/stories";
import { fallbackScript, getVoiceover } from "@/lib/voiceover";

// Nebius + ElevenLabs + Firebase upload for one clip can exceed 10s.
export const maxDuration = 60;

/** Returns the event's narration script and its Firebase Storage clip URL. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; eventId: string }> }
) {
  const { slug, eventId } = await params;
  try {
    const voiceover = await getVoiceover(slug, eventId);
    if (!voiceover) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json({
      script: voiceover.script,
      audioUrl: voiceover.audioUrl,
    });
  } catch (err) {
    // A model or Storage outage still serves narration: the browser TTS
    // reads the event's own text instead of the player erroring out.
    console.error("Voice-over failed:", err instanceof Error ? err.message : err);
    const event = (await getStory(slug).catch(() => null))?.events.find((e) => e.id === eventId);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json({ script: fallbackScript(event), audioUrl: null });
  }
}
