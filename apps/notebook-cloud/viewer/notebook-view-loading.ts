import type { ViewerStatus } from "./notice-types";

export interface CloudNotebookViewLoadingProjectionInput {
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

export function projectCloudNotebookViewLoading({
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
  if (status.kind === "loading") return true;
  if (editAccessPending) return true;
  if (status.kind === "empty" && cellCount === 0 && !emptyRoomGraceElapsed) return true;
  if (connectionError && !hasReadableSnapshot && !hasAccessDiagnostic) return true;
  return canEditStructure && cellCount === 0 && !liveMaterialized;
}
