import type { DaemonReadyPayload } from "@nteract/notebook-host";

export function notebookReadyIdentity(
  payload: Pick<DaemonReadyPayload, "notebook_id" | "notebook_path">,
): string | null {
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
