"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe from "react-globe.gl";
import type { Group } from "three";
import { applyCampaignArrow, mountCampaignArrow, type CampaignDatum } from "@/lib/campaignArrow";
import {
  fadeColor,
  motionCameraAltitude,
  motionLegs,
  motionSpanDeg,
} from "@/lib/mapMotion";
import { actorSymbol, symbolFor } from "@/lib/mapSymbols";
import type { Story, StoryEvent } from "@/lib/types";
import { CATEGORY_COLORS, magnitudeToRadius } from "@/lib/ui";
import { buildBadge } from "./globeBadges";
import { buildSourceCards, type SourceCardsAnchor } from "./globeSourceCards";

interface GlobePoint {
  lat: number;
  lng: number;
  color: string;
  size: number;
  radius: number;
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
  stroke: number;
  dashLength: number;
  dashGap: number;
  dashTime: number;
  altitudeScale: number;
}

interface GlobeRing {
  lat: number;
  lng: number;
  color: string;
  maxRadius: number;
  speed: number;
  period: number;
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
const ringColor = (ring: object) => fadeColor((ring as GlobeRing).color);
const ringMaxRadius = (ring: object) => (ring as GlobeRing).maxRadius;
const ringPropagationSpeed = (ring: object) => (ring as GlobeRing).speed;
const ringRepeatPeriod = (ring: object) => (ring as GlobeRing).period;
const pointRadiusOf = (point: object) => (point as GlobePoint).radius;
const arcStrokeOf = (arc: object) => (arc as GlobeArc).stroke;
const arcDashLengthOf = (arc: object) => (arc as GlobeArc).dashLength;
const arcDashGapOf = (arc: object) => (arc as GlobeArc).dashGap;
const arcDashAnimateTimeOf = (arc: object) => (arc as GlobeArc).dashTime;
const arcAltitudeScaleOf = (arc: object) => (arc as GlobeArc).altitudeScale;
const campaignObject = (datum: object) => mountCampaignArrow(datum as CampaignDatum);
const campaignUpdate = (obj: object, datum: object) =>
  applyCampaignArrow(obj as Group, datum as CampaignDatum);

type MapHtml =
  | { type: "badge"; lat: number; lng: number; event: StoryEvent; selected: boolean; dim: boolean }
  | ({ type: "cards" } & SourceCardsAnchor);

function renderMapHtml(
  datum: object,
  onSelect: { current: (event: StoryEvent) => void }
) {
  const item = datum as MapHtml;
  if (item.type === "badge") {
    return buildBadge(item.event, item.selected, item.dim, () => onSelect.current(item.event));
  }
  return buildSourceCards(item.event);
}

function placeOf(event: StoryEvent) {
  return {
    name: event.location.name,
    lat: event.location.lat,
    lng: event.location.lng,
  };
}

/**
 * The world map: night-side Earth, event markers sized by magnitude,
 * chronological arcs, and a motion that illustrates the focused event.
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
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const htmlElement = useRef((datum: object) => renderMapHtml(datum, onSelectRef)).current;
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

  // Fly the camera to the selected event, far enough back to see its motion.
  // Idle → slow auto-rotation.
  useEffect(() => {
    if (!globeRef.current) return;
    if (selected) {
      const span = selected.motion ? motionSpanDeg(placeOf(selected), selected.motion) : 0;
      globeRef.current.pointOfView(
        {
          lat: selected.location.lat,
          lng: selected.location.lng,
          altitude: motionCameraAltitude(span),
        },
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
    const markers: GlobePoint[] = [...latestByPlace.values()].map((e) => {
      const isCurrent = e.id === selected?.id;
      return {
        lat: e.location.lat,
        lng: e.location.lng,
        color: `${CATEGORY_COLORS[e.category]}${!selected || isCurrent ? "" : "8c"}`,
        size: magnitudeToRadius(e) * 0.04,
        radius: 0.12,
        eventId: e.id,
        label: `${e.title} (${e.location.name})`,
      };
    });
    return markers;
  }, [story, revealedIndex, selected]);

  // One animation at a time keeps the map readable: the focused event, or
  // with nothing focused, the latest revealed event that has a motion.
  const illustrated = useMemo(() => {
    if (selected) return [selected];
    const revealed = story.events.slice(0, revealedIndex + 1);
    const latest = [...revealed].reverse().find((event) => event.motion);
    return latest ? [latest] : [];
  }, [story, revealedIndex, selected]);

  const arcs: GlobeArc[] = useMemo(() => {
    const out: GlobeArc[] = [];
    const last = Math.min(revealedIndex, story.events.length - 1);
    const currentIndex = selected ? story.events.findIndex((e) => e.id === selected.id) : last;
    for (let i = 1; i <= last; i++) {
      const from = story.events[i - 1];
      const to = story.events[i];
      // Only the hop into the current event moves; the trail behind it is a quiet line.
      const live = i === currentIndex;
      out.push({
        startLat: from.location.lat,
        startLng: from.location.lng,
        endLat: to.location.lat,
        endLng: to.location.lng,
        color: live
          ? [CATEGORY_COLORS[from.category], CATEGORY_COLORS[to.category]]
          : ["rgba(148,163,184,0.22)", "rgba(148,163,184,0.22)"],
        eventId: to.id,
        stroke: live ? 0.45 : 0.25,
        dashLength: live ? 0.4 : 1,
        dashGap: live ? 0.2 : 0,
        dashTime: live ? 2500 : 0,
        altitudeScale: 0.4,
      });
    }
    return out;
  }, [story, revealedIndex, selected]);

  const rings: GlobeRing[] = useMemo(() => {
    const out: GlobeRing[] = [];
    if (selected && !selected.motion) {
      out.push({
        lat: selected.location.lat,
        lng: selected.location.lng,
        color: "#38bdf8",
        maxRadius: 3,
        speed: 1.6,
        period: 900,
      });
    }
    for (const event of illustrated) {
      const motion = event.motion;
      if (!motion) continue;
      const color = CATEGORY_COLORS[event.category];
      if (motion.kind === "encircle") {
        out.push({
          lat: event.location.lat,
          lng: event.location.lng,
          color,
          maxRadius: motion.radius * 1.05,
          speed: motion.radius * 0.9,
          period: 1400,
        });
        continue;
      }
      if (motion.kind === "launch") {
        out.push({
          lat: motion.to.lat,
          lng: motion.to.lng,
          color,
          maxRadius: 2.6,
          speed: 4,
          period: 1700,
        });
        continue;
      }
      if (motion.kind !== "spread" && motion.kind !== "impact") continue;
      if (motion.kind === "impact") {
        out.push({
          lat: event.location.lat,
          lng: event.location.lng,
          color,
          maxRadius: 3.4,
          speed: 6,
          period: 520,
        });
        continue;
      }
      const speed = Math.max(0.55, motion.radius / 5);
      for (let i = 0; i < 1; i++) {
        out.push({
          lat: event.location.lat,
          lng: event.location.lng,
          color,
          maxRadius: motion.radius,
          speed,
          period: 1700 + i * 700,
        });
      }
    }
    return out;
  }, [illustrated, selected]);

  const arrows: CampaignDatum[] = useMemo(() => {
    const out: CampaignDatum[] = [];
    for (const event of illustrated) {
      if (!event.motion) continue;
      const token = actorSymbol(event.motion);
      const legs = motionLegs(placeOf(event), event.motion);
      legs.forEach((leg, index) => {
        out.push({
          id: `${event.id}:${index}:${leg.from.lat},${leg.from.lng}:${leg.to.lat},${leg.to.lng}`,
          startLat: leg.from.lat,
          startLng: leg.from.lng,
          endLat: leg.to.lat,
          endLng: leg.to.lng,
          color: CATEGORY_COLORS[event.category],
          focused: selected?.id === event.id,
          phase: leg.delay ?? 0,
          token,
          lofted: Boolean(leg.lofted),
          side: leg.side ?? 0,
          short: Boolean(leg.short),
          bare: Boolean(leg.bare),
        });
      });
    }
    return out;
  }, [illustrated, selected]);

  const htmlPins: MapHtml[] = useMemo(() => {
    const latest = new Map<string, StoryEvent>();
    for (const event of story.events.slice(0, revealedIndex + 1)) {
      latest.set(`${event.location.lat},${event.location.lng}`, event);
    }
    if (selected) {
      latest.set(`${selected.location.lat},${selected.location.lng}`, selected);
    }
    const pins: MapHtml[] = [...latest.values()].map((event) => ({
      type: "badge",
      lat: event.location.lat,
      lng: event.location.lng,
      event,
      selected: event.id === selected?.id,
      dim: Boolean(selected) && event.id !== selected?.id,
    }));
    if (selected) {
      pins.push({
        type: "cards",
        lat: selected.location.lat,
        lng: selected.location.lng,
        event: selected,
      });
    }
    return pins;
  }, [story, revealedIndex, selected]);

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
        pointsMerge={false}
        pointRadius={pointRadiusOf}
        onPointClick={handlePointClick}
        arcsData={arcs}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor="color"
        arcAltitudeAutoScale={arcAltitudeScaleOf}
        arcStroke={arcStrokeOf}
        arcDashLength={arcDashLengthOf}
        arcDashGap={arcDashGapOf}
        arcDashAnimateTime={arcDashAnimateTimeOf}
        arcsTransitionDuration={0}
        onArcClick={handlePointClick}
        customLayerData={arrows}
        customThreeObject={campaignObject}
        customThreeObjectUpdate={campaignUpdate}
        ringsData={rings}
        ringLat="lat"
        ringLng="lng"
        ringColor={ringColor}
        ringMaxRadius={ringMaxRadius}
        ringPropagationSpeed={ringPropagationSpeed}
        ringRepeatPeriod={ringRepeatPeriod}
        htmlElementsData={htmlPins}
        htmlLat="lat"
        htmlLng="lng"
        htmlAltitude={0.01}
        htmlElement={htmlElement}
      />

    </div>
  );
});