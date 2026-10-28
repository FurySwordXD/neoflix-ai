import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { getVideoJob, startVideoRender, videoOutputPath } from "@/lib/renderVideo";

const SLUG_RE = /^[a-z0-9-]+$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  if (req.nextUrl.searchParams.get("download") === "1") {
    const job = getVideoJob(slug);
    if (job.status === "rendering") {
      return NextResponse.json({ error: "Video is still rendering" }, { status: 409 });
    }
    try {
      const filePath = videoOutputPath(slug);
      const info = await stat(filePath);
      const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
      return new NextResponse(stream, {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(info.size),
          "Content-Disposition": `attachment; filename="${slug}.mp4"`,
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return NextResponse.json({ error: "No video yet" }, { status: 404 });
    }
  }

  return NextResponse.json(getVideoJob(slug));
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const { job, httpStatus } = await startVideoRender(slug);
  return NextResponse.json(job, { status: httpStatus });
}
