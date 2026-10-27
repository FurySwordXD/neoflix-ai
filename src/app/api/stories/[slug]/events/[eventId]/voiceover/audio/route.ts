import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { findEvent, voiceoverAudioPath } from "@/lib/voiceover";

/** Serves the cached narration MP3, with Range support for Safari. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; eventId: string }> }
) {
  const { slug, eventId } = await params;
  if (!findEvent(slug, eventId)) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  let audio: Buffer;
  try {
    audio = await fs.readFile(voiceoverAudioPath(slug, eventId));
  } catch {
    return NextResponse.json({ error: "Voice-over not generated yet" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    // URLs carry a version query, so a cached file never goes stale.
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const size = audio.length;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    return new NextResponse(new Uint8Array(audio.subarray(start, end + 1)), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new NextResponse(new Uint8Array(audio), {
    headers: { ...headers, "Content-Length": String(audio.length) },
  });
}
