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
  /**
   * `rail` keeps an expanded rail panel inside the rail column, level with the
   * toolbar chrome. `stage` hosts it in the stage instead, so the panel slides
   * out below the utility bar and beside the notebook content while the rail's
   * icon strip stays at the far left of the page content.
   */
  railPanelPlacement?: "rail" | "stage";
  toolbar?: ReactNode;
  toolbarPlacement?: "shell" | "stage";
  stageToolbar?: ReactNode;
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
  // Callback-ref state (not a ref) so the rail re-renders once the host slot
  // node exists and its panel portal can target it on the same commit pass.
  const [railPanelSlotNode, setRailPanelSlotNode] = useState<HTMLDivElement | null>(null);
  const hostsRailPanelInStage = railPanelPlacement === "stage";
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
          {toolbarPlacement === "stage" ? toolbarSlot : null}
          {noticesPlacement === "stage" ? noticesSlot : null}
          {stageToolbar ? (
            <div data-slot="notebook-document-stage-toolbar">{stageToolbar}</div>
          ) : null}
          {hostsRailPanelInStage ? (
            <div
              className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
              data-slot="notebook-document-stage-body"
            >
              {/* Portal target for the expanded rail panel: it slides out here,
                  under the utility bar, while the rail strip stays on the left. */}
              <div
                ref={setRailPanelSlotNode}
                className="flex min-h-0 shrink-0"
                data-slot="notebook-document-rail-panel-host"
              />
              <div
                className={cn("flex min-h-0 min-w-0 flex-1 flex-col", stageContentClassName)}
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
