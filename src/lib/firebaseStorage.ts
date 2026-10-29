import fs from "fs/promises";
import path from "path";
import { cert, getApps, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * Voice-over audio lives in Firebase Storage so it is served from a public
 * download URL instead of this server. Every object lives under the
 * "neoflix" root: neoflix/<story-slug>/<event-id>.mp3.
 *
 * Firebase is optional: when it is not configured or unreachable, callers
 * serve the narration script only and the browser's speech synthesis reads it.
 */

const ROOT = "neoflix";
const SLUG_RE = /^[a-z0-9-]+$/;
const EVENT_ID_RE = /^[a-zA-Z0-9-]+$/;

// The app registry survives hot reloads, so the resolved app is cached in a
// module promise while the bucket name is always derived fresh at call time.
let appPromise: Promise<App | null> | undefined;

/** Maps the service account's snake_case keys onto the SDK's camelCase ones. */
function toServiceAccount(json: Record<string, unknown>): ServiceAccount {
  return {
    projectId: (json.project_id ?? json.projectId) as string | undefined,
    privateKey: (json.private_key ?? json.privateKey) as string | undefined,
    clientEmail: (json.client_email ?? json.clientEmail) as string | undefined,
  };
}

async function loadServiceAccount(): Promise<ServiceAccount | null> {
  try {
    const base64: string = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? "";
    const serviceAccountJson = Buffer.from(base64, "base64").toString("utf8");
    return toServiceAccount(JSON.parse(serviceAccountJson));
  } catch {
    return null;
  }
}

function bucketName(account: ServiceAccount): string {
  return process.env.FIREBASE_STORAGE_BUCKET ?? `${account.projectId}.firebasestorage.app`;
}

/** True when a service account is configured, so clips have somewhere to live. */
export async function firebaseConfigured(): Promise<boolean> {
  return (await loadServiceAccount()) !== null;
}

/**
 * True when the bucket answers a cheap request. Used to skip TTS entirely
 * when Storage is down: synthesizing audio that cannot be stored only burns
 * credits. Errors count as "not ready" — the fallback is browser TTS.
 */
export async function firebaseReachable(): Promise<boolean> {
  const account = await loadServiceAccount();
  const app = account && (await firebaseApp());
  if (!account || !app) return false;
  try {
    // A 404 answer is still an answer: an unreachable bucket throws instead.
    const [exists] = await getStorage(app).bucket(bucketName(account)).exists();
    return exists === true;
  } catch {
    return false;
  }
}

/** The admin app, or null when Firebase isn't configured for this deployment. */
function firebaseApp(): Promise<App | null> {
  appPromise ??= (async () => {
    const account = await loadServiceAccount();
    if (!account) return null;
    const existing = getApps()[0];
    if (existing) return existing;
    try {
      return initializeApp({ credential: cert(account) });
    } catch (err) {
      console.error("Firebase init failed:", err instanceof Error ? err.message : err);
      return null;
    }
  })();
  return appPromise;
}

/**
 * Uploads the narration audio and returns its public download URL, or null
 * when Firebase isn't configured. The download token is the audio's version
 * hash, so a regenerated clip gets a fresh URL while replays reuse the same
 * cached one. The script and its hash ride along as object metadata, so a
 * cold serverless instance can restore the clip without regenerating it.
 */
export async function uploadVoiceover(
  slug: string,
  eventId: string,
  audio: Buffer,
  audioVersion: string,
  script: string,
  scriptHash: string
): Promise<string | null> {
  if (!SLUG_RE.test(slug) || !EVENT_ID_RE.test(eventId)) return null;
  const account = await loadServiceAccount();
  const app = account && (await firebaseApp());
  if (!account || !app) return null;
  const bucket = bucketName(account);
  try {
    const objectPath = `${ROOT}/${slug}/${eventId}.mp3`;
    const file = getStorage(app).bucket(bucket).file(objectPath);
    await file.save(audio, {
      contentType: "audio/mpeg",
      resumable: false,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {
          firebaseStorageDownloadTokens: audioVersion,
          "neoflix-script": script,
          "neoflix-script-hash": scriptHash,
        },
      },
    });
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${audioVersion}`;
  } catch (err) {
    console.error("Voice-over upload failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Looks up a previously uploaded clip for a story event whose script is
 * unchanged. Returns the script, the audio's version hash (the download
 * token) and its public URL — or null when no usable clip is stored: the
 * object is missing, its metadata is from an older format, or Storage is
 * unreachable. A stale script hash is treated as no clip, so the caller
 * regenerates once and re-uploads with fresh metadata.
 */
export async function findUploadedVoiceover(
  slug: string,
  eventId: string,
  scriptHash: string
): Promise<{ script: string; audioHash: string; audioUrl: string } | null> {
  if (!SLUG_RE.test(slug) || !EVENT_ID_RE.test(eventId)) return null;
  const account = await loadServiceAccount();
  const app = account && (await firebaseApp());
  if (!account || !app) return null;
  const bucket = bucketName(account);
  const objectPath = `${ROOT}/${slug}/${eventId}.mp3`;
  try {
    const [metadata] = await getStorage(app).bucket(bucket).file(objectPath).getMetadata();
    const stored = (metadata.metadata ?? {}) as Record<string, string | undefined>;
    const audioHash = stored.firebaseStorageDownloadTokens;
    const script = stored["neoflix-script"];
    if (!audioHash || !script || stored["neoflix-script-hash"] !== scriptHash) return null;
    return {
      script,
      audioHash,
      audioUrl: `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${audioHash}`,
    };
  } catch (err) {
    console.error("Voice-over lookup failed:", err instanceof Error ? err.message : err);
    return null; // not uploaded yet, or Firebase is unreachable
  }
}

/**
 * Removes every uploaded clip of a story. Best-effort: when Firebase isn't
 * configured, or a file refuses to go, the local cache is already gone and a
 * dangling remote clip is never referenced again.
 */
export async function deleteVoiceoverUploads(slug: string): Promise<number> {
  if (!SLUG_RE.test(slug)) return 0;
  const account = await loadServiceAccount();
  const app = account && (await firebaseApp());
  if (!account || !app) return 0;
  const bucket = getStorage(app).bucket(bucketName(account));
  try {
    const [files] = await bucket.getFiles({ prefix: `${ROOT}/${slug}/` });
    let removed = 0;
    for (const file of files) {
      try {
        await file.delete();
        removed += 1;
      } catch (err) {
        console.error("Voice-over delete failed:", err instanceof Error ? err.message : err);
      }
    }
    return removed;
  } catch (err) {
    console.error("Voice-over cleanup failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}
