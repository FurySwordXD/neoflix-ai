import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

const SLUG_RE = /^[a-z0-9-]+$/;

function stageStory(slug: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["remotion/cli.mjs", "stage-one", slug], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
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
    await stageStory(slug);
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
