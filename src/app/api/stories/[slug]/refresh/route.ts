import { NextRequest } from "next/server";
import { refreshStoryStream } from "@/lib/generateStory";
import { ndjsonResponse } from "@/lib/ndjsonStream";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Refresh a saved story with the latest news: newline-delimited JSON, one
 * step/event message per line, then the saved story with an `added` count.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const generator = refreshStoryStream(slug, req.signal);
  return ndjsonResponse(generator, req.signal);
}
