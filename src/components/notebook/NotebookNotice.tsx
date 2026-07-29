import { AlertTriangle, Bug, CheckCircle2, ChevronRight, Info, XCircle, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NotebookNoticeTone = "info" | "warning" | "error" | "success" | "debug";

export interface NotebookNoticeProps {
  tone?: NotebookNoticeTone;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
  contentClassName?: string;
  "data-testid"?: string;
}

export interface NotebookNoticeStackProps {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

const toneClassName: Record<NotebookNoticeTone, string> = {
  info: "border-sky-500/25 bg-sky-500/10 text-sky-950 dark:text-sky-100",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100",
  error: "border-red-500/30 bg-red-500/10 text-red-950 dark:text-red-100",
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
  debug: "border-violet-500/25 bg-violet-500/10 text-violet-950 dark:text-violet-100",
};

const iconClassName: Record<NotebookNoticeTone, string> = {
  info: "text-sky-600 dark:text-sky-300",
  warning: "text-amber-600 dark:text-amber-300",
  error: "text-red-600 dark:text-red-300",
  success: "text-emerald-600 dark:text-emerald-300",
  debug: "text-violet-600 dark:text-violet-300",
};

/**
 * Per-tone default icon so shape — not just color — distinguishes severity
 * (accessible for color-blind users and quicker to scan). A caller can still
 * pass a more specific `icon` (e.g. CloudOff for reconnecting); when it does
 * not, the tone picks the icon. Pass `icon={null}` to opt out entirely.
 *
 * Components, not elements: module-scope JSX would evaluate at import time,
 * before consumers that install React globally (the node:test suites) run.
 */
const toneDefaultIcon: Record<NotebookNoticeTone, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  success: CheckCircle2,
  debug: Bug,
};

export function NotebookNoticeStack({
  children,
  className,
  "data-testid": dataTestId,
}: NotebookNoticeStackProps) {
  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      data-slot="notebook-notice-stack"
      data-testid={dataTestId}
    >
      {children}
    </div>
  );
}

export function NotebookNotice({
  tone = "info",
  icon,
  title,
  children,
  details,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  contentClassName,
  "data-testid": dataTestId,
}: NotebookNoticeProps) {
  // `undefined` means "no explicit icon" → fall back to the tone default so
  // shape signals severity. `null` is an explicit opt-out and renders nothing.
  const ToneIcon = toneDefaultIcon[tone];
  const resolvedIcon = icon === undefined ? <ToneIcon className="size-4" /> : icon;
  return (
    <div
      className={cn(
        // Column layout: the header row (icon + text + actions + dismiss) sits
        // on top, and `details` drops to its own full-width row below it — so a
        // traceback/code block spans the whole notice instead of a sliver
        // indented beside the icon.
        "flex min-w-0 flex-col border-b px-3 py-2",
        toneClassName[tone],
        className,
      )}
      data-slot="notebook-notice"
      data-tone={tone}
      data-testid={dataTestId}
    >
      {/* Header row. `min-h-9` keeps a bare one-line bar a stable height whether
          or not it has an action button, but is dropped when a detail row
          follows: the slack would otherwise land as dead space between the
          title and the disclosure. items-start pins the icon/actions/dismiss to
          the top when the body wraps to multiple lines. `@container` scopes the
          header query below to this notice's own width, so narrow notices wrap
          their actions regardless of viewport. */}
      <div
        className={cn("@container flex min-w-0 items-start gap-3", details ? undefined : "min-h-9")}
      >
        {resolvedIcon ? (
          <span
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center",
              iconClassName[tone],
            )}
            aria-hidden="true"
          >
            {resolvedIcon}
          </span>
        ) : null}
        <div className={cn("min-w-0 flex-1", contentClassName)}>
          {/* Message text and (optional) actions. On a wide notice the actions
              pin to the right of the text (`@xs:` row); on a narrow notice they
              wrap onto their own line below the text (default column) so they
              never squeeze the message. */}
          {title || children || actions ? (
            <div className="flex flex-col gap-1.5 @xs:flex-row @xs:items-start @xs:justify-between @xs:gap-3">
              {title || children ? (
                // Title on its own line, larger; body smaller beneath it.
                <div className="min-w-0 space-y-0.5 @xs:flex-1">
                  {title ? <div className="text-sm font-semibold leading-snug">{title}</div> : null}
                  {children ? (
                    <div className="text-xs leading-snug text-current/80">{children}</div>
                  ) : null}
                </div>
              ) : null}
              {actions ? (
                <div className="flex shrink-0 flex-wrap items-center gap-1">{actions}</div>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* Dismiss stays pinned to the top-right of the header row (which is
            `items-start`), so it never moves when actions wrap below the text
            on a narrow notice. */}
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "-mr-0.5 mt-0.5 shrink-0 rounded p-0.5 transition-colors hover:bg-current/10",
              iconClassName[tone],
            )}
            aria-label={dismissLabel}
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {/* Full-width detail row: spans the whole notice (not indented beside the
          icon, not sharing the flex row with the icon/dismiss) so code blocks
          and tracebacks read edge-to-edge. */}
      {details ? <div className="mt-1 min-w-0">{details}</div> : null}
    </div>
  );
}

export interface NotebookNoticeActionProps {
  children: ReactNode;
  onClick?: () => void;
  icon?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function NotebookNoticeAction({
  children,
  onClick,
  icon,
  className,
  "data-testid": dataTestId,
}: NotebookNoticeActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Reads as a real button: a borderless chip with a fill drawn from the
        // tone's currentColor, not a bare text link. h-6 + whitespace-nowrap
        // keep it from growing the notice row or wrapping.
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-current/10 px-2 text-xs font-medium transition-colors hover:bg-current/20",
        className,
      )}
      data-testid={dataTestId}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export interface NotebookNoticeDetailsProps {
  /** Raw error text / traceback. Rendered monospace, preserving newlines. */
  children: string;
  /** Summary label shown on the collapsed row. */
  label?: string;
  className?: string;
  "data-testid"?: string;
}

/**
 * Collapsible, full-width detail block for tracebacks and raw error strings.
 *
 * Collapsed by default (a `<details>`/`<summary>` disclosure) so a wall of
 * stderr never dominates the notice — the user opens it on demand. When open,
 * the block spans the notice edge-to-edge and wraps long lines, so a traceback
 * is readable in full without horizontal scrolling.
 *
 * Pass this as the `details` slot of a `NotebookNotice`, which drops it onto
 * its own full-width row below the header.
 */
export function NotebookNoticeDetails({
  children,
  label = "Show details",
  className,
  "data-testid": dataTestId,
}: NotebookNoticeDetailsProps) {
  return (
    <details className={cn("group/details min-w-0", className)} data-testid={dataTestId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-current/80 transition-colors hover:text-current [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open/details:rotate-90" />
        {label}
      </summary>
      <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-current/5 px-2 py-1.5 font-mono text-[11px] leading-snug">
        {children}
      </pre>
    </details>
  );
}
