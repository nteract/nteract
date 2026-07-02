import {
  isNotebookRoomConnectionScope,
  notebookRoomAccessLevelFromConnectionScope,
  projectNotebookRoomEditAccess,
  type NotebookEditMode,
  type NotebookRoomAccessLevel,
  type NotebookRoomEditAccessProjection,
  type NotebookRoomRequestedScope,
} from "runtimed";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import { cloudNotebookScopeCanEditDocument } from "./cloud-notebook-catalog-access";
import type { ViewerStatus } from "./notice-types";

export interface CloudNotebookEditAccessInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  hasAppSession?: boolean;
  selectedMode?: NotebookEditMode;
  canAcceptCellMutations?: boolean;
  editAccessRequestPending?: boolean;
}

export interface CloudNotebookDocumentEditReadinessInput {
  accessScope: string | null;
  connectionError: string | null;
  connectionPeerId: string | null;
  connectionScope: string | null;
  selectedMode?: NotebookEditMode;
  statusKind: ViewerStatus["kind"];
}

export interface CloudNotebookDocumentEditReadinessProjection {
  /**
   * The live room is connected with write authority and can safely accept local
   * NotebookDoc mutations. Catalog access alone is not enough here.
   */
  canAcceptCellMutations: boolean;
  /**
   * The user selected edit mode and their account has edit access, but the
   * writable live room has not arrived yet.
   */
  selectedEditModeWaitingForRoom: boolean;
  /**
   * The shared shell should keep edit controls in a pending/viewing state while
   * the hosted room is reconnecting or still waiting for writable authority.
   */
  editAccessRequestPending: boolean;
}

export function projectCloudNotebookEditAccess({
  authState,
  connectionScope,
  hasAppSession = false,
  selectedMode = "view",
  canAcceptCellMutations = true,
  editAccessRequestPending = false,
}: CloudNotebookEditAccessInput): NotebookRoomEditAccessProjection {
  return projectNotebookRoomEditAccess({
    accessLevel: cloudConnectionAccessLevel(connectionScope),
    requestedScope: cloudRequestedScope(authState.requestedScope),
    selectedMode,
    canAcceptDocumentMutations: canAcceptCellMutations,
    canRequestEdit: cloudAuthCanRequestEdit(authState, hasAppSession),
    editAccessRequestPending,
  });
}

export function projectCloudNotebookDocumentEditReadiness({
  accessScope,
  connectionError,
  connectionPeerId,
  connectionScope,
  selectedMode = "view",
  statusKind,
}: CloudNotebookDocumentEditReadinessInput): CloudNotebookDocumentEditReadinessProjection {
  const canAcceptCellMutations =
    Boolean(connectionPeerId) &&
    !connectionError &&
    (statusKind === "ready" || statusKind === "empty") &&
    cloudNotebookScopeCanEditDocument(connectionScope);
  const selectedEditModeWaitingForRoom =
    selectedMode === "edit" &&
    cloudNotebookScopeCanEditDocument(accessScope) &&
    !canAcceptCellMutations &&
    !connectionError &&
    (statusKind === "loading" || statusKind === "ready" || statusKind === "empty");
  return {
    canAcceptCellMutations,
    selectedEditModeWaitingForRoom,
    editAccessRequestPending:
      (!connectionError && statusKind === "loading") || selectedEditModeWaitingForRoom,
  };
}

export function cloudConnectionAccessLevel(
  connectionScope: string | null,
): NotebookRoomAccessLevel {
  return notebookRoomAccessLevelFromConnectionScope(connectionScope, "viewer");
}

function cloudRequestedScope(requestedScope: string | null): NotebookRoomRequestedScope | null {
  if (isNotebookRoomConnectionScope(requestedScope)) {
    return requestedScope;
  }
  return null;
}

function cloudAuthCanRequestEdit(
  authState: CloudPrototypeAuthState,
  hasAppSession: boolean,
): boolean {
  return hasAppSession || authState.mode === "dev" || authState.mode === "oidc";
}
