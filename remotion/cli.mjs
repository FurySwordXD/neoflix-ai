import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "src/data/stories");
const publicDir = path.join(root, "public/remotion");
const apiUrl = (process.env.ALGONEWS_API_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_TIMEOUT_MS = 10_000;

const FPS = 30;
const TITLE_FRAMES = 4 * FPS;
const END_FRAMES = 4.5 * FPS;
const AUDIO_DELAY_FRAMES = 12;
const AUDIO_TAIL_FRAMES = 18;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Stories come from the app's API, so they load the same whether the app
 * stores them as files or in Neo4j. When the API is not running, the CLI
 * falls back to the JSON files under src/data/stories.
 */
function listFileSlugs() {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dataDir, entry.name, "meta.json")))
    .map((entry) => entry.name)
    .sort();
}

function loadFileStory(slug) {
  return { ...readJson(path.join(dataDir, slug, "meta.json")), events: loadEvents(slug) };
}

async function fetchJson(pathname) {
  const res = await fetch(`${apiUrl}${pathname}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${pathname} returned ${res.status}`);
  return res.json();
}

/** True when the request never reached a server (as opposed to the server answering with an error). */
function isUnreachable(err) {
  return err instanceof TypeError || err?.name === "TimeoutError" || err?.name === "AbortError";
}

