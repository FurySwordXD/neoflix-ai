import { NextRequest, NextResponse } from "next/server";
import { getStory } from "@/lib/stories";
import { fallbackScript, getVoiceover } from "@/lib/voiceover";
const SLUG_RE = /^[a-z0-9-]+$/;

// Nebius + ElevenLabs + Firebase uploads for every event, one at a time.
export const maxDuration = 300;

/**
 * Generates every event's voice-over, one clip at a time. Clips live in
 * Firebase Storage per event, so repeat calls are cheap and only missing
 * clips are synthesized.
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
    // the batch either: a clip that can't be built still reports its script
    // (event text) and a null URL for browser speech synthesis.
    const voiceovers = [];
    for (const event of story.events) {
      const vo = await getVoiceover(slug, event.id)
        .then((result) => ({
          eventId: event.id,
          script: result?.script ?? fallbackScript(event),
          audioUrl: result?.audioUrl ?? null,
        }))
        .catch(() => ({ eventId: event.id, script: fallbackScript(event), audioUrl: null }));
      voiceovers.push(vo);
    }
    return NextResponse.json({ voiceovers });
  } catch (err) {
    // Even a wholesale failure keeps narration alive: the browser reads the
    // event text itself instead of the player showing an error.
    const events = (await getStory(slug).catch(() => null))?.events ?? [];
    return NextResponse.json({
      voiceovers: events.map((event) => ({ eventId: event.id, script: fallbackScript(event), audioUrl: null })),
    });
  }
}
