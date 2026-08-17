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
  toolbarPlacement?: "shell" | "stage";
  stageToolbar?: ReactNode;
  stageToolbarPlacement?: "stage" | "shell";
  notices?: ReactNode;
  noticesPlacement?: "shell" | "stage";
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
  toolbarPlacement = "shell",
  stageToolbar,
  stageToolbarPlacement = "stage",
  notices,
  noticesPlacement = "shell",
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
  const hasShellCommandRow = Boolean(stageToolbar) && stageToolbarPlacement === "shell";
  const toolbarSlot = toolbar ? (
    <div
      className={toolbarClassName}
      aria-label={toolbarLabel}
      data-slot="notebook-document-toolbar"
    >
      {toolbar}
    </div>
  ) : null;
  const noticesSlot = notices ? (
    <div className={noticesClassName} data-slot="notebook-document-notices">
      {notices}
    </div>
  ) : null;

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
      {toolbarPlacement === "shell" ? toolbarSlot : null}
      {noticesPlacement === "shell" ? noticesSlot : null}
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] overflow-hidden",
          hasShellCommandRow ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]",
        )}
        data-slot="notebook-document-body"
      >
        {hasShellCommandRow ? (
          <div
            className="col-span-2 col-start-1 row-start-1 min-w-0 [&_[data-slot=notebook-toolbar-frame]]:border-b-0"
            data-slot="notebook-document-shell-toolbar"
          >
            {stageToolbar}
          </div>
        ) : null}
        {hasShellCommandRow ? (
          <div
            aria-hidden="true"
            className="pointer-events-none z-10 col-start-2 row-start-1 border-b"
            data-slot="notebook-document-shell-toolbar-baseline"
          />
        ) : null}
        <div
          className={cn("col-start-1 min-h-0", hasShellCommandRow ? "row-start-2" : "row-start-1")}
          data-slot="notebook-document-rail-region"
        >
          {rail}
        </div>
        <section
          className={cn(
            "col-start-2 flex min-h-0 min-w-0 flex-col",
            hasShellCommandRow ? "row-start-2" : "row-start-1",
            stageClassName,
          )}
          aria-label={stageLabel}
          data-slot="notebook-document-stage"
        >
          {toolbarPlacement === "stage" ? toolbarSlot : null}
          {noticesPlacement === "stage" ? noticesSlot : null}
          {stageToolbar && stageToolbarPlacement === "stage" ? (
            <div data-slot="notebook-document-stage-toolbar">{stageToolbar}</div>
          ) : null}
          {children}
        </section>
      </div>
    </Root>
  );
}
