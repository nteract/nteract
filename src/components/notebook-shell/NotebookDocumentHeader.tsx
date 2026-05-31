import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NotebookShellCapabilities } from "./capabilities";

export interface NotebookDocumentHeaderProps {
  capabilities: NotebookShellCapabilities;
  presence?: ReactNode;
  utilityControls?: ReactNode;
  codeControls?: ReactNode;
  sharingControls?: ReactNode;
  editControls?: ReactNode;
  authControls?: ReactNode;
  className?: string;
}

export function NotebookDocumentHeader({
  capabilities,
  presence,
  utilityControls,
  codeControls,
  sharingControls,
  editControls,
  authControls,
  className,
}: NotebookDocumentHeaderProps) {
  const showCodeControls = capabilities.canToggleCode && Boolean(codeControls);
  const showSharingControls = capabilities.canManageSharing && Boolean(sharingControls);
  const showEditControls = capabilities.canRequestEdit && Boolean(editControls);
  const showAuthControls =
    Boolean(authControls) &&
    (capabilities.auth.canSignIn ||
      capabilities.auth.canUseAuthenticatedIdentity ||
      capabilities.auth.needsAttention);

  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center justify-between gap-3", className)}
      data-slot="notebook-document-header"
      data-authenticated={capabilities.auth.canUseAuthenticatedIdentity}
      data-access-level={capabilities.access.level}
      data-can-edit={capabilities.canEditCells}
      data-can-request-edit={capabilities.canRequestEdit}
      data-can-share={capabilities.canManageSharing}
    >
      <div className="min-w-0 pointer-events-auto" data-slot="notebook-document-header-presence">
        {presence}
      </div>
      <div
        className="pointer-events-auto flex min-w-0 items-center justify-end gap-2"
        data-slot="notebook-document-header-controls"
      >
        {utilityControls ? (
          <div className="contents" data-slot="notebook-document-header-utility-controls">
            {utilityControls}
          </div>
        ) : null}
        {showCodeControls ? (
          <div className="contents" data-slot="notebook-document-header-code-controls">
            {codeControls}
          </div>
        ) : null}
        {showSharingControls ? (
          <div className="contents" data-slot="notebook-document-header-sharing-controls">
            {sharingControls}
          </div>
        ) : null}
        {showEditControls ? (
          <div className="contents" data-slot="notebook-document-header-edit-controls">
            {editControls}
          </div>
        ) : null}
        {showAuthControls ? (
          <div className="contents" data-slot="notebook-document-header-auth-controls">
            {authControls}
          </div>
        ) : null}
      </div>
    </div>
  );
}
