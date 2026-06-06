import type { ReactNode } from "react";
import type { NotebookShellCapabilities } from "./capabilities";
import { NotebookCommandToolbar, type NotebookCommandToolbarProps } from "./NotebookCommandToolbar";
import { NotebookDocumentHeader, type NotebookDocumentHeaderProps } from "./NotebookDocumentHeader";
import { NotebookToolbarFrame } from "./NotebookToolbarFrame";

type NotebookDocumentHeaderSlots = Omit<NotebookDocumentHeaderProps, "capabilities" | "className">;

export interface NotebookDocumentToolbarProps extends NotebookDocumentHeaderSlots {
  capabilities: NotebookShellCapabilities;
  frameClassName?: string;
  headerClassName?: string;
  commandToolbar?: Omit<NotebookCommandToolbarProps, "capabilities"> | null;
  reserveCommandToolbar?: boolean;
  notices?: ReactNode;
}

export function shouldShowNotebookDocumentCommandToolbar(
  capabilities: Pick<
    NotebookShellCapabilities,
    "canEditStructure" | "canExecute" | "canManagePackages"
  >,
  { reserve = false }: { reserve?: boolean } = {},
): boolean {
  return (
    reserve ||
    capabilities.canEditStructure ||
    capabilities.canExecute ||
    capabilities.canManagePackages
  );
}

export function NotebookDocumentToolbar({
  capabilities,
  frameClassName,
  headerClassName,
  commandToolbar,
  reserveCommandToolbar = false,
  notices,
  presence,
  utilityControls,
  runtimeControls,
  codeControls,
  sharingControls,
  editControls,
  authControls,
  identityControls,
}: NotebookDocumentToolbarProps) {
  const showCommandToolbar =
    Boolean(commandToolbar) &&
    shouldShowNotebookDocumentCommandToolbar(capabilities, { reserve: reserveCommandToolbar });

  return (
    <NotebookToolbarFrame className={frameClassName} notices={notices}>
      <NotebookDocumentHeader
        capabilities={capabilities}
        className={headerClassName}
        presence={presence}
        utilityControls={utilityControls}
        runtimeControls={runtimeControls}
        codeControls={codeControls}
        sharingControls={sharingControls}
        editControls={editControls}
        authControls={authControls}
        identityControls={identityControls}
      />
      {showCommandToolbar ? (
        <NotebookCommandToolbar capabilities={capabilities} {...commandToolbar} />
      ) : null}
    </NotebookToolbarFrame>
  );
}
