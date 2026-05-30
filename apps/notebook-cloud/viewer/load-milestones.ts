const CLOUD_VIEWER_MILESTONE_PREFIX = "nteract:notebook-cloud:";

export type CloudViewerLoadMilestone =
  | "viewer-start"
  | "snapshot-initial-cells"
  | "snapshot-ready"
  | "live-room-ready"
  | "live-initial-cells"
  | "live-ready";

export function markCloudViewerLoadMilestone(name: CloudViewerLoadMilestone): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }

  try {
    performance.mark(cloudViewerLoadMilestoneName(name));
  } catch {
    // Performance marks are diagnostic only; never let browser support or quota
    // issues affect notebook rendering.
  }
}

export function cloudViewerLoadMilestoneName(name: CloudViewerLoadMilestone): string {
  return `${CLOUD_VIEWER_MILESTONE_PREFIX}${name}`;
}
