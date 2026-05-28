import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cloudViewerLoadingPolicy } from "../viewer/loading-policy.ts";

describe("cloud viewer loading policy", () => {
  it("uses live room sync for latest notebook URLs", () => {
    assert.deepEqual(
      cloudViewerLoadingPolicy({
        headsHash: null,
        renderEndpoint: null,
      }),
      {
        shouldConnectLiveRoom: true,
        shouldFetchSnapshotRender: false,
        initialStatusMessage: "Connecting to live notebook room...",
      },
    );
  });

  it("uses pinned snapshot rendering for immutable revision URLs", () => {
    assert.deepEqual(
      cloudViewerLoadingPolicy({
        headsHash: "heads-123",
        renderEndpoint: "/api/n/demo/renders/heads-123",
      }),
      {
        shouldConnectLiveRoom: false,
        shouldFetchSnapshotRender: true,
        initialStatusMessage: "Loading pinned notebook snapshot...",
      },
    );
  });
});
