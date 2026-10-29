import { NextRequest, NextResponse } from "next/server";
import { deleteStory, getStory } from "@/lib/stories";
import { deleteVoiceoverUploads } from "@/lib/firebaseStorage";
import { deleteVoiceoverCache } from "@/lib/voiceover";

/** Slugs are kebab-case: the same guard every story route applies. */
const SLUG_RE = /^[a-z0-9-]+$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const story = await getStory(slug);
  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }
  return NextResponse.json({ story });
}

/**
 * Dev-only: remove a saved story — its store record and its voice-over clips
 * — so the same topic can be compiled from scratch again. A missing slug is
 * still a success, so retries and recreates stay simple.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Story deletion is dev-only." }, { status: 403 });
  }
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }
  try {
    await deleteStory(slug); // silent no-op when nothing is saved
    deleteVoiceoverCache(slug);
    // The Firebase clips are removed best-effort; a leftover clip is never referenced again.
    void deleteVoiceoverUploads(slug);
    return NextResponse.json({ deleted: slug });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not delete that story";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
