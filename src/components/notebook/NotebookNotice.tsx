import { X } from "lucide-react";
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
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-3 border-b px-3 py-2 text-xs",
        toneClassName[tone],
        className,
      )}
      data-slot="notebook-notice"
      data-tone={tone}
      data-testid={dataTestId}
    >
      {icon ? (
        <span
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center",
            iconClassName[tone],
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      <div className={cn("min-w-0 flex-1 space-y-1", contentClassName)}>
        {title || children ? (
          <div className="min-w-0">
            {title ? <span className="font-medium">{title}</span> : null}
            {title && children ? <span> </span> : null}
            {children}
          </div>
        ) : null}
        {details ? <div className="min-w-0">{details}</div> : null}
      </div>
      {actions || onDismiss ? (
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className={cn(
                "rounded p-0.5 transition-colors hover:bg-current/10",
                iconClassName[tone],
              )}
              aria-label={dismissLabel}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ) : null}
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
        "inline-flex h-6 items-center gap-1 rounded px-2 text-xs font-medium transition-colors hover:bg-current/10",
        className,
      )}
      data-testid={dataTestId}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}
