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

export interface CloudNotebookEditAccessInput {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  hasAppSession?: boolean;
  selectedMode?: NotebookEditMode;
  canAcceptCellMutations?: boolean;
  editAccessRequestPending?: boolean;
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
