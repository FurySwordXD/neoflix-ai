"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motionCaption } from "@/lib/mapMotion";
import { symbolFor } from "@/lib/mapSymbols";
import type { Story, StoryEvent } from "@/lib/types";
import { CATEGORY_COLORS, CATEGORY_LABELS, formatDate } from "@/lib/ui";
import Timeline from "./Timeline";
import MapSymbolIcon from "./MapSymbolIcon";
import EventDetail from "./EventDetail";
import MobileEventSheet from "./MobileEventSheet";
import PlaybackBar from "./PlaybackBar";
import StoryQueryForm from "./StoryQueryForm";
import RenderVideoButton from "./RenderVideoButton";
import { useCanHover } from "./useCanHover";
import { useIsDesktop } from "./useIsDesktop";
import { useNarration } from "./useNarration";

/** The timeline rail, reused as the desktop column and the mobile drawer. */
function TimelineView(
  props: React.ComponentProps<typeof Timeline> & {
    view: "interactive" | "immersive";
    onViewChange: (view: "interactive" | "immersive") => void;
  }
) {
  return (
    <div className="glass scroll-slim h-full overflow-y-auto rounded-2xl">
      <Timeline {...props} />
    </div>
  );
}

const GlobeView = dynamic(() => import("./GlobeView"), {
  ssr: false,
  loading: () => (
    <div className="glass flex h-full w-full items-center justify-center rounded-2xl">
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
/** Stable "nothing hovered" value, so the reset below never re-renders. */
const NO_EDGE = { top: false, left: false, right: false } as const;
const NARRATION_RATES: Record<number, number> = { 1: 1, 2: 1.2, 4: 1.4 };

interface StoryMapAppProps {
  story: Story;
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
  generating?: boolean;
  generation?: number;
  generationError?: string | null;
  steps?: string[];
  onGenerate: (query: string) => void;
  /** An update pass pulling the latest news into this story is running. */
  refreshing?: boolean;
  refreshSteps?: string[];
  refreshError?: string | null;
  /** Shown when an update pass finished and found nothing new. */
  refreshNotice?: string | null;
  onRefresh?: () => void;
}

export default function StoryMapApp({
  story,
  stories: initialStories,
  generating = false,
  generation = 0,
  generationError = null,
  steps = [],
  onGenerate,
  refreshing = false,
  refreshSteps = [],
  refreshError = null,
  refreshNotice = null,
  onRefresh,
}: StoryMapAppProps) {
  const [stories, setStories] = useState(initialStories);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [view, setView] = useState<"interactive" | "immersive">("interactive");
  const seenEventIds = useRef(new Set<string>());
  const watchingGeneration = useRef(false);
  // On phones the timeline rail eats the globe, so it becomes a swipeable
  // drawer over the map instead of a permanent column.
  const isDesktop = useIsDesktop();
  // Touch screens can't hover, so edge-proximity autohide must not apply there.
  const canHover = useCanHover();
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Desktop-only: tucks the rail away on request, leaving a tab to bring it
  // back. Independent of the playback proximity autohide.
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  // Phones get the focused event as a bottom sheet: a peek card while
  // playing, tapped open for the full write-up.
  const [sheetOpen, setSheetOpen] = useState(false);
  // Playback is cinematic: the chrome steps aside so the globe fills the
  // screen, and each panel slides back in as the pointer nears its edge.
  const [hoverEdge, setHoverEdge] = useState({ top: false, left: false, right: false });
  const edge = canHover ? hoverEdge : NO_EDGE;
  const timelineRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

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

  const select = useCallback((event: StoryEvent) => {
    setSelectedId(event.id);
    // On phones the timeline is a drawer; picking an event should reveal the map.
    setTimelineOpen(false);
  }, []);

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
    if (selectedIndex === -1 || selectedIndex >= events.length) {
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
    if (narrationOn && !narrationFinished) return;
    const atLast = selectedIndex >= events.length - 1;
    const delay = narrationOn ? NARRATION_GAP_MS / speed : stepMs;
    // The last event still gets its step (and voice-over); autoplay stops after it.
    const timer = setTimeout(() => {
      if (atLast) setAutoplay(false);
      selectIndex(selectedIndex + 1);
    }, delay);
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

  // While playing, reveal a panel when the pointer reaches its edge band and
  // keep it out while the pointer stays over the panel itself. Reading the
  // live rect means a docked panel never slides away from under a click.
  useEffect(() => {
    // Proximity is a playback behaviour only: paused, nothing should pop in
    // and out as the pointer wanders.
    if (!canHover || !autoplay) {
      setHoverEdge(NO_EDGE);
      return;
    }
    const TOP_BAND = 108;
    const SIDE_BAND = 96;
    const SLACK = 12;
    function onMove(e: PointerEvent) {
      const tl = timelineRef.current?.getBoundingClientRect();
      const dt = detailRef.current?.getBoundingClientRect();
      setHoverEdge({
        top: e.clientY <= TOP_BAND,
        left: e.clientX <= SIDE_BAND || Boolean(tl && e.clientX <= tl.right + SLACK),
        right:
          e.clientX >= window.innerWidth - SIDE_BAND ||
          Boolean(dt && e.clientX >= dt.left - SLACK),
      });
    }
    onMove({ clientX: -1, clientY: -1 } as PointerEvent);
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [autoplay, canHover]);

  // Only the desktop rail leaves a tab behind when it hides, so the header
  // and status chips stay put on the phone layout.
  const hideChrome = autoplay && canHover && !timelineOpen;
  const headerHidden = hideChrome && !edge.top;
  const detailHidden = hideChrome && !edge.right;
  // The rail hides either because playback moved the chrome aside, or because
  // it was collapsed by hand. Both share one slide and one dock tab.
  const railHides = canHover && (timelineCollapsed || hideChrome);
  // `edge` is only ever set during playback, so a hand-collapsed rail stays
  // put while paused and comes back solely via its dock tab.
  const timelineHidden = railHides && !edge.left;

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
    <div className="relative flex h-dvh w-full flex-col gap-2.5 overflow-hidden p-2.5 sm:gap-3 sm:p-3">
      {/* The globe is the backdrop; everything else floats over it. It stays
          up while a story is being mapped, so events can be watched landing. */}
      {view !== "immersive" && (
        <div className="absolute inset-0 z-0 overflow-hidden">
          <GlobeView
            story={story}
            selected={selected}
            revealedIndex={generating || selectedIndex < 0 ? events.length - 1 : selectedIndex}
            onSelect={select}
          />
        </div>
      )}

      {/* Header — a floating glass bar. Steps aside while playing, unless the
          pointer is at the top of the screen. */}
      <header
        aria-hidden={headerHidden}
        className={`glass z-30 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-3 transition duration-300 ease-out sm:px-5 ${
          headerHidden ? "pointer-events-none -translate-y-[140%] opacity-0" : ""
        }`}
      >
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
        <div className="flex w-full min-w-0 items-center gap-3 overflow-x-auto sm:w-auto sm:flex-1 sm:justify-end sm:overflow-visible">
          <StoryQueryForm busy={generating} onSearch={onGenerate} />
          {!unsaved && onRefresh && story.status === "ongoing" && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Search the web for the latest news on this story"
              className="glass-well shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
            >
              {refreshing ? "⟳ Checking…" : "⟳ Latest news"}
            </button>
          )}
        </div>
      </header>

      {generating && steps.length > 0 && (
        <div
          className={`glass z-30 rounded-xl px-4 py-1.5 transition duration-300 ease-out sm:px-5 ${
            headerHidden ? "pointer-events-none -translate-y-[140%] opacity-0" : ""
          }`}
        >
          <div className="flex items-center gap-2 overflow-x-auto text-[11px] whitespace-nowrap">
            <span className="shrink-0 font-semibold uppercase tracking-wide text-sky-400">
              Agent
            </span>
            {steps.reverse().map((step, i) => (
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
        <p
          className={`z-30 rounded-xl border border-red-500/25 bg-red-950/60 px-4 py-2 text-xs text-red-200 shadow-lg backdrop-blur-xl transition duration-300 ease-out sm:px-5 ${
            headerHidden ? "pointer-events-none -translate-y-[140%] opacity-0" : ""
          }`}
        >
          {generationError}
        </p>
      )}

      {/* Update pass over an open story: progress steps, then the outcome */}
      {refreshing && refreshSteps.length > 0 && (
        <div
          className={`glass z-30 rounded-xl px-4 py-1.5 transition duration-300 ease-out sm:px-5 ${
            headerHidden ? "pointer-events-none -translate-y-[140%] opacity-0" : ""
          }`}
        >
          <div className="flex items-center gap-2 overflow-x-auto text-[11px] whitespace-nowrap">
            <span className="shrink-0 font-semibold uppercase tracking-wide text-emerald-400">
              Update
            </span>
            {refreshSteps.map((step, i) => (
              <span
                key={`${i}-${step}`}
                className={
                  i === refreshSteps.length - 1
                    ? "flex items-center gap-1.5 text-emerald-200"
                    : "text-slate-500 after:mx-1.5 after:text-slate-700 after:content-['›']"
                }
              >
                {i === refreshSteps.length - 1 && (
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                )}
                {step}
              </span>
            ))}
          </div>
        </div>
      )}

      {refreshError && !refreshing && (
        <p
          className={`z-30 rounded-xl border border-amber-500/25 bg-amber-950/60 px-4 py-2 text-xs text-amber-200 shadow-lg backdrop-blur-xl transition duration-300 ease-out sm:px-5 ${
            headerHidden ? "pointer-events-none -translate-y-[140%] opacity-0" : ""
          }`}
        >
          {refreshError}
        </p>
      )}

      {refreshNotice && !refreshing && !refreshError && (
        <p
          className={`glass z-30 rounded-xl px-4 py-2 text-xs text-slate-300 transition duration-300 ease-out sm:px-5 ${
            headerHidden ? "pointer-events-none -translate-y-[140%] opacity-0" : ""
          }`}
        >
          {refreshNotice}
        </p>
      )}

      {view === "immersive" && !unsaved ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 sm:gap-3">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setView("interactive")}
              title="Back to the map and timeline"
              className="glass rounded-lg px-3 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:bg-white/10 hover:text-white"
            >
              ← Interactive
            </button>
            <RenderVideoButton slug={story.slug} />
          </div>
          <ImmersivePreview key={story.slug} slug={story.slug} />
        </div>
      ) : (
        /* Body: the globe fills the whole frame; the timeline and the
           playback bar float over it as glass panels. This layer sits above
           the globe, so it is hit-transparent and each floating panel
           re-enables pointer events for itself. */
        <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col gap-2.5 sm:gap-3">
          {/* Middle row: the floating timeline column beside the map. The row
              is transparent so globe drags and marker clicks reach the canvas
              underneath. */}
          <div className="pointer-events-none relative flex min-h-0 flex-1 gap-2.5 sm:gap-3">
            {/* Desktop: the timeline is a floating column. Mobile: it becomes
                a drawer over the map (below), so the globe gets the screen. */}
            {isDesktop && (
              <>
                {/* Stands in for the panel while it is slid off-screen, so the
                    timeline can be docked again without hunting the edge. */}
                {timelineHidden && (
                  <button
                    type="button"
                    // Collapsed by hand, so the tab undoes that; hidden by
                    // playback, so it just claims the left edge and lets the
                    // pointer keep the panel up on its own.
                    onClick={() =>
                      timelineCollapsed
                        ? setTimelineCollapsed(false)
                        : setHoverEdge((e) => ({ ...e, left: true }))
                    }
                    title="Show the timeline"
                    aria-label="Show the timeline"
                    className="glass pointer-events-auto absolute left-0 top-1/2 z-20 flex -translate-y-1/2 items-center gap-1.5 rounded-l-none rounded-r-xl py-3 pl-2 pr-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300 transition hover:text-white"
                  >
                    <span aria-hidden>▸</span>
                    <span className="[writing-mode:vertical-rl]">Timeline</span>
                  </button>
                )}
                <div
                  ref={timelineRef}
                  aria-hidden={timelineHidden}
                  className={`min-h-0 w-[22rem] min-w-[19rem] shrink-0 transition duration-300 ease-out xl:w-[24rem] ${
                    timelineHidden
                      ? "pointer-events-none -translate-x-[115%] opacity-0"
                      : "pointer-events-auto"
                  }`}
                >
                  <TimelineView
                    story={story}
                    selectedId={selectedId}
                    onSelect={select}
                    autoplay={autoplay}
                    onTogglePlay={togglePlay}
                    generating={generating}
                    view={view}
                    onViewChange={setView}
                    onCollapse={() => setTimelineCollapsed(true)}
                  />
                </div>
              </>
            )}

            {/* Overlays pinned over the globe: status, legend, detail. */}
            <div className="pointer-events-none relative min-h-0 min-w-0 flex-1">
              <div
                aria-hidden={headerHidden}
                className={`glass pointer-events-none absolute left-3 top-3 z-10 max-w-[min(60%,26rem)] rounded-xl px-3 py-2 transition duration-300 ease-out ${
                  headerHidden ? "-translate-y-[140%] opacity-0" : ""
                }`}
              >
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
                      <p className="fade-up mt-2 border-t border-white/10 pt-2 text-[12px] italic leading-snug text-slate-200">
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

              {/* Category legend — hidden while focused so the source cards
                  and event details get the room. */}
              {!selected && (
                <div
                  aria-hidden={detailHidden}
                  className={`glass pointer-events-none absolute right-3 top-3 z-10 hidden rounded-xl px-3 py-2 transition duration-300 ease-out sm:block ${
                    detailHidden ? "-translate-y-[140%] opacity-0" : ""
                  }`}
                >
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
                      <div key={cat} className="flex items-center gap-1.5" style={{ color }}>
                        <span className="grid h-4 w-4 place-items-center rounded-[4px] border border-current bg-[#0c1220]">
                          <MapSymbolIcon
                            symbol={symbolFor(cat as StoryEvent["category"])}
                            size={10}
                          />
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-slate-400">
                          {CATEGORY_LABELS[cat as StoryEvent["category"]]}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Mobile: opens the timeline drawer. It steps aside while the
                  drawer is open, where the drawer supplies its own controls. */}
              {!isDesktop && (
                <button
                  type="button"
                  onClick={() => setTimelineOpen(true)}
                  title="Open the timeline"
                  aria-hidden={timelineOpen}
                  className={`glass pointer-events-auto absolute left-3 z-20 rounded-full px-3.5 py-2 text-[11px] font-semibold text-slate-200 transition-all duration-300 ease-out hover:text-white ${
                    selected ? "bottom-[7.5rem]" : "bottom-3"
                  } ${timelineOpen ? "pointer-events-none scale-90 opacity-0" : ""}`}
                >
                  ☰ Timeline
                </button>
              )}

              {/* Mobile: the timeline slides up over the map. */}
              {!isDesktop && timelineOpen && (
                <div className="pointer-events-auto absolute inset-0 z-30">
                  <button
                    type="button"
                    aria-label="Close the timeline"
                    onClick={() => setTimelineOpen(false)}
                    className="absolute inset-0 h-full w-full cursor-default bg-slate-950/40 backdrop-blur-[2px]"
                  />
                  <div className="glass-solid pointer-events-auto fade-up absolute inset-x-2 bottom-2 top-2 overflow-hidden rounded-2xl">
                    <TimelineView
                      story={story}
                      selectedId={selectedId}
                      onSelect={select}
                      autoplay={autoplay}
                      onTogglePlay={togglePlay}
                      generating={generating}
                      view={view}
                      onViewChange={setView}
                      onCollapse={() => setTimelineOpen(false)}
                    />
                  </div>
                </div>
              )}

              {/* Desktop: the event docks in the right column. Phones get the
                  bottom sheet instead, rendered outside this row below. */}
              {isDesktop && selected && (
                <div
                  ref={detailRef}
                  aria-hidden={detailHidden}
                  className={`pointer-events-auto absolute inset-y-0 right-0 z-20 flex min-h-0 w-[26rem] max-w-[min(26rem,42vw)] flex-col transition duration-300 ease-out ${
                    detailHidden ? "pointer-events-none translate-x-[108%] opacity-0" : ""
                  }`}
                >
                  <EventDetail
                    story={story}
                    event={selected}
                    onClose={() => {
                      setAutoplay(false);
                      setSelectedId(null);
                    }}
                  />
                </div>
              )}

              {/* Phones: the focused event as a peek card that expands into a
                  bottom sheet. It lives inside the map frame so it rests just
                  above the transport bar, keeping transport reachable. While
                  playback runs it stays collapsed, so the globe keeps the
                  screen and the card only ever peeks. */}
              {!isDesktop && selected && !timelineOpen && (
                <MobileEventSheet
                  key={selected.id}
                  story={story}
                  event={selected}
                  index={selectedIndex}
                  total={events.length}
                  expanded={sheetOpen}
                  onExpand={() => {
                    setAutoplay(false);
                    setSheetOpen(true);
                  }}
                  onCollapse={() => setSheetOpen(false)}
                  onClose={() => {
                    setAutoplay(false);
                    setSheetOpen(false);
                    setSelectedId(null);
                  }}
                />
              )}
            </div>
          </div>

          {/* Full-width transport bar, under the timeline and the map. */}
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
      )}
    </div>
  );
}