import { NextResponse } from "next/server";
import { getNebiusClient } from "@/lib/nebius";

/** Debug helper: list models available on the configured Nebius endpoint. */
export async function GET() {
  try {
    const client = getNebiusClient();
    const models = await client.models.list();
    return NextResponse.json({
      models: models.data.map((m) => m.id).sort(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
