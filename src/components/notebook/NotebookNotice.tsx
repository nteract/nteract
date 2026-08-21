import { AlertTriangle, Bug, CheckCircle2, ChevronRight, Info, XCircle, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AnsiText } from "@/components/outputs/ansi-output";
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

const toneDefaultIcon: Record<NotebookNoticeTone, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  success: CheckCircle2,
  debug: Bug,
};

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
  // undefined → tone default; null → no icon
  const ToneIcon = toneDefaultIcon[tone];
  const resolvedIcon = icon === undefined ? <ToneIcon /> : icon;
  return (
    <div
      className={cn("flex min-w-0 flex-col border-b px-3 py-2", toneClassName[tone], className)}
      data-slot="notebook-notice"
      data-tone={tone}
      data-testid={dataTestId}
    >
      {/* Skip min-h-9 when details follow — otherwise empty gap above the disclosure */}
      <div
        className={cn("@container flex min-w-0 items-start gap-3", details ? undefined : "min-h-9")}
      >
        {resolvedIcon ? (
          <span
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
              iconClassName[tone],
            )}
            aria-hidden="true"
          >
            {resolvedIcon}
          </span>
        ) : null}
        <div className={cn("min-w-0 flex-1", contentClassName)}>
          {title || children || actions ? (
            <div className="flex flex-col gap-1.5 @xs:flex-row @xs:items-start @xs:justify-between @xs:gap-3">
              {title || children ? (
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
      {details ? <div className="mt-1 min-w-0">{details}</div> : null}
    </div>
  );
}

export interface NotebookNoticeStackProps {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function NotebookNoticeStack({
  children,
  className,
  "data-testid": dataTestId,
}: NotebookNoticeStackProps) {
  return (
    <div
      className={cn("flex flex-col gap-0", className)}
      data-slot="notebook-notice-stack"
      data-testid={dataTestId}
    >
      {children}
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
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-current/10 px-2 text-xs font-medium transition-colors hover:bg-current/20 [&_svg]:size-3 [&_svg]:shrink-0",
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

/** Collapsible traceback / raw error for the `details` slot. */
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
        <AnsiText fallback="No further details reported.">{children}</AnsiText>
      </pre>
    </details>
  );
}
