import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { DATA_DIR, getStory } from "./stories";
import { getNebiusClient, NEBIUS_MODEL } from "./nebius";
import type { StoryEvent } from "./types";

/**
 * Per-event voice-over: Nebius writes a short neutral narration line, ElevenLabs
 * TTS voices it. Both are cached next to the story data and regenerated only
 * when the event text, model, voice, or speaking rate changes.
 */

const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2";
/** David Castlemore — broadcast newsreader. Override with any voice id from your ElevenLabs library. */
const TTS_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "XjLkpWUlnhS8i7gGz3lZ";
/** ElevenLabs allows 0.7–1.2. 1.0 is the voice's natural pace. */
const TTS_SPEED = 1.2;
const SCRIPT_VERSION = 4;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SLUG_RE = /^[a-z0-9-]+$/;

export interface Voiceover {
  eventId: string;
  script: string;
  /** Changes whenever the audio is regenerated; null if no audio exists. */
  audioVersion: string | null;
}

interface VoiceoverMeta {
  scriptHash: string;
  script: string;
  audioHash: string | null;
}

const inflight = new Map<string, Promise<Voiceover | null>>();

function voiceoverDir(slug: string) {
  return path.join(DATA_DIR, slug, "voiceover");
}

function hash(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** Resolves the event only if both ids are real, so they're safe in file paths. */
export function findEvent(slug: string, eventId: string): StoryEvent | null {
  if (!SLUG_RE.test(slug)) return null;
  return getStory(slug)?.events.find((e) => e.id === eventId) ?? null;
}

export function voiceoverAudioPath(slug: string, eventId: string): string {
  return path.join(voiceoverDir(slug), `${eventId}.mp3`);
}

export function getVoiceover(slug: string, eventId: string): Promise<Voiceover | null> {
  const key = `${slug}/${eventId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = buildVoiceover(slug, eventId).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

function monthKey(timestamp: string): string {
  return timestamp.slice(0, 7);
}

/** "December 2019" — the day is never spoken. */
function spokenMonth(timestamp: string): string {
  const [year, month] = monthKey(timestamp).split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

function placeKey(event: StoryEvent): string {
  return `${event.location.name}|${event.location.country}`;
}

function previousEvent(slug: string, eventId: string): StoryEvent | null {
  const events = getStory(slug)?.events ?? [];
  const index = events.findIndex((event) => event.id === eventId);
  return index > 0 ? events[index - 1] : null;
}

/** Date and place are spoken only when they differ from the previous event. */
function spokenLead(event: StoryEvent, previous: StoryEvent | null): string {
  const parts: string[] = [];
  if (!previous || monthKey(previous.timestamp) !== monthKey(event.timestamp)) {
    parts.push(spokenMonth(event.timestamp));
  }
  if (!previous || placeKey(previous) !== placeKey(event)) {
    parts.push(event.location.name);
  }
  return parts.length ? `${parts.join(". ")}.` : "";
}

async function buildVoiceover(slug: string, eventId: string): Promise<Voiceover | null> {
  const event = findEvent(slug, eventId);
  if (!event) return null;
  const previous = previousEvent(slug, eventId);

  const dir = voiceoverDir(slug);
  await fs.mkdir(dir, { recursive: true });
  const metaPath = path.join(dir, `${eventId}.json`);
  const audioPath = voiceoverAudioPath(slug, eventId);

  let meta: VoiceoverMeta | null = null;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    meta = null;
  }

  const scriptHash = hash([
    SCRIPT_VERSION,
    event.title,
    event.summary,
    event.timestamp,
    event.location,
    previous ? [previous.id, monthKey(previous.timestamp), placeKey(previous)] : null,
  ]);
  if (!meta || meta.scriptHash !== scriptHash) {
    meta = { scriptHash, script: await writeScript(event, previous), audioHash: null };
  }

  const audioHash = hash([meta.script, TTS_MODEL, TTS_VOICE, TTS_SPEED]);
  const audioExists = await fs
    .access(audioPath)
    .then(() => true)
    .catch(() => false);
  if (meta.audioHash !== audioHash || !audioExists) {
    const audio = await synthesize(meta.script);
    if (audio) {
      await fs.writeFile(audioPath, audio);
      meta.audioHash = audioHash;
    } else {
      meta.audioHash = null;
    }
  }

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { eventId, script: meta.script, audioVersion: meta.audioHash };
}

const MAX_FACT_WORDS = 22;

async function writeScript(event: StoryEvent, previous: StoryEvent | null): Promise<string> {
  let fact = await draftScript(event);
  if (wordCount(fact) > MAX_FACT_WORDS) {
    const retry = await draftScript(event, fact);
    if (wordCount(retry) < wordCount(fact)) fact = retry;
  }
  const lead = spokenLead(event, previous);
  return lead ? `${lead} ${fact}` : fact;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function draftScript(event: StoryEvent, tooLong?: string): Promise<string> {
  const client = getNebiusClient();
  const completion = await client.chat.completions.create({
    model: NEBIUS_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: `You write the factual sentence of a documentary-style news voice-over.
Rules:
- One short sentence, at most ${MAX_FACT_WORDS} words. It is read aloud, so it must flow naturally.
- Do not mention the date, month, year, city, or country. Those are spoken separately, and only when they change.
- Keep only the single most important fact; drop secondary details.
- Strictly neutral and factual: no opinions, no praise or blame, no speculation.
- Use only facts present in the event text. Present tense.
- Copy numbers and their qualifiers exactly ("nearly", "at least", "roughly"); never round or rephrase them.
- Output only the sentence itself: no quotes, labels or markdown.`,
      },
      {
        role: "user",
        content: `Title: ${event.title}
Summary: ${event.summary}`,
      },
      ...(tooLong
        ? [
          { role: "assistant" as const, content: tooLong },
          {
            role: "user" as const,
              content: `That is ${wordCount(tooLong)} words. Rewrite it in at most ${MAX_FACT_WORDS - 4} words, keeping only the single most important fact. Do not mention the date or the place.`,
          },
        ]
        : []),
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  const script = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“']+|["”']+$/g, "");
  if (!script) throw new Error("Empty voice-over script");
  return script;
}

async function synthesize(script: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  try {
    const elevenlabs = new ElevenLabsClient({ apiKey });
    const stored = await elevenlabs.voices.settings.get(TTS_VOICE);
    const audio = await elevenlabs.textToSpeech.convert(TTS_VOICE, {
      text: script,
      modelId: TTS_MODEL,
      voiceSettings: { ...stored, speed: TTS_SPEED },
    });
    return Buffer.from(await new Response(audio).arrayBuffer());
  } catch (err) {
    console.error("Voice-over TTS failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
