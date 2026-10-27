"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe from "react-globe.gl";
import type { Story, StoryEvent } from "@/lib/types";
import { CATEGORY_COLORS, magnitudeToRadius } from "@/lib/ui";
import { buildSourceCards, type SourceCardsAnchor } from "./globeSourceCards";

interface GlobePoint {
  lat: number;
  lng: number;
  color: string;
  size: number;
  eventId: string;
  label: string;
}

interface GlobeArc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: [string, string];
  eventId: string;
}

interface GlobeRing {
  lat: number;
  lng: number;
  color: string;
}

interface GlobeViewProps {
  story: Story;
  selected: StoryEvent | null;
  /** How many chronological events are "revealed" (arcs drawn up to it). */
  revealedIndex: number;
  onSelect: (event: StoryEvent) => void;
}

// Layer accessors must keep their identity across renders: globe.gl rebuilds a
// whole layer (re-dealing the source cards, restarting rings) whenever one changes.
const ringColor = () => (t: number) => `rgba(56,189,248,${1 - t})`;
const sourceCardsElement = (d: object) =>
  buildSourceCards((d as SourceCardsAnchor).event);

/**
 * The world map: night-side Earth, event markers sized by magnitude,
 * chronological arcs, and a pulse ring on the selected event.
 * Loaded with ssr:false — three.js needs the browser.
 */
export default memo(function GlobeView({
  story,
  selected,
  revealedIndex,
  onSelect,
}: GlobeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  // Track container size so the globe always fills its panel.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fly the camera to the selected event; idle → slow auto-rotation.
  useEffect(() => {
    if (!globeRef.current) return;
    if (selected) {
      globeRef.current.pointOfView(
        { lat: selected.location.lat, lng: selected.location.lng, altitude: 1.6 },
        1000
      );
      globeRef.current.controls().autoRotate = false;
    } else {
      globeRef.current.controls().autoRotate = true;
      globeRef.current.controls().autoRotateSpeed = 0.35;
    }
  }, [selected]);

  // Only events that have "happened" by the playhead are on the map; past
  // ones are dimmed so the current event stands out. Each place keeps just
  // its latest event so markers at the same spot don't stack.
  const points: GlobePoint[] = useMemo(() => {
    const latestByPlace = new Map<string, StoryEvent>();
    for (const e of story.events.slice(0, revealedIndex + 1)) {
      latestByPlace.set(`${e.location.lat},${e.location.lng}`, e);
    }
    return [...latestByPlace.values()].map((e) => {
      const isCurrent = e.id === selected?.id;
      return {
        lat: e.location.lat,
        lng: e.location.lng,
        color: `${CATEGORY_COLORS[e.category]}${!selected || isCurrent ? "" : "8c"}`,
        size: magnitudeToRadius(e) * 0.08,
        eventId: e.id,
        label: `${e.title} (${e.location.name})`,
      };
    });
  }, [story, revealedIndex, selected]);

  const arcs: GlobeArc[] = useMemo(() => {
    const out: GlobeArc[] = [];
    for (let i = 1; i <= Math.min(revealedIndex, story.events.length - 1); i++) {
      const from = story.events[i - 1];
      const to = story.events[i];
      out.push({
        startLat: from.location.lat,
        startLng: from.location.lng,
        endLat: to.location.lat,
        endLng: to.location.lng,
        color: [CATEGORY_COLORS[from.category], CATEGORY_COLORS[to.category]],
        eventId: to.id,
      });
    }
    return out;
  }, [story, revealedIndex]);

  const rings: GlobeRing[] = useMemo(
    () =>
      selected
        ? [
            {
              lat: selected.location.lat,
              lng: selected.location.lng,
              color: CATEGORY_COLORS[selected.category],
            },
          ]
        : [],
    [selected]
  );

  const sourceCards: SourceCardsAnchor[] = useMemo(
    () =>
      selected
        ? [{ lat: selected.location.lat, lng: selected.location.lng, event: selected }]
        : [],
    [selected]
  );

  const handlePointClick = useCallback(
    (point: object) => {
      const { eventId } = point as GlobePoint;
      const event = story.events.find((e) => e.id === eventId);
      if (event) onSelect(event);
    },
    [story, onSelect]
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <Globe
        ref={globeRef}
        width={size.width}
        height={size.height}
        globeImageUrl="/globe/earth-night.jpg"
        bumpImageUrl="/globe/earth-topology.png"
        backgroundColor="rgba(0,0,0,0)"
        atmosphereColor="#38bdf8"
        atmosphereAltitude={0.18}
        pointsData={points}
        pointLat="lat"
        pointLng="lng"
        pointColor="color"
        pointAltitude="size"
        pointRadius={0.32}
        pointsMerge={false}
        onPointClick={handlePointClick}
        arcsData={arcs}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor="color"
        arcAltitudeAutoScale={0.4}
        arcStroke={0.5}
        arcDashLength={0.4}
        arcDashGap={0.2}
        arcDashAnimateTime={2500}
        ringsData={rings}
        ringLat="lat"
        ringLng="lng"
        ringColor={ringColor}
        ringMaxRadius={3}
        ringPropagationSpeed={1.6}
        ringRepeatPeriod={900}
        htmlElementsData={sourceCards}
        htmlLat="lat"
        htmlLng="lng"
        htmlAltitude={0.01}
        htmlElement={sourceCardsElement}
      />

      {/* Legend — hidden while focused so it doesn't crowd the source cards */}
      {!selected && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-lg border border-slate-800/80 bg-slate-950/70 px-3 py-2 backdrop-blur">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
              <div key={cat} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {cat}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});