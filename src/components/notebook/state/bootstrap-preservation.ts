export interface NotebookReadyIdentityPayload {
  notebook_id?: string | null;
  notebook_path?: string | null;
}

export function notebookReadyIdentity(payload: NotebookReadyIdentityPayload): string | null {
  if (typeof payload.notebook_id === "string" && payload.notebook_id.length > 0) {
    return `id:${payload.notebook_id}`;
  }
  if (typeof payload.notebook_path === "string" && payload.notebook_path.length > 0) {
    return `path:${payload.notebook_path}`;
  }
  return null;
}

export function shouldPreserveBootstrapProjection({
  previousIdentity,
  nextIdentity,
  visibleCellCount,
}: {
  previousIdentity: string | null;
  nextIdentity: string | null;
  visibleCellCount: number;
}): boolean {
  return (
    previousIdentity !== null &&
    nextIdentity !== null &&
    previousIdentity === nextIdentity &&
    visibleCellCount > 0
  );
}
