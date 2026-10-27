import OpenAI from "openai";

/**
 * Nebius AI Studio is OpenAI-API compatible, so we use the OpenAI client
 * pointed at the Nebius base URL. All runtime story generation flows
 * through this single client.
 */
export const NEBIUS_BASE_URL =
  process.env.NEBIUS_BASE_URL ?? "https://api.studio.nebius.ai/v1/";

export const NEBIUS_MODEL =
  process.env.NEBIUS_MODEL ?? "Qwen/Qwen3-235B-A22B-Instruct-2507";

export function getNebiusClient(): OpenAI {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) {
    throw new Error("NEBIUS_API_KEY is not set");
  }
  return new OpenAI({ apiKey, baseURL: NEBIUS_BASE_URL });
}

/** Strip markdown code fences some models wrap around JSON. */
export function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return JSON.parse(text) as T;
}
