import { NextRequest, NextResponse } from "next/server";
import { generateStory } from "@/lib/generateStory";
import { listStories, rememberQuery } from "@/lib/stories";

export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({ stories: listStories() });
}

/** Open a saved story for this query, or generate and save one. */
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

  try {
    const result = await generateStory(query);
    if (!result.created) rememberQuery(result.story.slug, query);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create that story";
    const status = message === "NEBIUS_API_KEY is not set" ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
