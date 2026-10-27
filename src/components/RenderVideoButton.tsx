"use client";

import { useRef } from "react";
import { downloadClientVideo, startClientRender, useClientVideo } from "@/lib/clientVideo";

function renderLabel(status: string, progress: number, busy: boolean): string {
  if (!busy) return "Render video";
  if (status === "preparing") return "Preparing…";
  const percent = Math.min(100, Math.round(progress * 100));
  return `Rendering ${percent}%`;
}

export default function RenderVideoButton({ slug }: { slug: string }) {
  const video = useClientVideo(slug);
  const armed = useRef(false);
  const busy = video.status === "preparing" || video.status === "rendering";

  async function render() {
    if (busy) return;
    armed.current = true;
    try {
      await startClientRender(slug, { force: true });
      if (armed.current) downloadClientVideo(slug);
    } catch {
      // The shared state already holds the error.
    } finally {
      armed.current = false;
    }
  }

  const failed = video.status === "error";

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={render}
        disabled={busy}
        title={video.error ?? "Render this story as a video in the browser"}
        className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition disabled:cursor-wait ${
          failed
            ? "bg-red-950 text-red-200 ring-1 ring-red-800 hover:bg-red-900"
            : "bg-sky-600 text-white hover:bg-sky-500 disabled:bg-sky-800 disabled:text-sky-100"
        }`}
      >
        {failed ? "Retry render" : renderLabel(video.status, video.progress, busy)}
      </button>
      {video.error && !busy ? (
        <span className="max-w-36 truncate text-[10px] text-red-300" title={video.error}>
          {video.error}
        </span>
      ) : null}
      {video.url && !busy ? (
        <button
          type="button"
          onClick={() => downloadClientVideo(slug)}
          title="Download the rendered video"
          className="rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 ring-1 ring-slate-700 transition hover:bg-slate-800 hover:text-white"
        >
          Download
        </button>
      ) : null}
    </div>
  );
}
