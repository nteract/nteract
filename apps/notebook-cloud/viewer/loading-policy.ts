export interface CloudViewerLoadingPolicyConfig {
  headsHash: string | null;
  renderEndpoint: string | null;
}

export interface CloudViewerLoadingPolicy {
  shouldConnectLiveRoom: boolean;
  shouldFetchSnapshotRender: boolean;
  initialStatusMessage: string;
}

export function cloudViewerLoadingPolicy({
  headsHash,
  renderEndpoint,
}: CloudViewerLoadingPolicyConfig): CloudViewerLoadingPolicy {
  if (headsHash) {
    return {
      shouldConnectLiveRoom: false,
      shouldFetchSnapshotRender: Boolean(renderEndpoint),
      initialStatusMessage: "Loading pinned notebook snapshot...",
    };
  }

  return {
    shouldConnectLiveRoom: true,
    shouldFetchSnapshotRender: false,
    initialStatusMessage: "Connecting to live notebook room...",
  };
}