async function loadApiStories() {
  const { stories } = await fetchJson("/api/stories");
  if (!Array.isArray(stories)) throw new Error("GET /api/stories returned no story list");
  const loaded = [];
  for (const { slug } of stories) {
    const { story } = await fetchJson(`/api/stories/${encodeURIComponent(slug)}`);
    loaded.push(story);
  }
  return loaded.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function loadStories() {
  try {
    return await loadApiStories();
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    console.error(`Story API at ${apiUrl} is unreachable; reading src/data/stories instead.`);
    return listFileSlugs().map(loadFileStory);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** stage-one's story: JSON on stdin when given (the preview route sends it), else the API or files. */
async function loadOneStory(slug) {
  const raw = await readStdin();
  if (raw) {
    const story = JSON.parse(raw);
    if (story?.slug !== slug || !Array.isArray(story.events)) {
      throw new Error(`Story JSON on stdin is not story "${slug}"`);
    }
    return story;
  }
  const stories = await loadStories();
  const story = stories.find((item) => item.slug === slug);
  if (!story) {
    throw new Error(`Unknown story "${slug}". Available: ${stories.map((item) => item.slug).join(", ")}`);
  }
  return story;
}

async function mp3Seconds(filePath) {
  const bytes = fs.readFileSync(filePath);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
  try {
    return await input.computeDuration();
  } finally {
    input.dispose();
  }
}

function loadEvents(slug) {
  const eventsDir = path.join(dataDir, slug, "events");
  return fs
    .readdirSync(eventsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(path.join(eventsDir, file)))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function silentFrames(event, script) {
  const words = (script ?? event.summary ?? "").split(/\s+/).filter(Boolean).length;
  const seconds = Math.min(14, Math.max(5.5, words / 2.6));
  return Math.round(seconds * FPS);
}

async function stageStory(story) {
  const { slug, events: unsorted, ...meta } = story;
  const events = [...(unsorted ?? [])].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  if (events.length === 0) throw new Error(`${slug} has no events`);

  const dest = path.join(publicDir, slug);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(dest)) {
    if (file.endsWith(".mp3")) fs.rmSync(path.join(dest, file), { force: true });
  }

  let cursor = TITLE_FRAMES;
  const staged = [];
  for (const event of events) {
    const audioSrc = path.join(dataDir, slug, "voiceover", `${event.id}.mp3`);
    const scriptPath = path.join(dataDir, slug, "voiceover", `${event.id}.json`);
    const script =
      (fs.existsSync(scriptPath) ? readJson(scriptPath).script ?? null : null) ??
      event.narration ??
      null;

    let audio = null;
    let audioSeconds = null;
    if (fs.existsSync(audioSrc)) {
      fs.copyFileSync(audioSrc, path.join(dest, `${event.id}.mp3`));
      audio = `remotion/${slug}/${event.id}.mp3`;
      audioSeconds = await mp3Seconds(audioSrc);
    }

    const audioFrames = audioSeconds ? Math.ceil(audioSeconds * FPS) : 0;
    const durationInFrames = audioFrames
      ? AUDIO_DELAY_FRAMES + audioFrames + AUDIO_TAIL_FRAMES
      : silentFrames(event, script);

    staged.push({
      id: event.id,
      title: event.title,
      summary: event.summary,
      timestamp: event.timestamp,
      category: event.category,
      ...(event.magnitude ? { magnitude: event.magnitude } : {}),
      location: event.location,
      ...(event.motion ? { motion: event.motion } : {}),
      images: (event.images ?? [])
        .slice(0, 2)
        .map((image) => ({
          url: image.url,
          ...(image.caption ? { caption: image.caption } : {}),
        })),
      sources: (event.sources ?? []).map((source) => ({
        id: source.id,
        publisher: source.publisher,
        politicalLean: source.bias?.politicalLean ?? "mixed",
      })),
      script,
      audio,
      audioSeconds,
      from: cursor,
      durationInFrames,
    });
    cursor += durationInFrames;
  }

  const manifest = {
    slug,
    title: meta.title,
    subtitle: meta.subtitle,
    description: meta.description,
    ...(meta.hook ? { hook: meta.hook } : {}),
    ...(meta.epilogue ? { epilogue: meta.epilogue } : {}),
    status: meta.status,
    startAt: meta.startAt,
    ...(meta.endAt ? { endAt: meta.endAt } : {}),
    eventCount: staged.length,
    narratedCount: staged.filter((event) => event.audio).length,
    relatedStories: meta.relatedStories ?? [],
    titleFrames: TITLE_FRAMES,
    endFrames: END_FRAMES,
    audioDelayFrames: AUDIO_DELAY_FRAMES,
    durationInFrames: cursor + END_FRAMES,
    events: staged,
  };
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function writeCatalog(slugs) {
  const body = `// Generated by remotion/cli.mjs. Lists every story that can be rendered.\nexport const STORY_SLUGS = ${JSON.stringify(slugs, null, 2)} as const;\n`;
  fs.writeFileSync(path.join(root, "remotion/catalog.ts"), body);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const [mode, ...args] = process.argv.slice(2);

if (mode === "stage-one") {
  const slug = args[0];
  if (!slug) {
    console.error("Usage: node remotion/cli.mjs stage-one <slug>");
    process.exit(1);
  }
  try {
    await stageStory(await loadOneStory(slug));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
}

const stories = await loadStories();
const slugs = stories.map((story) => story.slug);
if (slugs.length === 0) {
  console.error(`No stories found (API ${apiUrl} or src/data/stories)`);
  process.exit(1);
}

console.log(`Staging ${slugs.length} ${slugs.length === 1 ? "story" : "stories"}…`);
for (const story of stories) {
  const slug = story.slug;
  const manifest = await stageStory(story);
  const seconds = (manifest.durationInFrames / FPS).toFixed(1);
  console.log(`  ${slug}: ${manifest.eventCount} events, ${manifest.narratedCount} narrated, ${seconds}s`);
}
writeCatalog(slugs);

if (mode === "stage") {
  process.exit(0);
}

if (mode === "studio") {
  await run("npx", ["remotion", "studio", "remotion/index.ts"]);
} else if (mode === "render") {
  const slug = args[0] && !args[0].startsWith("-") ? args[0] : "covid-19-pandemic";
  const extra = args[0] && !args[0].startsWith("-") ? args.slice(1) : args;
  if (!slugs.includes(slug)) {
    console.error(`Unknown story "${slug}". Available: ${slugs.join(", ")}`);
    process.exit(1);
  }
  const output = `out/${slug}.mp4`;
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  console.log(`Rendering ${slug} → ${output}`);
  await run("npx", ["remotion", "render", "remotion/index.ts", slug, output, ...extra]);
} else if (mode === "still") {
  const slug = args[0] ?? "covid-19-pandemic";
  const frame = args[1] ?? "150";
  const output = args[2] ?? `out/${slug}-${frame}.png`;
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  await run("npx", ["remotion", "still", "remotion/index.ts", slug, output, `--frame=${frame}`]);
} else {
  console.error("Usage: node remotion/cli.mjs <stage|stage-one|studio|render|still> [slug]");
  process.exit(1);
}
