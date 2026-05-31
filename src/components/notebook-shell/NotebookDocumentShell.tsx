import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NotebookShellCapabilities } from "./capabilities";

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
  capabilities?: NotebookShellCapabilities;
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
  capabilities,
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
      data-authenticated={capabilities?.auth.canUseAuthenticatedIdentity}
      data-access-level={capabilities?.access.level}
      data-access-source={capabilities?.access.source}
      data-can-edit={capabilities?.canEditCells}
      data-can-edit-structure={capabilities?.canEditStructure}
      data-can-execute={capabilities?.canExecute}
      data-can-share={capabilities?.canManageSharing}
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
