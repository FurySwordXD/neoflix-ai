import { NextRequest, NextResponse } from "next/server";
import { getStory } from "@/lib/stories";
import { getVoiceover } from "@/lib/voiceover";

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Generates every event's voice-over, one clip at a time. Clips are cached
 * (and mirrored to Firebase Storage) per event, so repeat calls are cheap
 * and only missing clips are synthesized.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  try {
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }
    const story = await getStory(slug);
    if (!story) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }
    // One at a time: ElevenLabs rate-limits concurrent synthesis, so the
    // batch must not fire every clip at once. One failure must not sink
    // the batch either: a clip that can't be written still reports as null
    // and falls back to browser speech synthesis.
    const voiceovers = [];
    for (const event of story.events) {
      const vo = await getVoiceover(slug, event.id)
        .then((result) => ({
          eventId: event.id,
          script: result?.script ?? null,
          audioUrl: result?.audioUrl ?? null,
        }))
        .catch(() => ({ eventId: event.id, script: null, audioUrl: null }));
      voiceovers.push(vo);
    }
    return NextResponse.json({ voiceovers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice-over failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
