import { NextRequest, NextResponse } from "next/server";
import { compileMotion } from "@/lib/mapMotion";
import { getNebiusClient, NEBIUS_MODEL, parseJsonResponse } from "@/lib/nebius";
import type { GeneratedEvent } from "@/lib/types";

/**
 * Runtime event generation. The caller provides raw source material
 * (publisher, title, url, date, optionally article notes + location).
 * The model MUST build events grounded only in that material —
 * inventing URLs or facts is a hard failure.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { topic, sources } = body ?? {};

  if (
    typeof topic !== "string" ||
    !Array.isArray(sources) ||
    sources.length === 0
  ) {
    return NextResponse.json(
      { error: "topic (string) and sources (non-empty array) are required" },
      { status: 400 }
    );
  }

  const sanitized = sources.filter(
    (s: Record<string, unknown>) =>
      typeof s?.publisher === "string" &&
      typeof s?.title === "string" &&
      typeof s?.url === "string"
  );
  if (sanitized.length === 0) {
    return NextResponse.json(
      { error: "Each source needs publisher, title and url" },
      { status: 400 }
    );
  }

  const sourceBlock = sanitized
    .map(
      (s: Record<string, string>, i: number) =>
        `SOURCE ${i + 1}\npublisher: ${s.publisher}\ntitle: ${s.title}\nurl: ${s.url}\npublishedAt: ${s.publishedAt ?? "unknown"}\nlocationHint: ${s.locationHint ?? "unknown"}\nnotes: ${s.notes ?? ""}`
    )
    .join("\n\n");

  const system = `You are the event compiler for an interactive news story engine.
You receive a topic and raw source material. Produce story events as pure JSON.

Hard rules:
- GROUNDING: use ONLY facts present in the source material. No invented details, numbers or dates.
- URLs: the output may ONLY contain the URLs given in the sources, verbatim. Never fabricate links.
- TONE: unopinionated, fact-first, no editorializing — but keep it vivid and interesting. Let the reader draw conclusions.
- BIAS: classify each source's politicalLean (left | lean-left | center | lean-right | right | mixed) and factualRating (very-high | high | mostly-factual | mixed | low | very-low) from your knowledge of the outlet and any notes provided. Add a one-line note explaining the classification.
- LOCATION: resolve each event to a real-world place with lat/lng coordinates and a human name.
- CATEGORY: one of outbreak | response | science | politics | economy | milestone.
- MAGNITUDE: if the material contains a scale figure (cases, deaths, dollars), use it; otherwise omit.
- NARRATIVE: titles are vivid headlines of at most 8 words with an active verb. Each summary says what happened, then why it mattered. Add "consequence": one sentence (at most 18 words) on the documented result, taken only from the material. Add "narration": 2–3 sentences (at most 50 words) of documentary voice-over that links back to what came before (a time jump, cause, or contrast), tells the moment concretely, and ends on the real stakes it raises. No invented scenes, thoughts, or dialogue; never start with "On [date]".
- MOTION: add motion only when movement is the point of the event (a strike, an advance, people fleeing, a spread). At most one event in two carries motion; prefer the simplest kind. Omit motion for speeches, votes, rulings, signings, and talks. A place is {"name","lat","lng"}. Use one of: {"kind":"impact"} (battle, blast, quake), {"kind":"spread","radius":deg} (reach in degrees, 1 ≈ 111 km), {"kind":"sweep","heading":0-359,"radius":deg} (directional push: storm track, offensive, plume), {"kind":"encircle","radius":1-6} (siege, blockade, lockdown), {"kind":"flow","to":place} or {"kind":"flow","from":place}, {"kind":"path","points":[3–4 places]}, {"kind":"converge","from":[2–3 places]}, {"kind":"radiate","to":[2–3 places]}, {"kind":"exchange","with":place} (trade, swaps), {"kind":"launch","to":place} (missile, rocket, airlift). Optionally add "actor": "troops" | "people" | "ships" | "aircraft" | "goods" | "aid" | "disease" | "news". Places must be named in the material or be the obvious real location of a fact the material states. Do not invent a route the sources do not support.
- Group related source material into 1-5 events, in chronological order. Merge the given sources across events where they corroborate the same occurrence.

Output STRICT JSON matching this TypeScript type, with no commentary:
{ "events": Array<{ title: string; summary: string; consequence?: string; narration?: string; location: { name: string; country: string; lat: number; lng: number }; timestamp: string; category: string; magnitude?: number; motion?: object; sources: Array<{ publisher: string; title: string; url: string; publishedAt: string; bias: { politicalLean: string; factualRating: string; note: string }; corroborates: string[] }> }> }`;

  try {
    const client = getNebiusClient();
    const completion = await client.chat.completions.create({
      model: NEBIUS_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Topic: ${topic}\n\n${sourceBlock}` },
      ],
      temperature: 0.3,
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = parseJsonResponse<{ events: GeneratedEvent[] }>(raw);

    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      return NextResponse.json(
        { error: "Model returned no events" },
        { status: 502 }
      );
    }

    const events = parsed.events.map((event) => {
      const motion = compileMotion(event.motion, event.location);
      if (motion) return { ...event, motion };
      const { motion: _dropped, ...rest } = event;
      return rest;
    });

    return NextResponse.json({ events });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
