"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Story, StoryEvent } from "@/lib/types";
import { formatDate } from "@/lib/ui";
import Timeline from "./Timeline";
import EventDetail from "./EventDetail";
import PlaybackBar from "./PlaybackBar";
import StoryQueryForm from "./StoryQueryForm";
import RenderVideoButton from "./RenderVideoButton";
import { useNarration } from "./useNarration";

const GlobeView = dynamic(() => import("./GlobeView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <p className="animate-pulse text-xs uppercase tracking-[0.3em] text-slate-600">
        Spinning up the globe…
      </p>
    </div>
  ),
});

const ImmersivePreview = dynamic(() => import("./ImmersivePreview"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <p className="animate-pulse text-xs uppercase tracking-[0.3em] text-slate-600">
        Opening the preview…
      </p>
    </div>
  ),
});

const AUTOPLAY_MS = 5000;
const NARRATION_GAP_MS = 900;
const NARRATION_RATES: Record<number, number> = { 1: 1, 2: 1.2, 4: 1.4 };

interface StoryMapAppProps {
  initialStory: Story;
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
}

export default function StoryMapApp({ initialStory, stories: initialStories }: StoryMapAppProps) {
  const [story, setStory] = useState<Story>(initialStory);
  const [stories, setStories] = useState(initialStories);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [mapping, setMapping] = useState<{ query: string } | null>(null);
  const [view, setView] = useState<"interactive" | "immersive">("interactive");

  const events = story.events;
  const selected = useMemo(
    () => events.find((e) => e.id === selectedId) ?? null,
    [events, selectedId]
  );
  const selectedIndex = selectedId
    ? events.findIndex((e) => e.id === selectedId)
    : -1;

  const [speed, setSpeed] = useState(1);
  const stepMs = AUTOPLAY_MS / speed;

  const [narrationOn, setNarrationOn] = useState(false);
  const narration = useNarration({
    enabled: narrationOn,
    paused: !autoplay,
    slug: story.slug,
    event: selected,
    nextEvent: selectedIndex >= 0 ? events[selectedIndex + 1] ?? null : events[0] ?? null,
    // Speech gets faster with playback speed, but stays intelligible.
    rate: NARRATION_RATES[speed] ?? 1,
  });
  const narrationFinished =
    narration.status === "done" || narration.status === "error";

  const select = useCallback(
    (event: StoryEvent) => setSelectedId(event.id),
    []
  );

  const selectIndex = useCallback(
    (index: number) => {
      const event = events[index];
      if (event) setSelectedId(event.id);
    },
    [events]
  );

  const togglePlay = useCallback(() => {
    if (autoplay) {
      setAutoplay(false);
      return;
    }
    if (events.length === 0) return;
    // Starting from nothing (or the end) restarts the story immediately.
    if (selectedIndex === -1 || selectedIndex >= events.length - 1) {
      setSelectedId(events[0].id);
    }
    setAutoplay(true);
  }, [autoplay, events, selectedIndex]);

  // Autoplay: walk the story like a Pandemic playthrough. One timeout per
  // step keeps it in sync with manual jumps and the playback bar animation.
  // With narration on, each step lasts as long as its voice-over.
  useEffect(() => {
    if (!autoplay || selectedIndex === -1) return;
    if (selectedIndex >= events.length - 1) {
      setAutoplay(false);
      return;
    }
    if (narrationOn && !narrationFinished) return;
    const delay = narrationOn ? NARRATION_GAP_MS / speed : stepMs;
    const timer = setTimeout(() => selectIndex(selectedIndex + 1), delay);
    return () => clearTimeout(timer);
  }, [
    autoplay,
    selectedIndex,
    events.length,
    stepMs,
    speed,
    selectIndex,
    narrationOn,
    narrationFinished,
  ]);

  useEffect(() => {
    if (view === "immersive") setAutoplay(false);
  }, [view]);

  // Keyboard: space plays/pauses, arrows step through events.
  // Immersive preview uses those keys for the video player.
  useEffect(() => {
    if (view !== "interactive") return;
    function onKey(e: KeyboardEvent) {
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        selectIndex(Math.min(events.length - 1, selectedIndex + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        selectIndex(Math.max(0, selectedIndex - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, togglePlay, selectIndex, selectedIndex, events.length]);

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#050810]">
      {/* Header */}
      <header className="z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-800 bg-slate-950/80 px-4 py-3 backdrop-blur sm:px-5">
        <div className="flex min-w-0 items-center gap-4 lg:max-w-[46%]">
          <a
            href="/"
            aria-label="Dashboard"
            className="flex items-center gap-2 rounded-md hover:text-white"
          >
            <span className="text-lg">🌍</span>
            <span className="text-sm font-bold uppercase tracking-[0.25em] text-slate-200">
              WorldNews
            </span>
          </a>
          <div className="hidden min-w-0 sm:block">
            <h1 className="truncate text-sm font-semibold text-white">
              {story.title}
            </h1>
            <p className="truncate text-[11px] text-slate-500">{story.subtitle}</p>
          </div>
        </div>
        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1 sm:justify-end">
          <StoryQueryForm
            onBusy={(busy, query) => setMapping(busy ? { query } : null)}
            onStory={(next) => {
              setStory(next);
              setSelectedId(null);
              setAutoplay(false);
              setStories((current) =>
                current.some((item) => item.slug === next.slug)
                  ? current
                  : [...current, { slug: next.slug, title: next.title, status: next.status }]
              );
              const url = new URL(window.location.href);
              url.searchParams.set("story", next.slug);
              window.history.replaceState(null, "", `${url.pathname}${url.search}`);
            }}
          />
          <div className="flex shrink-0 overflow-hidden rounded-md ring-1 ring-slate-700">
            <button
              type="button"
              onClick={() => setView("interactive")}
              title="Explore the map and timeline"
              className={`px-2.5 py-1.5 text-[11px] font-semibold transition ${
                view === "interactive"
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              Interactive
            </button>
            <button
              type="button"
              onClick={() => setView("immersive")}
              title="Preview the video"
              className={`px-2.5 py-1.5 text-[11px] font-semibold transition ${
                view === "immersive"
                  ? "bg-sky-500 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              Immersive
            </button>
          </div>
          <RenderVideoButton slug={story.slug} />
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
              story.status === "ongoing"
                ? "bg-red-500/15 text-red-300 ring-1 ring-red-500/40"
                : "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30"
            }`}
          >
            {story.status}
          </span>
        </div>
      </header>

      {view === "immersive" ? (
        <ImmersivePreview key={story.slug} slug={story.slug} />
      ) : (
      /* Body: timeline | (globe + detail) over the playback bar */
      <div className="relative flex min-h-0 flex-1">
        <div className="scroll-slim z-10 w-[22rem] min-w-[19rem] shrink-0 border-r border-slate-800 bg-slate-950/70 backdrop-blur">
          <Timeline
            story={story}
            selectedId={selectedId}
            onSelect={select}
            autoplay={autoplay}
            onTogglePlay={togglePlay}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <GlobeView
                story={story}
                selected={selected}
                revealedIndex={selectedIndex >= 0 ? selectedIndex : events.length - 1}
                onSelect={select}
              />

              {/* Status strip over the globe */}
              <div className="pointer-events-none absolute left-3 top-3 max-w-[min(60%,26rem)] rounded-lg border border-slate-800/80 bg-slate-950/70 px-3 py-2 backdrop-blur">
                {selected ? (
                  <>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
                      Focused event
                    </p>
                    <p className="text-[13px] font-semibold text-white">{selected.title}</p>
                    <p className="text-[11px] text-slate-400">
                      {formatDate(selected.timestamp)} · {selected.location.name}
                    </p>
                    {narration.scriptStatus !== "idle" && (
                      <p className="fade-up mt-2 border-t border-slate-800 pt-2 text-[12px] italic leading-snug text-slate-200">
                        {narrationOn && (
                          <span className="mr-1 not-italic text-sky-400">
                            {narration.status === "playing" ? "🔊" : "🔈"}
                          </span>
                        )}
                        {narration.script ??
                          (narration.scriptStatus === "error"
                            ? "Voice-over unavailable."
                            : "Preparing voice-over…")}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
                      {stories.length > 1 ? `${stories.length} stories tracked` : "Story tracked"}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Pick an event, press ▶ or hit space
                    </p>
                  </>
                )}
              </div>
            </div>

            {selected && (
              <EventDetail
                story={story}
                event={selected}
                onClose={() => {
                  setAutoplay(false);
                  setSelectedId(null);
                }}
              />
            )}
          </div>

          <PlaybackBar
            events={events}
            selectedIndex={selectedIndex}
            playing={autoplay}
            speed={speed}
            stepMs={stepMs}
            onSelectIndex={selectIndex}
            onTogglePlay={togglePlay}
            onSpeedChange={setSpeed}
            onScrubStart={() => setAutoplay(false)}
            narrationOn={narrationOn}
            narrationStatus={narration.status}
            onToggleNarration={() => setNarrationOn((on) => !on)}
            stepProgress={narrationOn ? narration.progress : null}
          />
        </div>
      </div>
      )}

      {mapping && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#050810]/80 backdrop-blur-sm">
          <div className="max-w-sm px-6 text-center">
            <p className="text-[11px] uppercase tracking-[0.28em] text-sky-400">Mapping the story</p>
            <p className="mt-3 text-sm font-medium text-white">{mapping.query}</p>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Checking saved stories, then writing the timeline, places, and sources.
            </p>
            <div className="shimmer mx-auto mt-5 h-1.5 w-40 rounded-full" />
          </div>
        </div>
      )}
    </div>
  );
}