import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cloudViewerLoadingPolicy } from "../viewer/loading-policy.ts";

describe("cloud viewer loading policy", () => {
  it("uses live room sync with render warm-start for latest notebook URLs", () => {
    assert.deepEqual(
      cloudViewerLoadingPolicy({
        headsHash: null,
      }),
      {
        shouldConnectLiveRoom: true,
        shouldFetchSnapshotRender: true,
        snapshotRenderMode: "latest-warm-start",
        initialStatusMessage: "Connecting to live notebook room...",
      },
    );
  });

  it("uses pinned snapshot rendering for immutable revision URLs", () => {
    assert.deepEqual(
      cloudViewerLoadingPolicy({
        headsHash: "heads-123",
      }),
      {
        shouldConnectLiveRoom: false,
        shouldFetchSnapshotRender: true,
        snapshotRenderMode: "pinned",
        initialStatusMessage: "Loading pinned notebook snapshot...",
      },
    );
  });
});
