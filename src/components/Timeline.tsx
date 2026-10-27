"use client";

import { useEffect, useRef } from "react";
import type { Story, StoryEvent } from "@/lib/types";
import {
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
}

/**
 * Left rail: the story's event log, like a strategy game's turn history.
 */
export default function Timeline({
  story,
  selectedId,
  onSelect,
  autoplay,
  onTogglePlay,
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
            className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
              autoplay
                ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40 hover:bg-sky-500/30"
                : "bg-slate-800 text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700"
            }`}
          >
            {autoplay ? "❚❚ Pause" : "▶ Play story"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {story.events.length} events ·{" "}
          {formatShortDate(story.startAt)} →{" "}
          {story.endAt ? formatShortDate(story.endAt) : "ongoing"}
        </p>
      </div>

      <div ref={listRef} className="scroll-slim flex-1 overflow-y-auto px-5 py-4">
        <ol className="relative space-y-1">
          <div className="absolute bottom-2 left-[7px] top-2 w-px bg-slate-800" />
          {story.events.map((event, i) => {
            const selected = event.id === selectedId;
            const past = selectedId !== null &&
              story.events.findIndex((e) => e.id === selectedId) > i;
            return (
              <li key={event.id} data-event-id={event.id}>
                <button
                  onClick={() => onSelect(event)}
                  className={`group relative flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition ${
                    selected
                      ? "bg-slate-800/80 ring-1 ring-sky-500/50"
                      : "hover:bg-slate-800/40"
                  }`}
                >
                  <span
                    className={`relative z-10 mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full ${
                      selected ? "pulse-glow" : ""
                    }`}
                    style={{
                      backgroundColor: CATEGORY_COLORS[event.category],
                      opacity: selected ? 1 : past ? 0.7 : 0.35,
                    }}
                  />
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
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}