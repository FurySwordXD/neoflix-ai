import type { EventMotion, MapPlace, MotionActor } from "./types";

const KINDS = new Set([
  "spread",
  "impact",
  "flow",
  "path",
  "converge",
  "radiate",
  "exchange",
  "encircle",
  "launch",
  "sweep",
]);

const ACTORS = new Set<MotionActor>([
  "troops",
  "people",
  "ships",
  "aircraft",
  "goods",
  "aid",
  "disease",
  "news",
]);

/** Point reached by travelling `distanceDeg` along compass `headingDeg` (0 = north, 90 = east). */
export function destination(
  origin: { lat: number; lng: number },
  headingDeg: number,
  distanceDeg: number
): { lat: number; lng: number } {
  const rad = Math.PI / 180;
  const lat1 = origin.lat * rad;
  const lng1 = origin.lng * rad;
  const bearing = headingDeg * rad;
  const d = distanceDeg * rad;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  const lng = ((((lng2 / rad + 540) % 360) + 360) % 360) - 180;
  return { lat: lat2 / rad, lng };
}

/** Approximate distance in degrees, taking the short way across the date line. */
export function separationDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = a.lat - b.lat;
  let dLng = a.lng - b.lng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLng * cos);
}

export function asMapPlace(raw: unknown): MapPlace | null {
  if (!raw || typeof raw !== "object") return null;
  const place = raw as { name?: unknown; lat?: unknown; lng?: unknown };
  if (typeof place.name !== "string") return null;
  const name = place.name.replace(/\s+/g, " ").trim().slice(0, 80);
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    name,
    lat: Math.round(lat * 10000) / 10000,
    lng: Math.round(lng * 10000) / 10000,
  };
}

function apart(a: { lat: number; lng: number }, b: { lat: number; lng: number }, min = 0.45) {
  return separationDeg(a, b) >= min;
}

function uniquePlaces(raw: unknown, origin: MapPlace, limit: number): MapPlace[] {
  const items = Array.isArray(raw) ? raw : [];
  const kept: MapPlace[] = [];
  for (const item of items) {
    const place = asMapPlace(item);
    if (!place || !apart(place, origin, 0.5)) continue;
    if (kept.some((other) => !apart(other, place, 0.4))) continue;
    kept.push(place);
    if (kept.length >= limit) break;
  }
  return kept;
}

function touches(origin: MapPlace, places: MapPlace[], max = 4): boolean {
  return places.some((place) => separationDeg(origin, place) <= max);
}

/**
 * Keep a motion only when its places are real coordinates and it actually
 * illustrates the event. A bad motion is dropped; the event stays.
 */
export function compileMotion(
  raw: unknown,
  originInput: { name: string; lat: number; lng: number }
): EventMotion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const actor = (raw as { actor?: unknown }).actor;
  const motion = compileShape(raw, originInput);
  if (!motion) return undefined;
  if (typeof actor === "string" && ACTORS.has(actor as MotionActor)) {
    return { ...motion, actor: actor as MotionActor };
  }
  return motion;
}

function compileShape(
  raw: unknown,
  originInput: { name: string; lat: number; lng: number }
): EventMotion | undefined {
  const origin = asMapPlace(originInput);
  if (!origin || !raw || typeof raw !== "object") return undefined;
  const motion = raw as Record<string, unknown>;
  const kind = motion.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined;

  if (kind === "impact") return { kind: "impact" };

  if (kind === "encircle") {
    const radius = Number(motion.radius);
    const clamped = Number.isFinite(radius) ? Math.min(10, Math.max(1, radius)) : 2.5;
    return { kind: "encircle", radius: Math.round(clamped * 10) / 10 };
  }

  if (kind === "sweep") {
    const heading = Number(motion.heading);
    const radius = Number(motion.radius);
    if (!Number.isFinite(heading) || !Number.isFinite(radius)) return undefined;
    return {
      kind: "sweep",
      heading: Math.round(((heading % 360) + 360) % 360),
      radius: Math.round(Math.min(30, Math.max(2, radius)) * 10) / 10,
    };
  }

  if (kind === "exchange") {
    const other = asMapPlace(motion.with);
    if (!other || !apart(origin, other, 0.8)) return undefined;
    return { kind: "exchange", with: other };
  }

  if (kind === "launch") {
    const to = asMapPlace(motion.to);
    if (!to || !apart(origin, to, 0.8)) return undefined;
    return { kind: "launch", to };
  }

  if (kind === "spread") {
    const radius = Number(motion.radius);
    if (!Number.isFinite(radius)) return undefined;
    const clamped = Math.min(28, Math.max(1.5, radius));
    return { kind: "spread", radius: Math.round(clamped * 10) / 10 };
  }

  if (kind === "flow") {
    const explicitFrom = asMapPlace(motion.from);
    const from = explicitFrom ?? origin;
    const to = asMapPlace(motion.to) ?? (explicitFrom ? origin : null);
    if (!to || !apart(from, to, 0.5)) return undefined;
    if (!touches(origin, [from, to])) return undefined;
    return { kind: "flow", from, to };
  }

  if (kind === "path") {
    const points: MapPlace[] = [];
    for (const item of Array.isArray(motion.points) ? motion.points : []) {
      const place = asMapPlace(item);
      if (!place) continue;
      const prev = points[points.length - 1];
      if (prev && !apart(prev, place, 0.35)) continue;
      points.push(place);
      if (points.length >= 6) break;
    }
    if (points.length < 2) return undefined;
    if (!touches(origin, points, 5)) return undefined;
    return { kind: "path", points };
  }

  if (kind === "converge") {
    const from = uniquePlaces(motion.from, origin, 4);
    if (from.length >= 2) return { kind: "converge", from };
    if (from.length === 1) return { kind: "flow", from: from[0], to: origin };
    return undefined;
  }

  if (kind === "radiate") {
    const to = uniquePlaces(motion.to, origin, 4);
    if (to.length >= 2) return { kind: "radiate", to };
    if (to.length === 1) return { kind: "flow", from: origin, to: to[0] };
    return undefined;
  }

  return undefined;
}

