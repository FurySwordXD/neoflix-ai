import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { getStory } from "@/lib/stories";
import type { Story } from "@/lib/types";

const SLUG_RE = /^[a-z0-9-]+$/;

/** Runs the CLI's stage-one on this story, handing it the story JSON on stdin. */
function stageStory(story: Story) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["remotion/cli.mjs", "stage-one", story.slug], {
      cwd: process.cwd(),
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(story));
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
    await stageStory(story);
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
