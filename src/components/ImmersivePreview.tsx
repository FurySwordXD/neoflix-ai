"use client";

import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useRef, useState } from "react";
import { StoryVideo, type StoryVideoProps } from "../../remotion/StoryVideo";
import { FPS, type VideoManifest } from "../../remotion/types";

/**
 * Plays the story composition live, so immersive view can be watched without encoding the mp4.
 *
 * The player is letterboxed into the space the layout actually gives it: the
 * stage is an absolutely-positioned inset (so its size comes from the parent
 * layout, not from the player inside it) and is measured with a
 * ResizeObserver, so mobile chrome, banners, or button rows all shrink or
 * grow the video instead of a fixed `100dvh` guess.
 */
export default function ImmersivePreview({ slug }: { slug: string }) {
  const playerRef = useRef<PlayerRef>(null);
  const [manifest, setManifest] = useState<VideoManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // The measured stage box; the player is letterboxed inside it.
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);

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

  // Track the real available space, including on resize and rotation.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) {
        setStage({ w: box.width, h: box.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [manifest]);

  // Portrait stages get the 9:16 mobile composition; landscape stages get the
  // 16:9 desktop one. The player is letterboxed into the measured stage at the
  // chosen aspect.
  const portrait = stage ? stage.h >= stage.w : false;
  const aspect = portrait ? 9 / 16 : 16 / 9;
  const playerSize = stage
    ? {
        width: Math.min(stage.w, stage.h * aspect),
        height: Math.min(stage.h, stage.w / aspect),
      }
    : null;

  return (
    <div className="glass relative min-h-0 flex-1 rounded-2xl">
      {error ? (
        <div className="flex h-full items-center justify-center p-6">
          <p className="max-w-md text-center text-sm text-red-300">{error}</p>
        </div>
      ) : !manifest ? (
        <div className="flex h-full items-center justify-center">
          <div className="text-center">
            <p className="text-[11px] uppercase tracking-[0.28em] text-sky-400">Immersive</p>
            <p className="mt-3 text-sm text-slate-300">Opening the preview…</p>
            <div className="shimmer mx-auto mt-5 h-1.5 w-40 rounded-full" />
          </div>
        </div>
      ) : (
        <div
          ref={stageRef}
          className="absolute inset-3 flex items-center justify-center sm:inset-5"
        >
          {playerSize && (
            <div
              className="overflow-hidden rounded-xl ring-1 ring-white/10"
              style={{ width: playerSize.width, height: playerSize.height }}
            >
              <Player
                ref={playerRef}
                component={StoryVideo}
                inputProps={{ slug, manifest } satisfies StoryVideoProps}
                durationInFrames={manifest.durationInFrames}
                compositionWidth={portrait ? 1080 : 1920}
                compositionHeight={portrait ? 1920 : 1080}
                fps={FPS}
                style={{ width: "100%", height: "100%" }}
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
      )}
    </div>
  );
}
