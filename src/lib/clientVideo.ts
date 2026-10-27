"use client";

import { useSyncExternalStore } from "react";
import { FPS, type VideoManifest } from "../../remotion/types";

export type ClientVideoStatus = "idle" | "preparing" | "rendering" | "ready" | "error";

export interface ClientVideoState {
  slug: string;
  status: ClientVideoStatus;
  /** 0–1 while rendering. */
  progress: number;
  error: string | null;
  /** Object URL of the rendered mp4, once it exists. */
  url: string | null;
}

const listeners = new Set<() => void>();
const states = new Map<string, ClientVideoState>();
const idleStates = new Map<string, ClientVideoState>();
const inflight = new Map<string, Promise<string>>();

function idleState(slug: string): ClientVideoState {
  const existing = idleStates.get(slug);
  if (existing) return existing;
  const created: ClientVideoState = {
    slug,
    status: "idle",
    progress: 0,
    error: null,
    url: null,
  };
  idleStates.set(slug, created);
  return created;
}

function emit() {
  for (const listener of listeners) listener();
}

function patch(slug: string, next: Partial<ClientVideoState>) {
  const current = states.get(slug) ?? idleState(slug);
  states.set(slug, { ...current, ...next, slug });
  emit();
}

export function getClientVideo(slug: string): ClientVideoState {
  return states.get(slug) ?? idleState(slug);
}

export function subscribeClientVideo(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useClientVideo(slug: string): ClientVideoState {
  return useSyncExternalStore(
    subscribeClientVideo,
    () => getClientVideo(slug),
    () => getClientVideo(slug)
  );
}

/**
 * Render the story in the browser. A render already running for this slug is reused.
 * Pass `force` to render again once the current one has finished.
 */
export function startClientRender(slug: string, options?: { force?: boolean }): Promise<string> {
  const running = inflight.get(slug);
  if (running) return running;

  const current = states.get(slug);
  if (!options?.force && current?.status === "ready" && current.url) {
    return Promise.resolve(current.url);
  }

  const promise = renderStory(slug).finally(() => {
    inflight.delete(slug);
  });
  inflight.set(slug, promise);
  return promise;
}

async function renderStory(slug: string): Promise<string> {
  patch(slug, { status: "preparing", progress: 0, error: null });

  const response = await fetch(`/api/stories/${slug}/preview`, { method: "POST" });
  const payload = (await response.json()) as VideoManifest & { error?: string };
  if (!response.ok) {
    const message = payload.error ?? "Could not prepare the video";
    patch(slug, { status: "error", error: message });
    throw new Error(message);
  }

  const [{ canRenderMediaOnWeb, renderMediaOnWeb }, { StoryVideo }] = await Promise.all([
    import("@remotion/web-renderer"),
    import("../../remotion/StoryVideo"),
  ]);

  const support = await canRenderMediaOnWeb({
    width: 1920,
    height: 1080,
    container: "mp4",
    videoCodec: "h264",
  });
  const blocking = support.issues.filter((issue) => issue.severity === "error");
  if (!support.canRender || blocking.length > 0) {
    const message = blocking.map((issue) => issue.message).join(" ") || "This browser cannot render the video";
    patch(slug, { status: "error", error: message });
    throw new Error(message);
  }

  patch(slug, { status: "rendering", progress: 0 });
  let reported = -1;

  try {
    const result = await renderMediaOnWeb({
      composition: {
        component: StoryVideo,
        id: slug,
        width: 1920,
        height: 1080,
        fps: FPS,
        durationInFrames: payload.durationInFrames,
        defaultProps: { slug, manifest: payload },
      },
      inputProps: { slug, manifest: payload },
      container: "mp4",
      videoCodec: "h264",
      outputTarget: "arraybuffer",
      licenseKey: "free-license",
      isProduction: process.env.NODE_ENV === "production",
      hardwareAcceleration: "prefer-hardware",
      pageResponsiveness: "medium",
      onProgress: ({ progress }) => {
        const percent = Math.round(progress * 100);
        if (percent === reported) return;
        reported = percent;
        patch(slug, { status: "rendering", progress });
      },
    });
    const blob = await result.getBlob();
    const url = URL.createObjectURL(blob);
    patch(slug, { status: "ready", progress: 1, url, error: null });
    return url;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Render failed";
    patch(slug, { status: "error", error: message });
    throw err;
  }
}

export function downloadClientVideo(slug: string) {
  const state = states.get(slug);
  if (!state?.url) return;
  const link = document.createElement("a");
  link.href = state.url;
  link.download = `${slug}.mp4`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
