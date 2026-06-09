/**
 * CellAnnotationOverlay — renders a sandbox annotation banner for a cell.
 *
 * Placement: above the cell's output region, below the source code editor.
 * Per D-7, annotations are never mixed into cell outputs — this is a
 * separate visual layer adjacent to the cell.
 *
 * The component is pure: it receives the annotation as a prop. The caller
 * (CodeCell) is responsible for looking up the annotation from the runtime
 * state document using the cell's latest execution_id.
 *
 * Unknown `kind` values render with a generic fallback icon — do not crash.
 */

import {
  AlertOctagon,
  ChevronDown,
  ChevronUp,
  KeyRound,
  KeySquare,
  PlugZap,
  ShieldX,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { CellAnnotation } from "runtimed";
import { cn } from "@/lib/utils";

// ── Kind → display metadata ───────────────────────────────────────────────────

interface AnnotationMeta {
  label: string;
  Icon: LucideIcon;
  /** Tailwind colour classes for the banner */
  colorClass: string;
}

const KIND_META: Record<string, AnnotationMeta> = {
  sandbox_domain_blocked: {
    label: "Domain blocked",
    Icon: ShieldX,
    colorClass:
      "bg-red-50 border-red-200 text-red-900 dark:bg-red-950/40 dark:border-red-800 dark:text-red-200",
  },
  sandbox_credential_missing: {
    label: "Credential missing",
    Icon: KeySquare,
    colorClass:
      "bg-orange-50 border-orange-200 text-orange-900 dark:bg-orange-950/40 dark:border-orange-800 dark:text-orange-200",
  },
  sandbox_credential_rejected: {
    label: "Credential rejected by upstream",
    Icon: KeyRound,
    colorClass:
      "bg-orange-50 border-orange-200 text-orange-900 dark:bg-orange-950/40 dark:border-orange-800 dark:text-orange-200",
  },
  sandbox_proxy_degraded: {
    label: "Sandbox proxy stopped",
    Icon: PlugZap,
    colorClass:
      "bg-yellow-50 border-yellow-200 text-yellow-900 dark:bg-yellow-950/40 dark:border-yellow-800 dark:text-yellow-200",
  },
  sandbox_startup_failed: {
    label: "Sandbox failed to start",
    Icon: AlertOctagon,
    colorClass:
      "bg-red-50 border-red-200 text-red-900 dark:bg-red-950/40 dark:border-red-800 dark:text-red-200",
  },
};

const FALLBACK_META: AnnotationMeta = {
  label: "",       // filled with annotation.kind at render time
  Icon: AlertOctagon,
  colorClass:
    "bg-muted border-border text-muted-foreground",
};

// ── Component ─────────────────────────────────────────────────────────────────

interface CellAnnotationOverlayProps {
  annotation: CellAnnotation;
  className?: string;
}

export function CellAnnotationOverlay({ annotation, className }: CellAnnotationOverlayProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const meta = KIND_META[annotation.kind] ?? { ...FALLBACK_META, label: annotation.kind };
  const { label, Icon, colorClass } = meta;

  const hasDetails = annotation.details !== undefined && annotation.details !== null;

  return (
    <div
      data-testid="cell-annotation-overlay"
      className={cn(
        "mx-4 mb-1 rounded border px-3 py-2 text-sm",
        colorClass,
        className,
      )}
      role="note"
      aria-label={`Sandbox annotation: ${label}`}
    >
      {/* Header row */}
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <span className="font-medium">{label}</span>
          <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{annotation.message}</p>
        </div>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="ml-1 shrink-0 text-xs underline-offset-2 hover:underline flex items-center gap-0.5 opacity-75 hover:opacity-100"
            aria-expanded={detailsOpen}
          >
            {detailsOpen ? (
              <>
                Hide details <ChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                Show details <ChevronDown className="h-3 w-3" />
              </>
            )}
          </button>
        )}
      </div>

      {/* Expandable details */}
      {detailsOpen && hasDetails && (
        <pre className="mt-2 overflow-x-auto rounded bg-black/10 p-2 text-xs dark:bg-white/10">
          {JSON.stringify(annotation.details, null, 2)}
        </pre>
      )}
    </div>
  );
}
