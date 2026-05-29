import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertPublishResultMatchesSource,
  smokeEnvForPublishResult,
} from "../scripts/hosted-live-smoke-env.mjs";

describe("hosted live smoke environment", () => {
  it("threads live-published snapshot heads into the hosted smoke expectations", () => {
    const smokeEnv = smokeEnvForPublishResult(
      {},
      {
        viewerUrl: "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/live-source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
      },
    );

    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_HOSTED_URL,
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/live-source",
    );
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH,
      "heads-notebook",
    );
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH,
      "heads-runtime",
    );
    assert.equal(
      Object.hasOwn(smokeEnv, "NOTEBOOK_CLOUD_EXPECTED_RENDER_SOURCE"),
      false,
      "live smoke should use the latest viewer path without requiring /render by default",
    );
  });

  it("does not override explicit hosted smoke expectation env values", () => {
    const smokeEnv = smokeEnvForPublishResult(
      {
        NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH: "",
        NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH: "override-runtime",
        NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN: "https://assets.example.test",
      },
      {
        viewerUrl: "http://127.0.0.1:8787/n/live-source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
      },
    );

    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH, "");
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH,
      "override-runtime",
    );
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN,
      "https://assets.example.test",
    );
  });

  it("uses the viewer origin as the renderer asset origin for loopback live smoke", () => {
    const smokeEnv = smokeEnvForPublishResult(
      {},
      {
        viewerUrl: "http://127.0.0.1:8787/n/live-source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
      },
    );

    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN, "http://127.0.0.1:8787");
  });

  it("rejects publish results without exported snapshot heads unless expectations are explicit", () => {
    assert.throws(
      () =>
        smokeEnvForPublishResult(
          {},
          {
            viewerUrl: "http://127.0.0.1:8787/n/live-source",
          },
        ),
      /did not provide headsHash/,
    );
    assert.doesNotThrow(() =>
      smokeEnvForPublishResult(
        {
          NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH: "",
          NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH: "",
        },
        {
          viewerUrl: "http://127.0.0.1:8787/n/live-source",
        },
      ),
    );
  });

  it("rejects a publish result from the wrong source notebook", () => {
    assert.throws(
      () =>
        assertPublishResultMatchesSource(
          { NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID: "expected-notebook" },
          { sourceNotebookId: "other-notebook" },
        ),
      /expected expected-notebook/,
    );
  });
});
