"use client";

import { useMemo, useRef, useState } from "react";
import type { StoryEvent } from "@/lib/types";
import { CATEGORY_COLORS, formatDate } from "@/lib/ui";
import type { NarrationStatus } from "./useNarration";

export const PLAYBACK_SPEEDS = [1, 2, 4] as const;

interface PlaybackBarProps {
  events: StoryEvent[];
  selectedIndex: number;
  playing: boolean;
  speed: number;
  /** Duration of one autoplay step, used to animate the step progress. */
  stepMs: number;
  onSelectIndex: (index: number) => void;
  onTogglePlay: () => void;
  /** Play stays off while a story is still being mapped. */
  playDisabled?: boolean;
  onSpeedChange: (speed: number) => void;
  onScrubStart: () => void;
  narrationOn: boolean;
  narrationStatus: NarrationStatus;
  onToggleNarration: () => void;
  /** Step progress (0–1) driven by narration; null uses the timed animation. */
  stepProgress: number | null;
}

interface Section {
  label: string;
  start: number;
  end: number;
}

/**
 * Bottom transport bar: play/pause, step, speed, a scrubbable track with one
 * tick per event, and year sections you can jump to. Events are spaced
 * evenly (not by time) so dense periods like early 2020 stay clickable.
 */
export default function PlaybackBar({
  events,
  selectedIndex,
  playing,
  speed,
  stepMs,
  onSelectIndex,
  onTogglePlay,
  playDisabled = false,
  onSpeedChange,
  onScrubStart,
  narrationOn,
  narrationStatus,
  onToggleNarration,
  stepProgress,
}: PlaybackBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const n = events.length;
  const pos = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const halfStep = n > 1 ? 50 / (n - 1) : 50;

  const sections: Section[] = useMemo(() => {
    const out: Section[] = [];
    events.forEach((e, i) => {
      const year = e.timestamp.slice(0, 4);
      const last = out[out.length - 1];
      if (last && last.label === year) last.end = i;
      else out.push({ label: year, start: i, end: i });
    });
    return out;
  }, [events]);

  function indexAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return 0;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(frac * (n - 1));
  }

  function scrubTo(clientX: number) {
    const i = indexAt(clientX);
    if (i !== selectedIndex) onSelectIndex(i);
  }

  const current = selectedIndex >= 0 ? events[selectedIndex] : null;
  const hovered = hoverIndex !== null ? events[hoverIndex] : null;
  const showStepFill = playing && selectedIndex >= 0 && selectedIndex < n - 1;

  const btn =
    "flex h-8 w-8 items-center justify-center rounded-md text-sm text-slate-300 ring-1 ring-slate-700 transition hover:bg-slate-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="z-20 border-t border-slate-800 bg-slate-950/90 px-5 pb-3 pt-2 backdrop-blur">
      <div className="flex items-center gap-4">
        {/* Transport controls */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className={btn}
            onClick={() => onSelectIndex(Math.max(0, selectedIndex - 1))}
            disabled={selectedIndex <= 0}
            title="Previous event (←)"
          >
            ⏮
          </button>
          <button
            className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              playing
                ? "bg-sky-500 text-white shadow-[0_0_16px_rgba(56,189,248,0.5)] hover:bg-sky-400"
                : "bg-slate-100 text-slate-900 hover:bg-white"
            }`}
            onClick={onTogglePlay}
            disabled={playDisabled}
            title="Play / pause (space)"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            className={btn}
            onClick={() => onSelectIndex(Math.min(n - 1, selectedIndex + 1))}
            disabled={selectedIndex >= n - 1}
            title="Next event (→)"
          >
            ⏭
          </button>
          <button
            className={`${btn} w-10 text-[11px] font-semibold`}
            onClick={() => {
              const i = PLAYBACK_SPEEDS.indexOf(speed as (typeof PLAYBACK_SPEEDS)[number]);
              onSpeedChange(PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length]);
            }}
            title="Playback speed"
          >
            {speed}×
          </button>
          <button
            className={`${btn} w-auto gap-1 px-2 text-[11px] font-semibold ${
              narrationOn ? "bg-sky-500/15 text-sky-300 ring-sky-500/50" : ""
            }`}
            onClick={onToggleNarration}
            title={narrationOn ? "Turn voice-over off" : "Turn voice-over on"}
          >
            <span className={narrationStatus === "loading" ? "animate-pulse" : ""}>
              {narrationOn ? "🔊" : "🔇"}
            </span>
            Voice
          </button>
        </div>

        {/* Track */}
        <div className="relative min-w-0 flex-1 px-2">
          {/* Year sections */}
          <div className="relative h-5">
            {sections.map((s) => {
              const center = (pos(s.start) + pos(s.end)) / 2;
              const active =
                selectedIndex >= s.start && selectedIndex <= s.end;
              return (
                <button
                  key={s.label}
                  onClick={() => onSelectIndex(s.start)}
                  className={`absolute top-0 -translate-x-1/2 rounded px-1.5 text-[10px] font-semibold tracking-wider transition ${
                    active
                      ? "text-sky-300"
                      : "text-slate-500 hover:text-slate-200"
                  }`}
                  style={{ left: `${center}%` }}
                  title={`Jump to ${s.label}`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          <div
            ref={trackRef}
            className="relative h-8 cursor-pointer touch-none select-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dragging.current = true;
              onScrubStart();
              scrubTo(e.clientX);
            }}
            onPointerMove={(e) => {
              if (dragging.current) scrubTo(e.clientX);
              setHoverIndex(indexAt(e.clientX));
            }}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
            onPointerLeave={() => setHoverIndex(null)}
          >
            {/* Alternating year bands */}
            {sections.map((s, i) => {
              const left = Math.max(0, pos(s.start) - halfStep);
              const right = Math.min(100, pos(s.end) + halfStep);
              return (
                <div
                  key={s.label}
                  className={`absolute inset-y-1 rounded ${
                    i % 2 === 0 ? "bg-slate-800/40" : "bg-slate-800/15"
                  }`}
                  style={{ left: `${left}%`, width: `${right - left}%` }}
                />
              );
            })}

            {/* Base line + progress */}
            <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-slate-700/70" />
            <div
              className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-sky-400 transition-[width] duration-300"
              style={{ width: `${selectedIndex >= 0 ? pos(selectedIndex) : 0}%` }}
            />
            {showStepFill && (
              <div
                className="absolute top-1/2 h-[3px] -translate-y-1/2 overflow-hidden"
                style={{
                  left: `${pos(selectedIndex)}%`,
                  width: `${pos(selectedIndex + 1) - pos(selectedIndex)}%`,
                }}
              >
                {stepProgress !== null ? (
                  <div
                    className="h-full w-full origin-left rounded-full bg-sky-400/50 transition-transform duration-300 ease-linear"
                    style={{ transform: `scaleX(${stepProgress})` }}
                  />
                ) : (
                  <div
                    key={`${selectedIndex}-${stepMs}`}
                    className="h-full w-full origin-left rounded-full bg-sky-400/50"
                    style={{ animation: `step-fill ${stepMs}ms linear forwards` }}
                  />
                )}
              </div>
            )}

            {/* Event ticks */}
            {events.map((e, i) => {
              const isCurrent = i === selectedIndex;
              const isPast = selectedIndex >= 0 && i < selectedIndex;
              return (
                <span
                  key={e.id}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all"
                  style={{
                    left: `${pos(i)}%`,
                    width: isCurrent ? 14 : 9,
                    height: isCurrent ? 14 : 9,
                    backgroundColor: CATEGORY_COLORS[e.category],
                    opacity: isCurrent || isPast ? 1 : 0.45,
                    boxShadow: isCurrent
                      ? `0 0 0 3px #020617, 0 0 12px ${CATEGORY_COLORS[e.category]}`
                      : "0 0 0 2px #020617",
                  }}
                />
              );
            })}

            {/* Hover tooltip */}
            {hovered && hoverIndex !== null && (
              <div
                className="pointer-events-none absolute bottom-full z-30 mb-1 w-max max-w-[240px] -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 shadow-xl"
                style={{ left: `${pos(hoverIndex)}%` }}
              >
                <div className="truncate text-[11px] font-medium text-white">
                  {hovered.title}
                </div>
                <div className="text-[10px] text-slate-400">
                  {formatDate(hovered.timestamp)} · {hovered.location.name}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Readout */}
        <div className="w-28 shrink-0 text-right">
          <div className="text-[13px] font-semibold tabular-nums text-white">
            {selectedIndex >= 0 ? selectedIndex + 1 : 0}
            <span className="text-slate-500"> / {n}</span>
          </div>
          <div className="truncate text-[11px] text-slate-400">
            {current ? formatDate(current.timestamp) : "Not started"}
          </div>
        </div>
      </div>
    </div>
  );
}
