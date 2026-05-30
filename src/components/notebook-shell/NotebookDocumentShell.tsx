import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface NotebookDocumentShellProps {
  /**
   * Use `main` for hosted/document routes and `div` when an app-level main
   * landmark already exists.
   */
  rootElement?: "div" | "main";
  rail?: ReactNode;
  toolbar?: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
  className?: string;
  stageClassName?: string;
  toolbarClassName?: string;
  toolbarLabel?: string;
  noticesClassName?: string;
  stageLabel?: string;
}

export function NotebookDocumentShell({
  rootElement = "div",
  rail,
  toolbar,
  notices,
  children,
  className,
  stageClassName,
  toolbarClassName,
  toolbarLabel,
  noticesClassName,
  stageLabel = "Notebook",
}: NotebookDocumentShellProps) {
  const Root = rootElement as ElementType;

  return (
    <Root
      className={cn("flex min-h-0 flex-1 overflow-hidden", className)}
      data-slot="notebook-document-shell"
    >
      {rail}
      <section
        className={cn("flex min-w-0 flex-1 flex-col", stageClassName)}
        aria-label={stageLabel}
        data-slot="notebook-document-stage"
      >
        {toolbar ? (
          <div
            className={toolbarClassName}
            aria-label={toolbarLabel}
            data-slot="notebook-document-toolbar"
          >
            {toolbar}
          </div>
        ) : null}
        {notices ? (
          <div className={noticesClassName} data-slot="notebook-document-notices">
            {notices}
          </div>
        ) : null}
        {children}
      </section>
    </Root>
  );
}
