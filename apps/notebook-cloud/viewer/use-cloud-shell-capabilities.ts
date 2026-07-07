import { useMemo } from "react";
import type { WorkstationAttachmentState } from "runtimed";

import {
  type NotebookInteractionMode,
  type NotebookShellCapabilities,
} from "@/components/notebook";

import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import {
  projectCloudNotebookDocumentEditReadiness,
  projectCloudNotebookEditAccess,
} from "./edit-access";
import type { ViewerStatus } from "./notice-types";
import { cloudNotebookShellCapabilities } from "./shell-capabilities";

interface UseCloudShellCapabilitiesInput {
  accessConnectionScope?: string | null;
  authState: CloudPrototypeAuthState;
  selfDisplay?: {
    label?: string | null;
    imageUrl?: string | null;
  };
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
  kernelStatusLabel: string | null;
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
  accessConnectionScope = null,
  authState,
  selfDisplay,
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
  kernelStatusLabel,
  workstationAttachment,
  hostCapabilities,
}: UseCloudShellCapabilitiesInput): CloudShellCapabilities {
  const documentAccessScope = accessConnectionScope ?? connectionScope;
  const editReadiness = useMemo(
    () =>
      projectCloudNotebookDocumentEditReadiness({
        accessScope: documentAccessScope,
        connectionError,
        connectionPeerId,
        connectionScope,
        selectedMode,
        statusKind: status.kind,
      }),
    [
      connectionError,
      connectionPeerId,
      connectionScope,
      documentAccessScope,
      selectedMode,
      status.kind,
    ],
  );
  const roomEditAccess = useMemo(
    () =>
      projectCloudNotebookEditAccess({
        authState,
        connectionScope: documentAccessScope,
        selectedMode,
        canAcceptCellMutations: editReadiness.canAcceptCellMutations,
        editAccessRequestPending: editReadiness.editAccessRequestPending,
      }),
    [
      authState,
      documentAccessScope,
      editReadiness.canAcceptCellMutations,
      editReadiness.editAccessRequestPending,
      selectedMode,
    ],
  );
  const editAccessPending =
    roomEditAccess.editAccessPending || editReadiness.selectedEditModeWaitingForRoom;
  const shellCapabilities = useMemo(
    () =>
      cloudNotebookShellCapabilities({
        accessConnectionScope: documentAccessScope,
        authState,
        selfDisplay,
        connectionScope,
        connectionActorLabel,
        connectionPeerLabel,
        hasAppSession,
        hasCodeCells: codeCellCount > 0,
        selectedMode,
        canAcceptCellMutations: editReadiness.canAcceptCellMutations,
        editAccessRequestPending: editReadiness.editAccessRequestPending,
        runtimeAvailable: runtimePeerAvailable,
        runtimePeerCount,
        kernelStatusLabel,
        workstationAttachment,
        hostCapabilities,
      }),
    [
      authState,
      selfDisplay?.imageUrl,
      selfDisplay?.label,
      hasAppSession,
      documentAccessScope,
      codeCellCount,
      hostCapabilities,
      connectionActorLabel,
      connectionPeerLabel,
      connectionScope,
      editReadiness.canAcceptCellMutations,
      editReadiness.editAccessRequestPending,
      kernelStatusLabel,
      runtimePeerCount,
      runtimePeerAvailable,
      selectedMode,
      workstationAttachment,
    ],
  );

  return useMemo(
    () => ({
      shellCapabilities,
      canAcceptCellMutations: editReadiness.canAcceptCellMutations,
      editAccessPending,
    }),
    [editAccessPending, editReadiness.canAcceptCellMutations, shellCapabilities],
  );
}
