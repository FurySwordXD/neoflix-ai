import crypto from "crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { findUploadedVoiceover, firebaseConfigured, firebaseReachable, uploadVoiceover } from "./firebaseStorage";
import { getStory } from "./stories";
import { getNebiusClient, NEBIUS_MODEL } from "./nebius";
import type { Story, StoryEvent } from "./types";

/**
 * Per-event voice-over: Nebius writes a short neutral narration line, ElevenLabs
 * TTS voices it. Audio lives only in Firebase Storage — clips are synthesized
 * in memory and uploaded straight away, and regenerated only when the event
 * text, model, voice, or speaking rate changes.
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

// Concurrent requests for the same clip share one run, so ElevenLabs is
// never hit twice for the same event at once. The run is forgotten once it
// settles: the next request re-checks Firebase, which is the cache.
const inflight = new Map<string, Promise<Voiceover | null>>();

function hash(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** The story, only for a slug that is safe in object paths. */
async function findStory(slug: string): Promise<Story | null> {
  if (!SLUG_RE.test(slug)) return null;
  return getStory(slug);
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

/** Forgets the story's in-flight work (its remote clips live in Firebase Storage). */
export function deleteVoiceoverCache(slug: string): void {
  for (const key of inflight.keys()) {
    if (key.startsWith(`${slug}/`)) inflight.delete(key);
  }
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
  const story = await findStory(slug);
  const event = story?.events.find((e) => e.id === eventId);
  if (!story || !event) return null;
  const previous = previousEvent(story.events, eventId);
  const documentary = documentaryScript(story, event);

  // The version key hashes only the event's own text, so a clip uploaded by
  // another instance — or before a redeploy — is still found.
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

  const firebaseReady = await firebaseConfigured();
  // Storage is the only audio store: adopt the clip this story already paid
  // for (its metadata carries the script too) before spending anything.
  const stored = firebaseReady ? await findUploadedVoiceover(slug, eventId, scriptHash) : null;
  const script = documentary ?? stored?.script ?? (await writeScriptOrFallback(event, previous));
  const audioHash = hash([script, TTS_MODEL, TTS_VOICE, TTS_SPEED]);

  if (stored && stored.script === script && stored.audioHash === audioHash) {
    return { eventId, script, audioVersion: stored.audioHash, audioUrl: stored.audioUrl };
  }

  // Nowhere to store a fresh clip — not configured, or the bucket is
  // unreachable: serve the script only, so TTS credits are never spent on
  // audio that cannot be kept. The browser fills the gap with its own
  // speech synthesis.
  if (!firebaseReady || !(await firebaseReachable())) {
    return { eventId, script, audioVersion: null, audioUrl: null };
  }

  const audio = await synthesize(script);
  if (!audio) return { eventId, script, audioVersion: null, audioUrl: null };
  const audioUrl = await uploadVoiceover(slug, eventId, audio, audioHash, script, scriptHash);
  return {
    eventId,
    script,
    // A failed upload is also a browser-TTS fallback: no version token means
    // the client never waits on a URL that would not resolve.
    audioVersion: audioUrl ? audioHash : null,
    audioUrl,
  };
}

/**
 * The script the browser TTS reads when the audio pipeline has nothing: the
 * documentary draft when the model wrote one, else the event's own summary
 * text — anything but a hard failure.
 */
export function fallbackScript(event: StoryEvent): string {
  return event.summary?.trim() || event.title.trim();
}

async function writeScriptOrFallback(event: StoryEvent, previous: StoryEvent | null): Promise<string> {
  try {
    return await writeScript(event, previous);
  } catch (err) {
    console.error("Voice-over script failed:", err instanceof Error ? err.message : err);
    return fallbackScript(event);
  }
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
