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
  /** Optional panel rendered to the right of the notebook stage (e.g. assistant). */
  asideRight?: ReactNode;
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
  asideRight,
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
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
      data-authenticated={capabilities?.auth.canUseAuthenticatedIdentity}
      data-access-level={capabilities?.access.level}
      data-access-source={capabilities?.access.source}
      data-can-edit={capabilities?.canEditCells}
      data-can-edit-structure={capabilities?.canEditStructure}
      data-can-execute={capabilities?.canExecute}
      data-can-share={capabilities?.canManageSharing}
      data-can-write-runtime-state={capabilities?.runtime.canWriteRuntimeState}
      data-runtime-connected={capabilities?.runtime.connected}
      data-slot="notebook-document-shell"
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
      <div className="flex min-h-0 flex-1 overflow-hidden" data-slot="notebook-document-body">
        {rail}
        <section
          className={cn("flex min-w-0 flex-1 flex-col", stageClassName)}
          aria-label={stageLabel}
          data-slot="notebook-document-stage"
        >
          {children}
        </section>
        {asideRight}
      </div>
    </Root>
  );
}
