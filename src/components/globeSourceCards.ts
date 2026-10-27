import type { StoryEvent } from "@/lib/types";
import {
  CATEGORY_COLORS,
  LEAN_COLORS,
  LEAN_LABELS,
  factualScore,
  formatDate,
} from "@/lib/ui";

export interface SourceCardsAnchor {
  lat: number;
  lng: number;
  event: StoryEvent;
}

const TILTS = [-1.5, 1, -0.5, 1.5, -1];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Builds the stack of source cards the globe pins under the focused event.
 * Plain DOM (not React) because the globe positions these elements itself;
 * all text goes through textContent since sources may be AI-generated.
 */
export function buildSourceCards(event: StoryEvent): HTMLElement {
  const anchor = el("div", "map-cards-anchor");
  const stack = el("div", "map-cards");
  anchor.appendChild(stack);

  const header = el(
    "div",
    "map-cards-header",
    `${event.sources.length} source${event.sources.length === 1 ? "" : "s"}`
  );
  header.style.setProperty("--cat", CATEGORY_COLORS[event.category]);
  stack.appendChild(header);

  event.sources.forEach((source, i) => {
    const card = el("a", "map-card");
    card.href = source.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.title = source.bias.note ?? source.title;
    card.style.setProperty("--lean", LEAN_COLORS[source.bias.politicalLean]);
    card.style.setProperty("--tilt", `${TILTS[i % TILTS.length]}deg`);
    card.style.animationDelay = `${120 + i * 90}ms`;
    // Keep drags on a card from spinning the globe underneath it.
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const top = el("div", "map-card-top");
    top.appendChild(el("span", "map-card-publisher", source.publisher));
    top.appendChild(
      el("span", "map-card-lean", LEAN_LABELS[source.bias.politicalLean])
    );
    card.appendChild(top);

    card.appendChild(el("div", "map-card-title", source.title));

    const meta = el("div", "map-card-meta");
    const facts = el("span", "map-card-facts");
    const score = factualScore(source.bias.factualRating);
    for (let b = 0; b < 5; b++) {
      facts.appendChild(el("i", b < score ? "on" : ""));
    }
    meta.appendChild(facts);
    meta.appendChild(el("span", "", formatDate(source.publishedAt)));
    card.appendChild(meta);

    stack.appendChild(card);
  });

  return anchor;
}
