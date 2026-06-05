import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

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

const EDIT_ACCESS_CACHE = new Map<string, NotebookEditAccessProjection>();
const ROOM_EDIT_ACCESS_CACHE = new Map<string, NotebookRoomEditAccessProjection>();
const EDIT_ACCESS_CACHE_LIMIT = 128;
const ROOM_EDIT_ACCESS_CACHE_LIMIT = 256;

export function clearNotebookEditAccessProjectionCachesForTests(): void {
  EDIT_ACCESS_CACHE.clear();
  ROOM_EDIT_ACCESS_CACHE.clear();
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
  const canEditMarkdown =
    activeMode === "edit" && permission.canEditMarkdown && hostSupport.canEditMarkdown;
  const canEditCells = activeMode === "edit" && permission.canEditCells && hostSupport.canEditCells;
  const canEditStructure =
    activeMode === "edit" && permission.canEditStructure && hostSupport.canEditStructure;
  const cacheKey = stableCacheKey([
    selectedMode,
    activeMode,
    state,
    hostSupport.canRequestEdit,
    canEditMarkdown,
    canEditCells,
    canEditStructure,
  ]);
  const cached = getBoundedCacheValue(EDIT_ACCESS_CACHE, cacheKey);
  if (cached) return cached;

  const projection = Object.freeze({
    selectedMode,
    activeMode,
    state,
    canRequestEdit: hostSupport.canRequestEdit,
    canEditMarkdown,
    canEditCells,
    canEditStructure,
  });
  setBoundedCacheValue(EDIT_ACCESS_CACHE, cacheKey, projection, EDIT_ACCESS_CACHE_LIMIT);
  return projection;
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
  const cacheKey = stableCacheKey([
    interaction.selectedMode,
    interaction.activeMode,
    interaction.state,
    interaction.canRequestEdit,
    interaction.canEditMarkdown,
    interaction.canEditCells,
    interaction.canEditStructure,
    selectedMode,
    accessLevel,
    requestedScope,
    hasDocumentEditPermission,
    selectedDocumentEditMode,
    requestedDocumentEditAccess,
    editAccessPending,
  ]);
  const cached = getBoundedCacheValue(ROOM_EDIT_ACCESS_CACHE, cacheKey);
  if (cached) return cached;

  const projection = Object.freeze({
    ...interaction,
    inputSelectedMode: selectedMode,
    accessLevel,
    requestedScope,
    hasDocumentEditPermission,
    selectedDocumentEditMode,
    requestedDocumentEditAccess,
    editAccessPending,
  });
  setBoundedCacheValue(ROOM_EDIT_ACCESS_CACHE, cacheKey, projection, ROOM_EDIT_ACCESS_CACHE_LIMIT);
  return projection;
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
