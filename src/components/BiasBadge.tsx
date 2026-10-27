import type { BiasClassification } from "@/lib/types";
import {
  factualLabel,
  factualScore,
  LEAN_COLORS,
  LEAN_LABELS,
} from "@/lib/ui";

/**
 * Renders a source's bias profile: political lean chip + factual-rating
 * bars (5-segment meter, MBFC style). The point is to let the reader
 * weigh the source, not to editorialize about it.
 */
export default function BiasBadge({ bias }: { bias: BiasClassification }) {
  const leanColor = LEAN_COLORS[bias.politicalLean] ?? "#a855f7";
  const score = factualScore(bias.factualRating);

  return (
    <div className="flex flex-wrap items-center gap-2" title={bias.note ?? ""}>
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{
          color: leanColor,
          backgroundColor: `${leanColor}1f`,
          border: `1px solid ${leanColor}55`,
        }}
      >
        {LEAN_LABELS[bias.politicalLean]}
      </span>

      <span className="inline-flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-slate-400">
          Facts
        </span>
        <span className="flex gap-0.5" title={factualLabel(bias.factualRating)}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="h-2.5 w-1 rounded-[1px]"
              style={{
                backgroundColor:
                  i < score ? "#34d399" : "rgba(148,163,184,0.25)",
              }}
            />
          ))}
        </span>
      </span>

      {bias.note && (
        <span className="text-[10px] italic text-slate-500">{bias.note}</span>
      )}
    </div>
  );
}
