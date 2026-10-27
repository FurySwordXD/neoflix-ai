import { SYMBOLS, type MapSymbol } from "@/lib/mapSymbols";

/** Flat white glyph used on counters, the timeline, and the legend. */
export default function MapSymbolIcon({
  symbol,
  size = 14,
}: {
  symbol: MapSymbol;
  size?: number;
}) {
  if (symbol === "atom") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
        <circle cx="12" cy="12" r="1.7" fill="currentColor" />
        <ellipse cx="12" cy="12" rx="8" ry="3.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <ellipse
          cx="12"
          cy="12"
          rx="8"
          ry="3.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          transform="rotate(60 12 12)"
        />
        <ellipse
          cx="12"
          cy="12"
          rx="8"
          ry="3.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          transform="rotate(-60 12 12)"
        />
      </svg>
    );
  }

  const art = SYMBOLS[symbol];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {art.fill?.map((d) => (
        <path key={d} d={d} fill="currentColor" />
      ))}
      {art.evenodd?.map((d) => (
        <path key={d} d={d} fill="currentColor" fillRule="evenodd" />
      ))}
      {art.stroke?.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
