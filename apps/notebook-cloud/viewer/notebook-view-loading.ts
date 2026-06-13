import type { ViewerStatus } from "./notice-types";

export interface CloudNotebookViewLoadingProjectionInput {
  bodyAccessBlocked: boolean;
  cellCount: number;
  canEditStructure: boolean;
  connectionError: string | null;
  editAccessPending: boolean;
  emptyRoomGraceElapsed: boolean;
  hasAccessDiagnostic: boolean;
  hasReadableSnapshot: boolean;
  liveMaterialized: boolean;
  status: ViewerStatus;
}

export interface CloudNotebookViewSurfaceProjection {
  isLoading: boolean;
  shouldRenderNotebookView: boolean;
}

export interface CloudNotebookHeaderChromeProjectionInput {
  bodyAccessBlocked: boolean;
}

export interface CloudNotebookHeaderChromeProjection {
  showConnectionIdentity: boolean;
  showPresenceStatus: boolean;
}

export function projectCloudNotebookViewLoading({
  bodyAccessBlocked,
  cellCount,
  canEditStructure,
  connectionError,
  editAccessPending,
  emptyRoomGraceElapsed,
  hasAccessDiagnostic,
  hasReadableSnapshot,
  liveMaterialized,
  status,
}: CloudNotebookViewLoadingProjectionInput): boolean {
  if (bodyAccessBlocked) return false;
  if (status.kind === "loading") return true;
  if (editAccessPending) return true;
  if (status.kind === "empty" && cellCount === 0 && !emptyRoomGraceElapsed) return true;
  if (connectionError && !hasReadableSnapshot && !hasAccessDiagnostic) return true;
  return canEditStructure && cellCount === 0 && !liveMaterialized;
}

export function projectCloudNotebookViewSurface(
  input: CloudNotebookViewLoadingProjectionInput,
): CloudNotebookViewSurfaceProjection {
  return {
    isLoading: projectCloudNotebookViewLoading(input),
    shouldRenderNotebookView: !input.bodyAccessBlocked,
  };
}

export function projectCloudNotebookHeaderChrome({
  bodyAccessBlocked,
}: CloudNotebookHeaderChromeProjectionInput): CloudNotebookHeaderChromeProjection {
  const showCollaborationChrome = !bodyAccessBlocked;
  return {
    showConnectionIdentity: showCollaborationChrome,
    showPresenceStatus: showCollaborationChrome,
  };
}
