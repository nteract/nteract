import { useMemo } from "react";
import type { WorkstationAttachmentState } from "runtimed";
import {
  type NotebookInteractionMode,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import { projectCloudNotebookEditAccess } from "./edit-access";
import type { ViewerStatus } from "./notice-types";
import { cloudNotebookShellCapabilities } from "./shell-capabilities";

interface UseCloudShellCapabilitiesInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  connectionActorLabel: string | null;
  connectionPeerId: string | null;
  connectionError: string | null;
  status: ViewerStatus;
  selectedMode: NotebookInteractionMode;
  hasAppSession: boolean;
  codeCellCount: number;
  runtimePeerAvailable: boolean;
  runtimePeerCount: number;
  workstationAttachment: WorkstationAttachmentState | null;
  hostCapabilities: CloudViewerConfig["hostCapabilities"];
}

export interface CloudShellCapabilities {
  shellCapabilities: NotebookShellCapabilities;
  canAcceptCellMutations: boolean;
  editAccessPending: boolean;
}

/**
 * The cloud host adapter. It translates live hosted-room facts - OIDC auth,
 * room access scope, connection and runtime-peer presence, and the workstation
 * attachment snapshot - into the host-neutral `NotebookShellCapabilities` the
 * shared notebook shell consumes. `NotebookViewer` renders
 * `NotebookDocumentShell` / `NotebookDocumentToolbar` / `NotebookDocumentRail`
 * from this output; the room and daemon authorities still enforce the write
 * path. Desktop and Elements build the same capability object from their own
 * adapters, so this is the cloud-specific edge of a shared contract.
 */
export function useCloudShellCapabilities({
  authState,
  connectionScope,
  connectionActorLabel,
  connectionPeerId,
  connectionError,
  status,
  selectedMode,
  hasAppSession,
  codeCellCount,
  runtimePeerAvailable,
  runtimePeerCount,
  workstationAttachment,
  hostCapabilities,
}: UseCloudShellCapabilitiesInput): CloudShellCapabilities {
  const canAcceptCellMutations =
    Boolean(connectionPeerId) &&
    !connectionError &&
    (status.kind === "ready" || status.kind === "empty");
  const editAccessRequestPending = !connectionError && status.kind === "loading";
  const roomEditAccess = useMemo(
    () =>
      projectCloudNotebookEditAccess({
        authState,
        connectionScope,
        selectedMode,
        canAcceptCellMutations,
        editAccessRequestPending,
      }),
    [authState, canAcceptCellMutations, connectionScope, editAccessRequestPending, selectedMode],
  );
  const editAccessPending = roomEditAccess.editAccessPending;
  const shellCapabilities = useMemo(
    () =>
      cloudNotebookShellCapabilities({
        authState,
        connectionScope,
        connectionActorLabel,
        hasAppSession,
        hasCodeCells: codeCellCount > 0,
        selectedMode,
        canAcceptCellMutations,
        editAccessRequestPending,
        runtimeAvailable: runtimePeerAvailable,
        runtimePeerCount,
        workstationAttachment,
        hostCapabilities,
      }),
    [
      authState,
      hasAppSession,
      canAcceptCellMutations,
      codeCellCount,
      hostCapabilities,
      connectionActorLabel,
      connectionScope,
      editAccessRequestPending,
      runtimePeerCount,
      runtimePeerAvailable,
      selectedMode,
      workstationAttachment,
    ],
  );
  return { shellCapabilities, canAcceptCellMutations, editAccessPending };
}
