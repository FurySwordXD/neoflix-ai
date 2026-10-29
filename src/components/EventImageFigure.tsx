"use client";

import { useState } from "react";
import type { EventImage } from "@/lib/types";

interface EventImageFigureProps {
  image: EventImage;
  /** Taller presentation for the detail panel; tighter for the timeline. */
  size?: "thumb" | "full";
}

/**
 * A single story photograph. The URLs come from live web research, so a dead
 * link must never leave a hole in the layout: on error the figure removes
 * itself. `referrerPolicy="no-referrer"` keeps hot-linked news photos loading
 * from the outlets that block cross-origin referrers.
 */
export default function EventImageFigure({ image, size = "full" }: EventImageFigureProps) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;

  const frame =
    size === "thumb"
      ? "h-24 w-full"
      : "aspect-[16/10] w-full";

  const figure = (
    <figure className={`glass-well group relative overflow-hidden rounded-xl ${frame}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url}
        alt={image.caption ?? "Story photograph"}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
      />
      {image.caption && (
        <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/95 via-slate-950/70 to-transparent px-2.5 pb-2 pt-6 text-[11px] leading-snug text-slate-200">
          {image.caption}
        </figcaption>
      )}
    </figure>
  );

  // Thumbnails sit inside the timeline's event button, so they stay inert:
  // an <a> inside a <button> is invalid and would fight the row's click.
  if (size === "thumb" || !image.sourceUrl) return figure;

  return (
    <a
      href={image.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
      title="Open the article this photograph ran in"
    >
      {figure}
    </a>
  );
}
