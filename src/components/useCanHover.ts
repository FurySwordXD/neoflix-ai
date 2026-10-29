"use client";

import { useEffect, useState } from "react";

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * True only where a real pointer can hover.
 *
 * The chrome autohide during playback is driven by pointer proximity, which a
 * touch screen can never satisfy — so on a phone that behaviour must be turned
 * off entirely rather than leaving the header hidden for the whole story.
 */
export function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(HOVER_QUERY);
    const update = () => setCanHover(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return canHover;
}
