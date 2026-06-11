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
  connectionPeerLabel: string | null;
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
 * Cloud's host adapter for the shared notebook shell.
 *
 * This translates hosted-room facts into host-neutral capabilities. The room
 * and daemon authorities still enforce write/execute paths; this hook only
 * derives stable UI capabilities for the shared shell, toolbar, and rail.
 */
export function useCloudShellCapabilities({
  authState,
  connectionScope,
  connectionActorLabel,
  connectionPeerId,
  connectionPeerLabel,
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
        connectionPeerLabel,
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
      connectionPeerLabel,
      connectionScope,
      editAccessRequestPending,
      runtimePeerCount,
      runtimePeerAvailable,
      selectedMode,
      workstationAttachment,
    ],
  );

  return useMemo(
    () => ({ shellCapabilities, canAcceptCellMutations, editAccessPending }),
    [canAcceptCellMutations, editAccessPending, shellCapabilities],
  );
}
