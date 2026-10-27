import type { EventMotion, MotionActor, StoryEvent } from "./types";

/**
 * Map symbols in the Kings and Generals style: a dark unit counter,
 * a white glyph, and a campaign arrow for anything that moves.
 */
export type MapSymbol =
  | "swords"
  | "virus"
  | "burst"
  | "shield"
  | "banner"
  | "star"
  | "coin"
  | "atom"
  | "advance"
  | "people"
  | "ship"
  | "plane"
  | "cross"
  | "signal"
  | "siege";

interface SymbolArt {
  fill?: string[];
  evenodd?: string[];
  stroke?: string[];
}

function circle(cx: number, cy: number, r: number): string {
  return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
}

export const SYMBOLS: Record<MapSymbol, SymbolArt> = {
  swords: {
    fill: [
      "M17.2 2.6 18.6 4 7.4 21.2 6 19.8Z",
      "M6.8 2.6 5.4 4 16.6 21.2 18 19.8Z",
      "M3.2 14.4 8.4 16.6 7.5 18.2 2.3 16Z",
      "M20.8 14.4 15.6 16.6 16.5 18.2 21.7 16Z",
    ],
  },
  virus: {
    fill: [
      circle(12, 12, 3.3),
      circle(12, 5.2, 1.25),
      circle(12, 18.8, 1.25),
      circle(5.2, 12, 1.25),
      circle(18.8, 12, 1.25),
      circle(7.2, 7.2, 1.15),
      circle(16.8, 7.2, 1.15),
      circle(7.2, 16.8, 1.15),
      circle(16.8, 16.8, 1.15),
    ],
  },
  burst: {
    fill: [
      "M12 1.6 14.1 8.4 21 6.4 16.4 12 21 17.6 14.1 15.6 12 22.4 9.9 15.6 3 17.6 7.6 12 3 6.4 9.9 8.4Z",
    ],
  },
  shield: {
    fill: ["M12 2.6 19.4 6.1V12.4C19.4 16.8 12 21.6 12 21.6S4.6 16.8 4.6 12.4V6.1Z"],
  },
  banner: {
    fill: ["M5 3H7.3V21H5Z", "M7.3 4.4H18.6L16.1 9.1 18.6 13.8H7.3Z"],
  },
  star: {
    fill: ["M12 2.4 14.8 8.7 21.6 9.3 16.5 13.8 18.1 20.4 12 16.9 5.9 20.4 7.5 13.8 2.4 9.3 9.2 8.7Z"],
  },
  coin: {
    evenodd: [
      "M12 3.2a8.8 8.8 0 1 0 .01 0zM12 7.3a4.7 4.7 0 1 1 -.01 0z",
    ],
  },
  atom: {},
  advance: {
    fill: [
      "M3.2 7.1 9.2 12 3.2 16.9 5.2 18.7 13.1 12 5.2 5.3Z",
      "M10.2 7.1 16.2 12 10.2 16.9 12.2 18.7 20.1 12 12.2 5.3Z",
    ],
  },
  people: {
    fill: [
      circle(8.4, 6.6, 2.5),
      circle(15.8, 7.4, 2.1),
      "M3.6 19.6C3.6 14.6 5.6 11 8.4 11S13.2 14.6 13.2 19.6Z",
      "M12.4 19.6C12.6 15.6 14 12.4 15.8 12.4S20.4 15.4 20.4 19.6Z",
    ],
  },
  ship: {
    fill: [
      "M11 3H12.8V12.4H11Z",
      "M12.8 4 18.6 11.4H12.8Z",
      "M2.6 14H21.4L18.4 19.8H5.6Z",
    ],
  },
  plane: {
    fill: [
      "M11 2.2H13V9.4L21.4 14.2V16.4L13 13.6V18.4L15.8 20.4V21.8L12 20.8 8.2 21.8V20.4L11 18.4V13.6L2.6 16.4V14.2L11 9.4Z",
    ],
  },
  cross: {
    fill: ["M9.3 3.2H14.7V9.3H20.8V14.7H14.7V20.8H9.3V14.7H3.2V9.3H9.3Z"],
  },
  signal: {
    fill: [circle(12, 16.4, 2.2)],
    stroke: [
      "M7.4 11.6A6.6 6.6 0 0 1 16.6 11.6",
      "M4.2 8.4A11.2 11.2 0 0 1 19.8 8.4",
    ],
  },
  siege: {
    fill: [
      "M4 9.6H7.2V7H9.6V9.6H14.4V7H16.8V9.6H20V20.6H4Z",
      "M10.2 14.2H13.8V20.6H10.2Z",
    ],
  },
};

const ACTOR_SYMBOLS: Record<MotionActor, MapSymbol> = {
  troops: "advance",
  people: "people",
  ships: "ship",
  aircraft: "plane",
  goods: "coin",
  aid: "cross",
  disease: "virus",
  news: "signal",
};

/** Counter that rides a moving arrow. Troops keep the chevron. */
export function actorSymbol(motion: EventMotion): MapSymbol {
  if (motion.actor) return ACTOR_SYMBOLS[motion.actor];
  if (motion.kind === "launch") return "plane";
  if (motion.kind === "exchange") return "coin";
  return "advance";
}

export function symbolFor(
  category: StoryEvent["category"],
  motion?: EventMotion
): MapSymbol {
  if (motion?.kind === "impact") return "swords";
  if (motion?.kind === "encircle") return "siege";
  if (motion?.kind === "spread" || motion?.kind === "sweep") {
    if (motion.actor === "disease" || category === "outbreak") return "virus";
    return "burst";
  }
  switch (category) {
    case "outbreak":
      return "virus";
    case "response":
      return "shield";
    case "science":
      return "atom";
    case "politics":
      return "banner";
    case "economy":
      return "coin";
    case "milestone":
      return "star";
  }
}

/** Chevron that rides the head of a campaign arrow. */
export const ADVANCE_SYMBOL: MapSymbol = "advance";

function trace(ctx: CanvasRenderingContext2D, symbol: MapSymbol) {
  if (symbol === "atom") {
    ctx.beginPath();
    ctx.arc(12, 12, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.6;
    for (const rot of [0, Math.PI / 3, -Math.PI / 3]) {
      ctx.save();
      ctx.translate(12, 12);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, 8, 3.1, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }
  const art = SYMBOLS[symbol];
  for (const d of art.fill ?? []) ctx.fill(new Path2D(d));
  for (const d of art.evenodd ?? []) {
    const path = new Path2D(d);
    ctx.fill(path, "evenodd");
  }
  if (art.stroke?.length) {
    ctx.lineWidth = 1.7;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const d of art.stroke) ctx.stroke(new Path2D(d));
  }
}

/** Dark rounded counter with a white glyph, for sprites on the globe. */
export function paintCounter(symbol: MapSymbol, color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.beginPath();
  ctx.roundRect(10, 10, 108, 108, 22);
  ctx.fillStyle = "#0c1220";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.save();
  ctx.translate(32, 32);
  ctx.scale(64 / 24, 64 / 24);
  ctx.fillStyle = "#f8fafc";
  ctx.strokeStyle = "#f8fafc";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  trace(ctx, symbol);
  ctx.restore();
  return canvas;
}
