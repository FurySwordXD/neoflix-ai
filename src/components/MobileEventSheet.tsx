"use client";

import { useEffect, useRef } from "react";
import type { Story, StoryEvent } from "@/lib/types";
import { CATEGORY_COLORS, CATEGORY_LABELS, formatShortDate } from "@/lib/ui";
import { symbolFor } from "@/lib/mapSymbols";
import EventDetail from "./EventDetail";
import MapSymbolIcon from "./MapSymbolIcon";

interface MobileEventSheetProps {
  story: Story;
  event: StoryEvent;
  /** Saved stories, so a related-story card can say whether it opens or maps. */
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
  /** Which event of how many, for the "3 / 9" readout in the sheet header. */
  index: number;
  total: number;
  expanded: boolean;
  /** Open a related story: the saved one, or a fresh compile if it is not saved. */
  onOpenStory?: (slug: string, title: string) => void;
  /** Jump to a cited event on the timeline (an [e01] chip was tapped). */
  onShowEvent?: (eventId: string) => void;
  onExpand: () => void;
  onCollapse: () => void;
  /** Dismiss the event and stop playback — the sheet's close button. */
  onClose: () => void;
}

/**
 * Phone layout for a focused event.
 *
 * Collapsed, it is a compact card that peeks above the transport bar so the
 * globe stays the subject; tapping it lifts the full write-up as a bottom
 * sheet. On desktop the same event docks in the right-hand column instead.
 */
export default function MobileEventSheet({
  story,
  event,
  stories,
  index,
  total,
  expanded,
  onOpenStory,
  onShowEvent,
  onExpand,
  onCollapse,
  onClose,
}: MobileEventSheetProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // A sheet that opens at the previous event's scroll offset reads as broken.
  useEffect(() => {
    if (expanded) scrollRef.current?.scrollTo({ top: 0 });
  }, [expanded, event.id]);

  // Escape closes the sheet, matching the desktop panel's close button.
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCollapse();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onCollapse]);

  const catColor = CATEGORY_COLORS[event.category];

  return (
    <>
      {/* Scrim: the globe stays visible behind the sheet, so it dims rather
          than blacks out. Tapping anywhere above the sheet closes it. */}
      {expanded && (
        <button
          type="button"
          aria-label="Collapse this event"
          onClick={onCollapse}
          className="fade-in absolute inset-0 z-30 h-full w-full cursor-default bg-slate-950/50 backdrop-blur-[2px]"
        />
      )}

      {/* Height, not max-height: a definite height is what lets the flex chain
          below clamp the write-up so it scrolls inside the sheet instead of
          spilling past the top of the screen. */}
      <div
        ref={scrollRef}
        className={`pointer-events-auto absolute inset-x-2 bottom-0 z-40 flex flex-col overflow-hidden rounded-2xl bg-gradient-to-b from-slate-900/97 to-slate-950/97 shadow-[0_-10px_40px_-12px_rgba(0,0,0,0.9)] ring-1 ring-white/12 backdrop-blur-2xl transition-[height] duration-300 ease-out ${
          expanded ? "h-[calc(100%-0.75rem)]" : "h-[6.25rem]"
        }`}
      >
        {expanded ? (
          <>
            {/* Grab handle — the conventional iOS affordance for "drag or tap
                down to dismiss". */}
            <div className="flex shrink-0 flex-col items-center pt-2.5">
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse this event"
                className="h-1.5 w-10 rounded-full bg-white/25 transition hover:bg-white/40"
              />
            </div>
            <div className="flex min-h-0 flex-1">
              <EventDetail
                story={story}
                event={event}
                stories={stories}
                onOpenStory={onOpenStory}
                onShowEvent={onShowEvent}
                onClose={onClose}
              />
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={onExpand}
            aria-label={`Expand: ${event.title}`}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <span
              className="map-tick pulse-glow shrink-0"
              style={{ color: catColor }}
            >
              <MapSymbolIcon symbol={symbolFor(event.category, event.motion)} size={11} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em]">
                <span style={{ color: catColor }}>{CATEGORY_LABELS[event.category]}</span>
                <span className="text-slate-600">
                  {index + 1} / {total}
                </span>
              </span>
              <span className="mt-1 block text-[13px] font-semibold leading-snug text-white">
                {event.title}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                {formatShortDate(event.timestamp)} · {event.location.name},{" "}
                {event.location.country}
              </span>
            </span>
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] text-slate-300"
            >
              ▲
            </span>
          </button>
        )}
      </div>
    </>
  );
}
