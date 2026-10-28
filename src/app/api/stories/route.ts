import { NextRequest, NextResponse } from "next/server";
import { generateStoryStream } from "@/lib/generateStory";
import { ndjsonResponse } from "@/lib/ndjsonStream";
import { listStories } from "@/lib/stories";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ stories: await listStories() });
}

/**
 * Open a saved story for this query, or generate one.
 * The body is newline-delimited JSON: meta, then one message per event,
 * then the saved story.
 */
export async function POST(req: NextRequest) {
  let query = "";
  try {
    const body = await req.json();
    query = typeof body?.query === "string" ? body.query.trim() : "";
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (query.length < 2 || query.length > 200) {
    return NextResponse.json(
      { error: "Enter a story topic, from a couple of words up to a sentence." },
      { status: 400 }
    );
  }

  return ndjsonResponse(generateStoryStream(query, req.signal), req.signal);
}
