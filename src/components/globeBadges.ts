import type { StoryEvent } from "@/lib/types";
import { CATEGORY_COLORS } from "@/lib/ui";
import { SYMBOLS, symbolFor, type MapSymbol } from "@/lib/mapSymbols";

function svgNode(symbol: MapSymbol): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (symbol === "atom") {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "1.7");
    dot.setAttribute("fill", "currentColor");
    svg.appendChild(dot);
    for (const rot of ["", "rotate(60 12 12)", "rotate(-60 12 12)"]) {
      const orbit = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      orbit.setAttribute("cx", "12");
      orbit.setAttribute("cy", "12");
      orbit.setAttribute("rx", "8");
      orbit.setAttribute("ry", "3.1");
      orbit.setAttribute("fill", "none");
      orbit.setAttribute("stroke", "currentColor");
      orbit.setAttribute("stroke-width", "1.6");
      if (rot) orbit.setAttribute("transform", rot);
      svg.appendChild(orbit);
    }
    return svg;
  }
  const art = SYMBOLS[symbol];
  for (const d of art.fill ?? []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
  }
  for (const d of art.evenodd ?? []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
  }
  for (const d of art.stroke ?? []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
  }
  return svg;
}

/** Unit counter pinned to an event. The globe positions the anchor; the glyph scales inside it. */
export function buildBadge(
  event: StoryEvent,
  selected: boolean,
  dim: boolean,
  onSelect: () => void
): HTMLElement {
  const anchor = document.createElement("div");
  anchor.className = "map-badge-anchor";
  const button = document.createElement("button");
  button.type = "button";
  const symbol = symbolFor(event.category, event.motion);
  const classes = ["map-badge"];
  if (selected) classes.push("is-selected");
  if (dim) classes.push("is-dim");
  if (symbol === "swords") classes.push("is-battle");
  button.className = classes.join(" ");
  button.style.color = "#f8fafc";
  button.style.borderColor = CATEGORY_COLORS[event.category];
  button.title = event.title;
  button.appendChild(svgNode(symbol));
  button.addEventListener("click", (click) => {
    click.stopPropagation();
    onSelect();
  });
  anchor.appendChild(button);
  return anchor;
}