export interface MotionLeg {
  from: MapPlace;
  to: MapPlace;
  /** Fly high above the surface instead of hugging it. */
  lofted?: boolean;
  /** Push the arrow sideways so a return leg does not cover the outbound one. */
  side?: -1 | 1;
  /** Fraction of a cycle this leg starts late, so arrows ripple instead of firing together. */
  delay?: number;
  /** Shorter, quicker arrows for a cordon closing in. */
  short?: boolean;
  /** No counter on this arrow; a sibling leg already carries it. */
  bare?: boolean;
}

function unnamed(point: { lat: number; lng: number }): MapPlace {
  return { name: "", lat: point.lat, lng: point.lng };
}

export function motionLegs(origin: MapPlace, motion: EventMotion): MotionLeg[] {
  switch (motion.kind) {
    case "flow":
      return [{ from: motion.from, to: motion.to }];
    case "path": {
      const legs: MotionLeg[] = [];
      for (let i = 1; i < motion.points.length; i++) {
        legs.push({
          from: motion.points[i - 1],
          to: motion.points[i],
          delay: (i - 1) * 0.22,
        });
      }
      return legs;
    }
    case "converge":
      return motion.from.map((place, i) => ({ from: place, to: origin, delay: i * 0.12 }));
    case "radiate":
      return motion.to.map((place, i) => ({ from: origin, to: place, delay: i * 0.12 }));
    case "exchange":
      return [
        { from: origin, to: motion.with, side: 1 },
        { from: motion.with, to: origin, side: 1, delay: 0.5 },
      ];
    case "launch":
      return [{ from: origin, to: motion.to, lofted: true }];
    case "encircle": {
      const legs: MotionLeg[] = [];
      for (let i = 0; i < 6; i++) {
        const outer = unnamed(destination(origin, i * 60 + 15, motion.radius));
        const inner = unnamed(destination(origin, i * 60 + 15, motion.radius * 0.45));
        legs.push({ from: outer, to: inner, short: true, bare: true, delay: i * 0.07 });
      }
      return legs;
    }
    case "sweep": {
      const legs: MotionLeg[] = [];
      const spread = [-28, 0, 28];
      spread.forEach((offset, i) => {
        const reach = offset === 0 ? motion.radius : motion.radius * 0.8;
        const start = unnamed(destination(origin, motion.heading + offset * 2.2, motion.radius * 0.22));
        const end = unnamed(destination(origin, motion.heading + offset, reach));
        legs.push({ from: start, to: end, delay: i * 0.1, bare: offset !== 0 });
      });
      return legs;
    }
    default:
      return [];
  }
}

export function motionSpanDeg(origin: MapPlace, motion: EventMotion): number {
  if (motion.kind === "spread" || motion.kind === "sweep") return motion.radius;
  if (motion.kind === "encircle") return motion.radius * 1.6;
  if (motion.kind === "impact") return 4;
  let span = 0;
  for (const leg of motionLegs(origin, motion)) {
    span = Math.max(span, separationDeg(origin, leg.from), separationDeg(origin, leg.to));
  }
  return span;
}

/** Camera distance that keeps the motion on screen. 1.6 matches a city-level view. */
export function motionCameraAltitude(span: number): number {
  if (span >= 45) return 2.8;
  if (span >= 20) return 2.3;
  if (span >= 12) return 1.95;
  return 1.6;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

function compass(heading: number): string {
  return COMPASS[Math.round((((heading % 360) + 360) % 360) / 45) % 8];
}

export function motionLabel(motion: EventMotion): string {
  switch (motion.kind) {
    case "spread":
      return motion.actor === "disease" || motion.actor === "news" ? "Spread" : "Front";
    case "impact":
      return "Battle";
    case "flow":
      if (motion.actor === "people") return "Exodus";
      if (motion.actor === "aid") return "Relief";
      return "Advance";
    case "path":
      return motion.actor === "ships" ? "Voyage" : "Campaign";
    case "converge":
      return "Arrival";
    case "radiate":
      return "Breakout";
    case "exchange":
      return "Exchange";
    case "encircle":
      return "Siege";
    case "launch":
      return motion.actor === "aircraft" ? "Airlift" : "Launch";
    case "sweep":
      return "Sweep";
  }
}

export function motionCaption(motion: EventMotion): string {
  switch (motion.kind) {
    case "spread":
      return motion.actor === "disease" ? "Spreading outward" : "Front expanding";
    case "impact":
      return "Battle";
    case "flow":
      return `${motion.from.name} → ${motion.to.name}`;
    case "path":
      return motion.points.map((place) => place.name).join(" → ");
    case "converge":
      return `Arriving from ${motion.from.map((place) => place.name).join(", ")}`;
    case "radiate":
      return `Reaching ${motion.to.map((place) => place.name).join(", ")}`;
    case "exchange":
      return `Back and forth with ${motion.with.name}`;
    case "encircle":
      return "Surrounded on all sides";
    case "launch":
      return `Launched toward ${motion.to.name}`;
    case "sweep":
      return `Sweeping ${compass(motion.heading)}`;
  }
}

/** globe.gl ring colors fade as the ring expands. */
export function fadeColor(hex: string): (t: number) => string {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(n)) return (t: number) => `rgba(56,189,248,${(1 - t).toFixed(3)})`;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (t: number) => `rgba(${r},${g},${b},${(1 - t).toFixed(3)})`;
}
