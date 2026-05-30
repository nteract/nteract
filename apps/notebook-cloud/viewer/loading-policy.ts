export interface CloudViewerLoadingPolicyConfig {
  headsHash: string | null;
}

export interface CloudViewerLoadingPolicy {
  shouldConnectLiveRoom: boolean;
  shouldFetchSnapshotRender: boolean;
  snapshotRenderMode: "latest-warm-start" | "pinned" | null;
  initialStatusMessage: string;
}

export function cloudViewerLoadingPolicy({
  headsHash,
}: CloudViewerLoadingPolicyConfig): CloudViewerLoadingPolicy {
  if (headsHash) {
    return {
      shouldConnectLiveRoom: false,
      shouldFetchSnapshotRender: true,
      snapshotRenderMode: "pinned",
      initialStatusMessage: "Loading pinned notebook snapshot...",
    };
  }

  return {
    shouldConnectLiveRoom: true,
    shouldFetchSnapshotRender: true,
    snapshotRenderMode: "latest-warm-start",
    initialStatusMessage: "Connecting to live notebook room...",
  };
}
