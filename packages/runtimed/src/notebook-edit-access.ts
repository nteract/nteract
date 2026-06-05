export type NotebookEditMode = "view" | "edit";
export type NotebookEditState = "viewing" | "requested" | "editing";

export interface NotebookEditPermission {
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canEditStructure: boolean;
}

export interface NotebookEditHostSupport {
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canEditStructure: boolean;
  canRequestEdit: boolean;
}

export interface NotebookEditAccessProjection extends NotebookEditPermission {
  selectedMode: NotebookEditMode;
  activeMode: NotebookEditMode;
  state: NotebookEditState;
  canRequestEdit: boolean;
}

export interface ProjectNotebookEditAccessOptions {
  selectedMode: NotebookEditMode;
  permission: NotebookEditPermission;
  hostSupport: NotebookEditHostSupport;
}

export type NotebookRoomAccessLevel = "none" | "viewer" | "editor" | "owner";
export type NotebookRoomConnectionScope = "viewer" | "editor" | "runtime_peer" | "owner";
export type NotebookRoomRequestedScope = NotebookRoomConnectionScope | "none";

export interface NotebookRoomEditAccessProjection extends NotebookEditAccessProjection {
  inputSelectedMode: NotebookEditMode;
  accessLevel: NotebookRoomAccessLevel;
  requestedScope: NotebookRoomRequestedScope | null;
  hasDocumentEditPermission: boolean;
  selectedDocumentEditMode: boolean;
  requestedDocumentEditAccess: boolean;
  editAccessPending: boolean;
}

export interface ProjectNotebookRoomEditAccessOptions {
  accessLevel: NotebookRoomAccessLevel;
  requestedScope?: NotebookRoomRequestedScope | null;
  selectedMode: NotebookEditMode;
  canAcceptDocumentMutations: boolean;
  canRequestEdit: boolean;
  editAccessRequestPending?: boolean;
}

export function projectNotebookEditAccess({
  hostSupport,
  permission,
  selectedMode,
}: ProjectNotebookEditAccessOptions): NotebookEditAccessProjection {
  const wantsEdit = selectedMode === "edit";
  const hasAnyEditPermission =
    permission.canEditMarkdown || permission.canEditCells || permission.canEditStructure;
  const hasAnyHostEditSupport =
    (permission.canEditMarkdown && hostSupport.canEditMarkdown) ||
    (permission.canEditCells && hostSupport.canEditCells) ||
    (permission.canEditStructure && hostSupport.canEditStructure);
  const canActivateEdit = wantsEdit && hasAnyEditPermission && hasAnyHostEditSupport;
  const activeMode: NotebookEditMode = canActivateEdit ? "edit" : "view";
  const state: NotebookEditState = !wantsEdit
    ? "viewing"
    : canActivateEdit
      ? "editing"
      : "requested";

  return {
    selectedMode,
    activeMode,
    state,
    canRequestEdit: hostSupport.canRequestEdit,
    canEditMarkdown:
      activeMode === "edit" && permission.canEditMarkdown && hostSupport.canEditMarkdown,
    canEditCells: activeMode === "edit" && permission.canEditCells && hostSupport.canEditCells,
    canEditStructure:
      activeMode === "edit" && permission.canEditStructure && hostSupport.canEditStructure,
  };
}

export function projectNotebookRoomEditAccess({
  accessLevel,
  requestedScope = null,
  selectedMode,
  canAcceptDocumentMutations,
  canRequestEdit,
  editAccessRequestPending = false,
}: ProjectNotebookRoomEditAccessOptions): NotebookRoomEditAccessProjection {
  const hasDocumentEditPermission = notebookRoomAccessLevelCanEditDocument(accessLevel);
  const selectedDocumentEditMode = selectedMode === "edit";
  const requestedDocumentEditAccess = requestedScope === "editor" || requestedScope === "owner";
  const editAccessPending =
    editAccessRequestPending && requestedDocumentEditAccess && !canAcceptDocumentMutations;
  const selectedInteractionMode: NotebookEditMode = editAccessPending ? "view" : selectedMode;
  const interaction = projectNotebookEditAccess({
    selectedMode: selectedInteractionMode,
    permission: {
      canEditMarkdown: hasDocumentEditPermission,
      canEditCells: hasDocumentEditPermission,
      canEditStructure: hasDocumentEditPermission,
    },
    hostSupport: {
      canEditMarkdown: canAcceptDocumentMutations,
      canEditCells: canAcceptDocumentMutations,
      canEditStructure: canAcceptDocumentMutations,
      canRequestEdit,
    },
  });

  return {
    ...interaction,
    inputSelectedMode: selectedMode,
    accessLevel,
    requestedScope,
    hasDocumentEditPermission,
    selectedDocumentEditMode,
    requestedDocumentEditAccess,
    editAccessPending,
  };
}

export function notebookRoomAccessLevelCanEditDocument(
  accessLevel: NotebookRoomAccessLevel,
): boolean {
  return accessLevel === "editor" || accessLevel === "owner";
}

export function isNotebookRoomAccessLevel(
  value: string | null | undefined,
): value is NotebookRoomAccessLevel {
  return value === "none" || value === "viewer" || value === "editor" || value === "owner";
}

export function isNotebookRoomConnectionScope(
  value: string | null | undefined,
): value is NotebookRoomConnectionScope {
  return value === "viewer" || value === "editor" || value === "runtime_peer" || value === "owner";
}

export function notebookRoomAccessLevelFromConnectionScope(
  connectionScope: string | null | undefined,
  fallbackAccessLevel: NotebookRoomAccessLevel,
): NotebookRoomAccessLevel {
  if (isNotebookRoomAccessLevel(connectionScope)) {
    return connectionScope;
  }
  if (connectionScope === "runtime_peer") {
    return "viewer";
  }
  return fallbackAccessLevel;
}
