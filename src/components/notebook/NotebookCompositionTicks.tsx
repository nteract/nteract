import type { CSSProperties } from "react";

export interface NotebookComposition {
  code: number;
  markdown: number;
  raw: number;
}

export interface NotebookCompositionTicksProps {
  composition: NotebookComposition;
  maxTicks?: number;
  className?: string;
}

type NotebookCellType = keyof NotebookComposition;

const CELL_TYPES: NotebookCellType[] = ["code", "markdown", "raw"];
const CELL_LABEL: Record<NotebookCellType, string> = {
  code: "Code",
  markdown: "Markdown",
  raw: "Raw",
};

/**
 * Renders the current notebook cell-type composition as capped visual state,
 * not as an edit-history timeline.
 */
export function NotebookCompositionTicks({
  composition,
  maxTicks = 40,
  className,
}: NotebookCompositionTicksProps) {
  const sequence = notebookCellSequence(composition, maxTicks);
  const runs = notebookCellRuns(sequence);
  // Only present types read out — "0 Raw" is noise for a screen reader.
  const label = CELL_TYPES.filter((type) => (composition[type] || 0) > 0)
    .map((type) => `${composition[type]} ${CELL_LABEL[type]}`)
    .join(", ");

  return (
    <div className={["nb-fp-wrap", className].filter(Boolean).join(" ")}>
      <div className="nb-fp" role="img" aria-label={label}>
        {runs.map((run, index) => (
          <span
            key={`${run.type}-${index}`}
            className="nb-fp-seg"
            data-ct={run.type}
            style={
              {
                flexBasis: 0,
                flexGrow: run.count,
              } satisfies CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}

function notebookCellSequence(
  composition: NotebookComposition,
  maxTicks: number,
): NotebookCellType[] {
  const total = CELL_TYPES.reduce((sum, type) => sum + (composition[type] || 0), 0);
  const cap = Math.max(0, Math.floor(maxTicks));
  if (!total || !cap) {
    return [];
  }

  const scale = total > cap ? cap / total : 1;
  const counts = new Map<NotebookCellType, number>();
  let scaledTotal = 0;
  for (const type of CELL_TYPES) {
    const count = Math.round((composition[type] || 0) * scale);
    if (count > 0) {
      counts.set(type, count);
      scaledTotal += count;
    }
  }

  const assigned = new Map<NotebookCellType, number>();
  for (const type of counts.keys()) {
    assigned.set(type, 0);
  }

  const sequence: NotebookCellType[] = [];
  for (let index = 0; index < scaledTotal; index += 1) {
    let bestType: NotebookCellType | null = null;
    let bestRatio = Infinity;
    for (const [type, count] of counts) {
      const current = assigned.get(type) ?? 0;
      if (current >= count) {
        continue;
      }
      const ratio = current / count;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestType = type;
      }
    }
    if (!bestType) {
      break;
    }
    sequence.push(bestType);
    assigned.set(bestType, (assigned.get(bestType) ?? 0) + 1);
  }
  return sequence;
}

function notebookCellRuns(
  sequence: NotebookCellType[],
): { type: NotebookCellType; count: number }[] {
  const runs: { type: NotebookCellType; count: number }[] = [];
  for (const type of sequence) {
    const last = runs.at(-1);
    if (last?.type === type) {
      last.count += 1;
    } else {
      runs.push({ type, count: 1 });
    }
  }
  return runs;
}
