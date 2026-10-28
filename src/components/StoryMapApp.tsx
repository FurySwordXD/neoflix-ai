"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motionCaption } from "@/lib/mapMotion";
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
  story: Story;
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
  generating?: boolean;
  generation?: number;
  generationError?: string | null;
  steps?: string[];
  onGenerate: (query: string) => void;
}

export default function StoryMapApp({
  story,
  stories: initialStories,
  generating = false,
  generation = 0,
  generationError = null,
  steps = [],
  onGenerate,
}: StoryMapAppProps) {
  const [stories, setStories] = useState(initialStories);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [view, setView] = useState<"interactive" | "immersive">("interactive");
  const seenEventIds = useRef(new Set<string>());
  const watchingGeneration = useRef(false);

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

  // A story still being mapped (or one that failed) is not saved, so it has no voice-over.
  const unsaved = generating || story.slug === "generating";
  const [narrationOn, setNarrationOn] = useState(false);
  const narration = useNarration({
    enabled: narrationOn && !unsaved,
    paused: !autoplay,
    slug: story.slug,
    event: unsaved ? null : selected,
    nextEvent: unsaved
      ? null
      : selectedIndex >= 0
        ? (events[selectedIndex + 1] ?? null)
        : (events[0] ?? null),
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
    if (generating) return;
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
  }, [autoplay, events, selectedIndex, generating]);

  // A new search starts clean. While events arrive, follow the newest one.
  useEffect(() => {
    seenEventIds.current = new Set();
    watchingGeneration.current = false;
    setSelectedId(null);
    setAutoplay(false);
    setView("interactive");
  }, [generation]);

  useEffect(() => {
    if (!generating) {
      if (!watchingGeneration.current) {
        seenEventIds.current = new Set(events.map((event) => event.id));
        return;
      }
      watchingGeneration.current = false;
      setSelectedId((current) =>
        current && events.some((event) => event.id === current)
          ? current
          : (events.at(-1)?.id ?? null)
      );
      seenEventIds.current = new Set(events.map((event) => event.id));
      return;
    }

    const fresh = events.filter((event) => !seenEventIds.current.has(event.id));
    for (const event of events) seenEventIds.current.add(event.id);
    if (fresh.length === 0) return;
    watchingGeneration.current = true;
    setAutoplay(false);
    setSelectedId(fresh[fresh.length - 1].id);
  }, [generating, events]);

  useEffect(() => {
    if (generating || story.slug === "generating") return;
    setStories((current) =>
      current.some((item) => item.slug === story.slug)
        ? current
        : [...current, { slug: story.slug, title: story.title, status: story.status }]
    );
  }, [generating, story.slug, story.title, story.status]);

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
          <StoryQueryForm busy={generating} onSearch={onGenerate} />
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
              disabled={unsaved}
              title={generating ? "Available when the story is mapped" : "Preview the video"}
              className={`px-2.5 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                view === "immersive"
                  ? "bg-sky-500 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              Immersive
            </button>
          </div>
          {!unsaved && <RenderVideoButton slug={story.slug} />}
          {generating ? (
            <span className="shrink-0 rounded-full bg-sky-500/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-sky-300 ring-1 ring-sky-500/40">
              <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400 align-middle" />
              {story.events.length === 0 ? "Mapping" : `${story.events.length} placed`}
            </span>
          ) : (
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                story.status === "ongoing"
                  ? "bg-red-500/15 text-red-300 ring-1 ring-red-500/40"
                  : "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30"
              }`}
            >
              {story.status}
            </span>
          )}
        </div>
      </header>

      {generating && steps.length > 0 && (
        <div className="z-30 border-b border-slate-800 bg-slate-950/80 px-5 py-1.5">
          <div className="flex items-center gap-2 overflow-x-auto text-[11px] whitespace-nowrap">
            <span className="shrink-0 font-semibold uppercase tracking-wide text-sky-400">
              Agent
            </span>
            {steps.map((step, i) => (
              <span
                key={i}
                className={
                  i === steps.length - 1
                    ? "flex items-center gap-1.5 text-sky-200"
                    : "text-slate-500 after:mx-1.5 after:text-slate-700 after:content-['›']"
                }
              >
                {i === steps.length - 1 && (
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                )}
                {step}
              </span>
            ))}
          </div>
        </div>
      )}

      {generationError && (
        <p className="z-30 border-b border-red-900/60 bg-red-950/90 px-5 py-2 text-xs text-red-200">
          {generationError}
        </p>
      )}

      {view === "immersive" && !unsaved ? (
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
            generating={generating}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <GlobeView
                story={story}
                selected={selected}
                revealedIndex={generating || selectedIndex < 0 ? events.length - 1 : selectedIndex}
                onSelect={select}
              />

              {/* Status strip over the globe */}
              <div className="pointer-events-none absolute left-3 top-3 max-w-[min(60%,26rem)] rounded-lg border border-slate-800/80 bg-slate-950/70 px-3 py-2 backdrop-blur">
                {selected ? (
                  <>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
                      {generating ? "Just placed" : "Focused event"}
                    </p>
                    <p className="text-[13px] font-semibold text-white">{selected.title}</p>
                    <p className="text-[11px] text-slate-400">
                      {formatDate(selected.timestamp)} · {selected.location.name}
                    </p>
                    {selected.motion && (
                      <p className="mt-1 text-[11px] text-sky-300">
                        {motionCaption(selected.motion)}
                      </p>
                    )}
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
                ) : generating ? (
                  <>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-sky-400">
                      Mapping this story
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Events land on the globe as they are placed.
                    </p>
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
            playDisabled={generating}
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
    </div>
  );
}