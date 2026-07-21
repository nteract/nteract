import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Severity language for full-stage gate states, aligned with the cloud viewer
 * unhappy-state family: kernel-starting blue for calm sign-in prompts, executing
 * amber for access attention, muted neutral for missing/not-found. Severity
 * changes the icon badge tone, not the whole surface.
 */
export type NotebookAccessGateTone = "neutral" | "info" | "attention";

const gateBadgeToneClassName: Record<NotebookAccessGateTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
  attention: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
};

export interface NotebookAccessGateProps {
  /** Quiet icon rendered inside the badge; sized by the badge, not the caller. */
  icon?: ReactNode;
  tone?: NotebookAccessGateTone;
  /** Short label without a trailing period, per the unhappy-state family. */
  title: string;
  /** One sentence of detail. */
  detail?: ReactNode;
  /** Primary call to action — a real button, the only high-emphasis element. */
  primaryAction?: ReactNode;
  /** Optional lower-emphasis link/button below the primary action. */
  secondaryAction?: ReactNode;
  /** Optional quiet footnote (e.g. the signed-in identity). */
  note?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/**
 * Full-stage blocked-room state: centered copy, a quiet icon badge, one
 * sentence of detail, and at most one primary action. Fills the notebook stage
 * so a gated route reads as intentionally gated rather than empty or broken.
 * Shared by the Elements catalog and the cloud viewer so the signed-out,
 * no-access, and not-found paths speak one visual language.
 */
export function NotebookAccessGate({
  icon,
  tone = "neutral",
  title,
  detail,
  primaryAction,
  secondaryAction,
  note,
  className,
  "data-testid": dataTestId,
}: NotebookAccessGateProps) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
      data-slot="notebook-access-gate"
      data-tone={tone}
      data-testid={dataTestId}
    >
      {icon ? (
        <span
          className={cn(
            "grid size-11 place-items-center rounded-xl [&_svg]:size-5",
            gateBadgeToneClassName[tone],
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      <h2 className="mt-4 text-base font-semibold text-foreground">{title}</h2>
      {detail ? (
        <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">{detail}</p>
      ) : null}
      {primaryAction || secondaryAction || note ? (
        <div className="mt-5 flex flex-col items-center gap-2.5">
          {primaryAction}
          {secondaryAction}
          {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
