import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { uploadVoiceover } from "./firebaseStorage";
import { DATA_DIR, getStory } from "./stories";
import { getNebiusClient, NEBIUS_MODEL } from "./nebius";
import type { Story, StoryEvent } from "./types";

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
  /** Public Firebase Storage download URL; null when not uploaded. */
  audioUrl: string | null;
}

interface VoiceoverMeta {
  scriptHash: string;
  script: string;
  audioHash: string | null;
  audioUrl: string | null;
}

const inflight = new Map<string, Promise<Voiceover | null>>();

function voiceoverDir(slug: string) {
  return path.join(DATA_DIR, slug, "voiceover");
}

function hash(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** The story, only for a slug that is safe in file paths. */
async function findStory(slug: string): Promise<Story | null> {
  if (!SLUG_RE.test(slug)) return null;
  return getStory(slug);
}

/** Resolves the event only if both ids are real, so they're safe in file paths. */
export async function findEvent(slug: string, eventId: string): Promise<StoryEvent | null> {
  return (await findStory(slug))?.events.find((e) => e.id === eventId) ?? null;
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

/** Removes the story's whole voice-over cache and forgets its in-flight work. */
export async function deleteVoiceoverCache(slug: string): Promise<void> {
  for (const key of inflight.keys()) {
    if (key.startsWith(`${slug}/`)) inflight.delete(key);
  }
  await fs.rm(voiceoverDir(slug), { recursive: true, force: true });
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

function previousEvent(events: StoryEvent[], eventId: string): StoryEvent | null {
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

/**
 * The documentary script for one beat. The first beat opens on the story's
 * cold open, the last closes on its epilogue, and every beat in between is the
 * narration the model wrote to carry on from the one before.
 */
function documentaryScript(story: Story, event: StoryEvent): string | null {
  if (!event.narration) return null;
  const events = story.events;
  const index = events.findIndex((item) => item.id === event.id);
  const parts: string[] = [];
  if (index === 0 && story.hook) parts.push(story.hook);
  parts.push(event.narration);
  if (index === events.length - 1 && story.epilogue) parts.push(story.epilogue);
  return parts.join(" ");
}

async function buildVoiceover(slug: string, eventId: string): Promise<Voiceover | null> {
  // The story may live in the graph; only its media cache is on disk.
  const story = await findStory(slug);
  const event = story?.events.find((e) => e.id === eventId);
  if (!story || !event) return null;
  const previous = previousEvent(story.events, eventId);
  const documentary = documentaryScript(story, event);

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

  const scriptHash = documentary
    ? hash([SCRIPT_VERSION, "documentary", documentary])
    : hash([
      SCRIPT_VERSION,
      event.title,
      event.summary,
      event.timestamp,
      event.location,
      previous ? [previous.id, monthKey(previous.timestamp), placeKey(previous)] : null,
    ]);
  if (!meta || meta.scriptHash !== scriptHash) {
    meta = {
      scriptHash,
      script: documentary ?? (await writeScript(event, previous)),
      audioHash: null,
      audioUrl: null,
    };
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
      // The clip changed, so its download URL must too: the token is the hash.
      meta.audioUrl = null;
    } else {
      meta.audioHash = null;
      meta.audioUrl = null;
    }
  }
  if (meta.audioHash && !meta.audioUrl) {
    meta.audioUrl = await uploadVoiceover(slug, eventId, await fs.readFile(audioPath), meta.audioHash);
  }

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return {
    eventId,
    script: meta.script,
    audioVersion: meta.audioHash,
    audioUrl: meta.audioUrl,
  };
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

// ElevenLabs rate-limits concurrent synthesis, so every TTS call in this
// process waits its turn on one queue, no matter which route started it.
let ttsQueue: Promise<unknown> = Promise.resolve();

/** Runs the task after every previously enqueued TTS task settles. */
function enqueueTts<T>(task: () => Promise<T>): Promise<T> {
  const run = ttsQueue.then(task, task);
  ttsQueue = run.catch(() => {});
  return run;
}

/** Waits out a rate-limit pause between TTS attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TTS_ATTEMPTS = 4;
const TTS_FIRST_RETRY_MS = 2_000;

async function synthesize(script: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return enqueueTts(async () => {
    let waitMs = TTS_FIRST_RETRY_MS;
    for (let attempt = 1; attempt <= TTS_ATTEMPTS; attempt++) {
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
        const rateLimited =
          err instanceof Error && "statusCode" in err && (err as { statusCode?: number }).statusCode === 429;
        // Last attempt, or a non-429 failure: give up and fall back to
        // browser speech synthesis rather than blocking the batch.
        if (attempt === TTS_ATTEMPTS || !rateLimited) {
          console.error("Voice-over TTS failed:", err instanceof Error ? err.message : err);
          return null;
        }
        console.error(`Voice-over TTS rate-limited; retry ${attempt}/${TTS_ATTEMPTS - 1} in ${waitMs / 1000}s`);
        await sleep(waitMs);
        waitMs *= 2;
      }
    }
    return null;
  });
}
