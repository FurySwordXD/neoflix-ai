import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { getStory } from "./stories";

const SLUG_RE = /^[a-z0-9-]+$/;

export type VideoJobStatus = "idle" | "rendering" | "ready" | "error";
export type VideoJobPhase = "preparing" | "rendering" | "encoding";

export interface VideoJob {
  slug: string;
  status: VideoJobStatus;
  phase: VideoJobPhase | null;
  rendered: number;
  total: number;
  error: string | null;
  hasFile: boolean;
}

interface InternalJob extends VideoJob {
  child?: ChildProcess;
}

const globalJobs = globalThis as unknown as {
  __worldnewsVideoJobs?: Map<string, InternalJob>;
};
const jobs = globalJobs.__worldnewsVideoJobs ?? new Map<string, InternalJob>();
globalJobs.__worldnewsVideoJobs = jobs;

function apiBaseUrl(): string {
  return process.env.ALGONEWS_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

export function videoOutputPath(slug: string): string {
  return path.join(process.cwd(), "out", `${slug}.mp4`);
}

function hasVideo(slug: string): boolean {
  return fs.existsSync(videoOutputPath(slug));
}

function publish(job: InternalJob): VideoJob {
  return {
    slug: job.slug,
    status: job.status,
    phase: job.phase,
    rendered: job.rendered,
    total: job.total,
    error: job.error,
    hasFile: hasVideo(job.slug),
  };
}

export function getVideoJob(slug: string): VideoJob {
  const existing = jobs.get(slug);
  if (existing) return publish(existing);
  const file = hasVideo(slug);
  return {
    slug,
    status: file ? "ready" : "idle",
    phase: null,
    rendered: 0,
    total: 0,
    error: null,
    hasFile: file,
  };
}

function noteProgress(job: InternalJob, line: string) {
  const rendered = /Rendered\s+(\d+)\s*\/\s*(\d+)/.exec(line);
  if (rendered) {
    job.phase = "rendering";
    job.rendered = Number(rendered[1]);
    job.total = Number(rendered[2]);
    return;
  }
  const encoded = /Encoded\s+(\d+)\s*\/\s*(\d+)/.exec(line);
  if (encoded) {
    job.phase = "encoding";
    job.rendered = Number(encoded[1]);
    job.total = Number(encoded[2]);
  }
}

export async function startVideoRender(slug: string): Promise<{
  job: VideoJob;
  httpStatus: number;
}> {
  if (!SLUG_RE.test(slug) || !(await getStory(slug))) {
    return {
      job: {
        slug,
        status: "error",
        phase: null,
        rendered: 0,
        total: 0,
        error: "Story not found",
        hasFile: false,
      },
      httpStatus: 404,
    };
  }

  const current = jobs.get(slug);
  if (current?.status === "rendering") {
    return { job: publish(current), httpStatus: 200 };
  }

  for (const other of jobs.values()) {
    if (other.status === "rendering") {
      return {
        job: {
          ...getVideoJob(slug),
          error: `Already rendering “${other.slug}”.`,
        },
        httpStatus: 409,
      };
    }
  }

  const job: InternalJob = {
    slug,
    status: "rendering",
    phase: "preparing",
    rendered: 0,
    total: 0,
    error: null,
    hasFile: hasVideo(slug),
  };
  jobs.set(slug, job);

  const child = spawn(process.execPath, ["remotion/cli.mjs", "render", slug], {
    cwd: process.cwd(),
    // The CLI loads stories through this server's API, wherever they are stored.
    env: { ...process.env, ALGONEWS_API_URL: apiBaseUrl() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;

  let buffer = "";
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n|\r/);
    buffer = lines.pop() ?? "";
    for (const line of lines) noteProgress(job, line);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (err) => {
    job.status = "error";
    job.phase = null;
    job.error = err.message;
    job.child = undefined;
  });
  child.on("close", (code) => {
    if (buffer) noteProgress(job, buffer);
    buffer = "";
    job.child = undefined;
    if (code === 0 && hasVideo(slug)) {
      job.status = "ready";
      job.phase = null;
      job.error = null;
      return;
    }
    if (job.status === "rendering") {
      job.status = "error";
      job.phase = null;
      job.error = `Render stopped (${code ?? "no exit code"})`;
    }
  });

  return { job: publish(job), httpStatus: 202 };
}
