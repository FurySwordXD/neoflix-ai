import { useVideoConfig } from "remotion";

export interface VideoLayout {
  width: number;
  height: number;
  /** Taller than wide (9:16): the mobile layout with a bottom-sheet event panel. */
  portrait: boolean;
  /** 1 at the 1080px base (landscape height / portrait width); scales type for other render sizes. */
  scale: number;
  /** Height of the portrait bottom sheet; 0 in landscape (right-side panel instead). */
  panelHeight: number;
  /**
   * Multiplier on the horizontal slide that clears room for the landscape
   * panel. Portrait's panel is a bottom sheet, so nothing needs the slide:
   * it must be zero or the globe drifts out of the narrow frame.
   */
  slideScale: number;
}

/**
 * The video is authored as two compositions: 1920×1080 (desktop) and
 * 1080×1920 (mobile). Both share the same 1080px base, so typography keeps
 * `scale = 1` in either orientation and only the arrangement flips.
 */
export function useVideoLayout(): VideoLayout {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const scale = Math.min(width, height) / 1080;
  const panelHeight = portrait
    ? Math.round(Math.min(Math.max(height * 0.54, 860 * scale), 1000 * scale))
    : 0;
  return { width, height, portrait, scale, panelHeight, slideScale: portrait ? 0 : 1 };
}
