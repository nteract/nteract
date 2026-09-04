import { useState, type ElementType, type ReactNode } from "react";
import { RailPanelSlotProvider } from "@/components/rail";
import { cn } from "@/lib/utils";
import type { NotebookShellCapabilities } from "./capabilities";

export interface NotebookDocumentShellProps {
  /**
   * Use `main` for hosted/document routes and `div` when an app-level main
   * landmark already exists.
   */
  rootElement?: "div" | "main";
  rail?: ReactNode;
  railPanelPlacement?: "rail" | "stage";
  toolbar?: ReactNode;
  /**
   * `stage-content` keeps notebook-local controls attached to the notebook
   * column when a stage-hosted rail panel opens.
   */
  toolbarPlacement?: "shell" | "stage" | "stage-content";
  stageToolbar?: ReactNode;
  stageToolbarPlacement?: "stage" | "stage-content";
  notices?: ReactNode;
  noticesPlacement?: "shell" | "stage";
  children: ReactNode;
  capabilities?: NotebookShellCapabilities;
  className?: string;
  stageClassName?: string;
  /** Applied to the notebook content column beside a stage-hosted rail panel. */
  stageContentClassName?: string;
  toolbarClassName?: string;
  toolbarLabel?: string;
  noticesClassName?: string;
  stageLabel?: string;
}

export function NotebookDocumentShell({
  rootElement = "div",
  rail,
  railPanelPlacement = "rail",
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
  stageContentClassName,
  toolbarClassName,
  toolbarLabel,
  noticesClassName,
  stageLabel = "Notebook",
}: NotebookDocumentShellProps) {
  const Root = rootElement as ElementType;
  // Callback-ref state lets the provider publish the host after it commits.
  // Until that rerender, Rail's no-host fallback keeps an expanded panel inline
  // instead of dropping it during portal setup.
  const [railPanelSlotNode, setRailPanelSlotNode] = useState<HTMLDivElement | null>(null);
  const hostsRailPanelInStage = railPanelPlacement === "stage";
  const toolbarInStageContent = toolbarPlacement === "stage-content";
  const stageToolbarInStageContent =
    Boolean(stageToolbar) && stageToolbarPlacement === "stage-content";
  const hasStageContentToolbar = toolbarInStageContent || stageToolbarInStageContent;
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

  const shell = (
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
      <div className="flex min-h-0 flex-1 overflow-hidden" data-slot="notebook-document-body">
        {rail}
        <section
          className={cn("flex min-w-0 flex-1 flex-col", stageClassName)}
          aria-label={stageLabel}
          data-slot="notebook-document-stage"
        >
          {toolbarPlacement === "stage" || (!hostsRailPanelInStage && toolbarInStageContent)
            ? toolbarSlot
            : null}
          {noticesPlacement === "stage" ? noticesSlot : null}
          {stageToolbar &&
          (stageToolbarPlacement === "stage" ||
            (!hostsRailPanelInStage && stageToolbarInStageContent)) ? (
            <div data-slot="notebook-document-stage-toolbar">{stageToolbar}</div>
          ) : null}
          {hostsRailPanelInStage ? (
            <div
              className={cn(
                "grid min-h-0 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] overflow-hidden",
                hasStageContentToolbar
                  ? "grid-rows-[auto_minmax(0,1fr)]"
                  : "grid-rows-[minmax(0,1fr)]",
              )}
              data-slot="notebook-document-stage-body"
            >
              {hasStageContentToolbar ? (
                <div
                  className="col-start-2 row-start-1 min-w-0"
                  data-slot="notebook-document-stage-content-toolbar"
                >
                  {toolbarInStageContent ? toolbarSlot : null}
                  {stageToolbarInStageContent ? (
                    <div data-slot="notebook-document-stage-toolbar">{stageToolbar}</div>
                  ) : null}
                </div>
              ) : null}
              <div
                ref={setRailPanelSlotNode}
                className="col-start-1 row-start-1 row-end-[-1] flex min-h-0 shrink-0"
                data-slot="notebook-document-rail-panel-host"
              />
              <div
                className={cn(
                  "col-start-2 flex min-h-0 min-w-0 flex-1 flex-col",
                  hasStageContentToolbar ? "row-start-2" : "row-start-1",
                  stageContentClassName,
                )}
                data-slot="notebook-document-stage-content"
              >
                {children}
              </div>
            </div>
          ) : (
            children
          )}
        </section>
      </div>
    </Root>
  );

  return hostsRailPanelInStage ? (
    <RailPanelSlotProvider node={railPanelSlotNode}>{shell}</RailPanelSlotProvider>
  ) : (
    shell
  );
}
