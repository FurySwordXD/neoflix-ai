"use client";

import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useRef, useState } from "react";
import { StoryVideo, type StoryVideoProps } from "../../remotion/StoryVideo";
import { FPS, type VideoManifest } from "../../remotion/types";

/**
 * Plays the story composition live, so immersive view can be watched without encoding the mp4.
 */
export default function ImmersivePreview({ slug }: { slug: string }) {
  const playerRef = useRef<PlayerRef>(null);
  const [manifest, setManifest] = useState<VideoManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setManifest(null);
    setError(null);
    fetch(`/api/stories/${slug}/preview`, { method: "POST" })
      .then(async (res) => {
        const data = (await res.json()) as VideoManifest & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not prepare the preview");
        if (!stop) setManifest(data);
      })
      .catch((err: unknown) => {
        if (stop) return;
        setError(err instanceof Error ? err.message : "Could not prepare the preview");
      });
    return () => {
      stop = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!manifest) return;
    const player = playerRef.current;
    if (!player) return;
    const frame = requestAnimationFrame(() => {
      player.play();
    });
    return () => cancelAnimationFrame(frame);
  }, [manifest]);

  return (
    <div className="glass flex min-h-0 flex-1 items-center justify-center rounded-2xl p-3 sm:p-5">
      {error ? (
        <p className="max-w-md text-center text-sm text-red-300">{error}</p>
      ) : !manifest ? (
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-[0.28em] text-sky-400">Immersive</p>
          <p className="mt-3 text-sm text-slate-300">Opening the preview…</p>
          <div className="shimmer mx-auto mt-5 h-1.5 w-40 rounded-full" />
        </div>
      ) : (
        <div className="w-full max-w-[min(100%,calc((100dvh-6.75rem)*16/9))] overflow-hidden rounded-xl ring-1 ring-white/10">
          <Player
            ref={playerRef}
            component={StoryVideo}
            inputProps={{ slug, manifest } satisfies StoryVideoProps}
            durationInFrames={manifest.durationInFrames}
            compositionWidth={1920}
            compositionHeight={1080}
            fps={FPS}
            style={{ width: "100%" }}
            controls
            autoPlay
            clickToPlay
            loop={false}
            spaceKeyToPlayOrPause
            initiallyShowControls
            numberOfSharedAudioTags={16}
            acknowledgeRemotionLicense
            errorFallback={({ error: playError }) => (
              <div className="flex h-full items-center justify-center bg-[#050810] p-6 text-center text-sm text-red-300">
                {playError.message}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}
