import { NextResponse } from "next/server";
import { buildVideoManifestForSlug } from "@/lib/videoManifest";

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Builds the story's video manifest. Everything is computed in-process from
 * the story store and Firebase URLs — no spawning the Remotion CLI, which
 * cannot run in a serverless function (its module isn't traced into the
 * bundle and the filesystem is read-only). The browser's web-renderer uses
 * the manifest plus the public clip URLs directly.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  try {
    const manifest = await buildVideoManifestForSlug(slug);
    if (!manifest) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }
    return NextResponse.json(manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not prepare the preview";
    const status = /unknown story|not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
