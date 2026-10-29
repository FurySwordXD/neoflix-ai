import fs from "fs/promises";
import path from "path";
import { cert, getApps, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * Voice-over audio is mirrored to Firebase Storage so it is served from a
 * public download URL instead of this server. Every object lives under the
 * "neoflix" root: neoflix/<story-slug>/<event-id>.mp3.
 *
 * Firebase is optional: when the service account file is missing or the
 * upload fails, callers fall back to serving the local cache.
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
  const file = process.env.FIREBASE_SERVICE_ACCOUNT ?? "service-account.json";
  try {
    return toServiceAccount(JSON.parse(await fs.readFile(path.resolve(file), "utf8")));
  } catch {
    return null;
  }
}

function bucketName(account: ServiceAccount): string {
  return process.env.FIREBASE_STORAGE_BUCKET ?? `${account.projectId}.firebasestorage.app`;
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
 * cached one.
 */
export async function uploadVoiceover(
  slug: string,
  eventId: string,
  audio: Buffer,
  audioVersion: string
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
        metadata: { firebaseStorageDownloadTokens: audioVersion },
      },
    });
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${audioVersion}`;
  } catch (err) {
    console.error("Voice-over upload failed:", err instanceof Error ? err.message : err);
    return null;
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
