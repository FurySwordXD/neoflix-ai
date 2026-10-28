"use client";

import { useEffect, useRef } from "react";
import { symbolFor } from "@/lib/mapSymbols";
import type { Story, StoryEvent } from "@/lib/types";
import MapSymbolIcon from "./MapSymbolIcon";
import EventImageFigure from "./EventImageFigure";
import {
  BEAT_LABELS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  formatShortDate,
} from "@/lib/ui";

interface TimelineProps {
  story: Story;
  selectedId: string | null;
  onSelect: (event: StoryEvent) => void;
  autoplay: boolean;
  onTogglePlay: () => void;
  generating?: boolean;
}

/** Act header to show above this event: only where the beat changes. */
function chapterFor(events: StoryEvent[], index: number): string | null {
  const beat = events[index].beat;
  if (!beat) return null;
  if (index > 0 && events[index - 1].beat === beat) return null;
  return BEAT_LABELS[beat];
}

/**
 * Left rail: the story's event log, grouped into acts.
 */
export default function Timeline({
  story,
  selectedId,
  onSelect,
  autoplay,
  onTogglePlay,
  generating = false,
}: TimelineProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected entry in view while autoplaying.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-event-id="${selectedId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedId]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-800 px-5 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
            Timeline
          </h2>
          <button
            onClick={onTogglePlay}
            disabled={generating}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              autoplay
                ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40 hover:bg-sky-500/30"
                : "bg-slate-800 text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700"
            }`}
          >
            {autoplay ? "❚❚ Pause" : "▶ Play story"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {generating && story.events.length === 0
            ? "Researching events…"
            : generating
              ? `${story.events.length} placed so far · ${formatShortDate(story.startAt)} →`
              : `${story.events.length} events · ${formatShortDate(story.startAt)} → ${
                  story.endAt ? formatShortDate(story.endAt) : "ongoing"
                }`}
        </p>
      </div>

      <div ref={listRef} className="scroll-slim flex-1 overflow-y-auto px-5 py-4">
        {story.hook && (
          <p className="fade-up mb-4 border-l-2 border-amber-400/50 pl-3 font-serif text-[13px] italic leading-relaxed text-slate-300">
            {story.hook}
          </p>
        )}
        <ol className="relative space-y-1">
          <div className="absolute bottom-2 left-4 top-2 w-px bg-slate-800" />
          {story.events.map((event, i) => {
            const selected = event.id === selectedId;
            const past = selectedId !== null &&
              story.events.findIndex((e) => e.id === selectedId) > i;
            const chapter = chapterFor(story.events, i);
            return (
              <li key={event.id} data-event-id={event.id} className={generating ? "fade-up" : undefined}>
                {chapter && (
                  <div className={`relative z-10 mb-1 flex items-center gap-2 pl-1 ${i > 0 ? "mt-3" : ""}`}>
                    <span className="h-px w-3 bg-slate-700" />
                    <span className="bg-[#050810] pr-1 text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                      {chapter}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => onSelect(event)}
                  className={`group relative flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition ${
                    selected
                      ? "bg-slate-800/80 ring-1 ring-sky-500/50"
                      : "hover:bg-slate-800/40"
                  }`}
                >
                  <span
                    className={`map-tick ${selected ? "pulse-glow" : ""}`}
                    style={{
                      color: CATEGORY_COLORS[event.category],
                      opacity: selected ? 1 : past ? 0.75 : 0.45,
                    }}
                  >
                    <MapSymbolIcon symbol={symbolFor(event.category, event.motion)} size={11} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-[13px] font-medium ${
                          selected ? "text-white" : "text-slate-300 group-hover:text-slate-100"
                        }`}
                      >
                        {event.title}
                      </span>
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                      <span className="text-slate-500">
                        {formatShortDate(event.timestamp)}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="truncate text-slate-500">
                        {event.location.name}, {event.location.country}
                      </span>
                      <span
                        className="rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wider"
                        style={{
                          color: CATEGORY_COLORS[event.category],
                          backgroundColor: `${CATEGORY_COLORS[event.category]}1a`,
                        }}
                      >
                        {CATEGORY_LABELS[event.category]}
                      </span>
                    </span>
                    {selected && event.images && event.images.length > 0 && (
                      <span className="fade-up mt-2 block">
                        <EventImageFigure image={event.images[0]} size="thumb" />
                      </span>
                    )}
                    {selected && (event.narration ?? event.consequence) && (
                      <span className="fade-up mt-1.5 block border-l-2 border-sky-500/40 pl-2 font-serif text-[12px] italic leading-snug text-slate-300">
                        {event.narration ?? event.consequence}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {generating && (
            <li aria-live="polite" className="flex items-start gap-3 px-2 py-2.5">
              <span className="map-tick animate-pulse text-sky-500/60" />
              <span className="min-w-0 flex-1 space-y-1.5 pt-1">
                <span className="shimmer block h-2.5 w-3/4 rounded" />
                <span className="shimmer block h-2 w-1/2 rounded opacity-60" />
              </span>
            </li>
          )}
        </ol>
        {story.epilogue && !generating && (
          <div className="mt-5 border-t border-slate-800 pt-3">
            <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-500">
              Epilogue
            </p>
            <p className="mt-1.5 font-serif text-[13px] italic leading-relaxed text-slate-300">
              {story.epilogue}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}