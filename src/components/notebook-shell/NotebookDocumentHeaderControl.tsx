import type { ButtonHTMLAttributes, DetailsHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NotebookDocumentHeaderControlTone = "default" | "positive" | "attention" | "danger";

export interface NotebookDocumentHeaderButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  tone?: NotebookDocumentHeaderControlTone;
  active?: boolean;
}

export function NotebookDocumentHeaderButton({
  icon,
  tone = "default",
  active = false,
  children,
  className,
  ...props
}: NotebookDocumentHeaderButtonProps) {
  return (
    <button
      type="button"
      data-active={active ? "true" : "false"}
      data-tone={tone}
      className={cn(notebookDocumentHeaderControlClassName({ tone, active }), className)}
      {...props}
    >
      {icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export interface NotebookDocumentHeaderMenuProps extends Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  "children"
> {
  trigger: ReactNode;
  triggerTitle?: string;
  triggerClassName?: string;
  triggerProps?: HTMLAttributes<HTMLElement>;
  panelClassName?: string;
  children: ReactNode;
}

export function NotebookDocumentHeaderMenu({
  trigger,
  triggerTitle,
  triggerClassName,
  triggerProps,
  panelClassName,
  children,
  className,
  ...props
}: NotebookDocumentHeaderMenuProps) {
  return (
    <details className={cn("relative", className)} {...props}>
      <summary
        {...triggerProps}
        title={triggerProps?.title ?? triggerTitle}
        className={cn(notebookDocumentHeaderControlClassName(), triggerClassName)}
      >
        {trigger}
      </summary>
      <div
        className={cn(
          "absolute right-0 top-[calc(100%+0.5rem)] z-30 grid max-h-[min(42rem,calc(100vh-5rem))] w-[min(20rem,calc(100vw-1.5rem))] gap-3 overflow-auto rounded-md border bg-background p-3 text-foreground shadow-xl",
          panelClassName,
        )}
        data-slot="notebook-document-header-menu-panel"
      >
        {children}
      </div>
    </details>
  );
}

export function notebookDocumentHeaderControlClassName({
  tone = "default",
  active = false,
}: {
  tone?: NotebookDocumentHeaderControlTone;
  active?: boolean;
} = {}) {
  return cn(
    "pointer-events-auto inline-flex h-8 max-w-[min(12rem,38vw)] min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground shadow-sm backdrop-blur transition-colors",
    "bg-background/90 hover:bg-muted hover:text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2",
    "[&_svg]:size-4 [&_svg]:shrink-0 [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap [&_span]:text-[0.8125rem] [&_span]:leading-none",
    active && "border-ring text-foreground",
    tone === "positive" && "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
    tone === "attention" && "border-ring/50 text-foreground",
    tone === "danger" && "border-destructive/50 text-destructive",
    "disabled:cursor-progress disabled:opacity-70",
  );
}
