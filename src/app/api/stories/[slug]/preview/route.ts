import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { getStory } from "@/lib/stories";
import { getVoiceover } from "@/lib/voiceover";
import type { Story } from "@/lib/types";

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Runs the CLI's stage-one on this story. The story JSON and every event's
 * voice-over go over stdin, so the child process never needs to know where
 * the API lives — it only downloads the clips and times the video.
 */
function stageStory(
  story: Story,
  voiceovers: Record<string, { script: string | null; audioUrl: string | null }>
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["remotion/cli.mjs", "stage-one", story.slug], {
      cwd: process.cwd(),
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify({ story, voiceovers }));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Could not prepare the preview (${code})`));
    });
  });
}

/** Stage the story's narration and timing, then return the manifest the video uses. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  try {
    const story = await getStory(slug);
    if (!story) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }
    // Voice-overs are resolved in this process (a cold clip is generated on
    // demand) and handed to the child over stdin: a spawned process has no
    // page origin, so it cannot resolve relative fetch URLs like "/".
    const voiceovers: Record<string, { script: string | null; audioUrl: string | null }> = {};
    for (const event of story.events) {
      const vo = await getVoiceover(slug, event.id).catch(() => null);
      voiceovers[event.id] = { script: vo?.script ?? null, audioUrl: vo?.audioUrl ?? null };
    }
    await stageStory(story, voiceovers);
    const raw = await fs.readFile(
      path.join(process.cwd(), "public/remotion", slug, "manifest.json"),
      "utf8"
    );
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not prepare the preview";
    const status = /unknown story|not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
