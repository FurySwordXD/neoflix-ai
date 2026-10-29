import { NextRequest, NextResponse } from "next/server";
import { getVoiceover } from "@/lib/voiceover";

/** Returns the event's narration script, generating script + audio on first use. */
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
    // Prefer the public Firebase download URL; fall back to the local proxy.
    const audioUrl =
      voiceover.audioUrl ??
      (voiceover.audioVersion
        ? `/api/stories/${slug}/events/${eventId}/voiceover/audio?v=${voiceover.audioVersion}`
        : null);
    return NextResponse.json({
      script: voiceover.script,
      audioUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice-over failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
