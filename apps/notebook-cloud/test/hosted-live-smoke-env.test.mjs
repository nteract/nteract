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
        viewerUrl: "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/live-source/source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
        runtimeStateDocId: "runtime-state-doc",
        ownerPrincipal: "user:dev:live-publish",
        latestRevisionActorLabel: "user:dev:live-publish/agent:publish-live",
      },
    );

    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_HOSTED_URL,
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/live-source/source",
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
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_STATE_DOC_ID,
      "runtime-state-doc",
    );
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL, "user:dev:live-publish");
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL,
      "user:dev:live-publish/agent:publish-live",
    );
    assert.equal(
      Object.hasOwn(smokeEnv, "NOTEBOOK_CLOUD_EXPECTED_RENDER_SOURCE"),
      false,
      "live smoke should use catalog plus Automerge snapshots without requiring a render API",
    );
  });

  it("does not override explicit hosted smoke expectation env values", () => {
    const smokeEnv = smokeEnvForPublishResult(
      {
        NOTEBOOK_CLOUD_LIVE_PRESET: "mathnet",
        NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH: "",
        NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH: "override-runtime",
        NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL: "override-owner",
        NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL: "override-actor",
        NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS: "override-page",
        NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN: "https://assets.example.test",
      },
      {
        viewerUrl: "http://127.0.0.1:8787/n/live-source/source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
        runtimeStateDocId: "runtime-state-doc",
        ownerPrincipal: "user:dev:live-publish",
        latestRevisionActorLabel: "user:dev:live-publish/agent:publish-live",
        preset: "source-notebook",
      },
    );

    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH, "");
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH,
      "override-runtime",
    );
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL, "override-owner");
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL, "override-actor");
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS, "override-page");
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN,
      "https://assets.example.test",
    );
  });

  it("uses the viewer origin as the renderer asset origin for loopback live smoke", () => {
    const smokeEnv = smokeEnvForPublishResult(
      {},
      {
        viewerUrl: "http://127.0.0.1:8787/n/live-source/source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
        runtimeStateDocId: "runtime-state-doc",
      },
    );

    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN, "http://127.0.0.1:8787");
  });

  it("uses mathnet live fixture smoke expectations for generated live publishes", () => {
    const smokeEnv = smokeEnvForPublishResult(
      {},
      {
        viewerUrl: "https://preview.runt.run/n/live-source/source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
        runtimeStateDocId: "runtime-state-doc",
        preset: "mathnet",
      },
    );

    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT, "ShadenA/MathNet");
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS,
      JSON.stringify(["MathNet topic visualization", "Loading the slice", "Loaded 25 rows"]),
    );
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS, "");
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_PRESENCE_TITLE, "");
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM, "0");
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_SMOKE_THEME_MODES, "");
  });

  it("uses the requested live preset for source-room publishes", () => {
    const smokeEnv = smokeEnvForPublishResult(
      { NOTEBOOK_CLOUD_LIVE_PRESET: "html-output" },
      {
        viewerUrl: "https://preview.runt.run/n/live-source/source",
        headsHash: "heads-notebook",
        runtimeHeadsHash: "heads-runtime",
        runtimeStateDocId: "runtime-state-doc",
        preset: "source-notebook",
      },
    );

    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT, "html-output-origin-probe");
    assert.equal(
      smokeEnv.NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS,
      JSON.stringify(["Hello from HTML output document"]),
    );
    assert.equal(smokeEnv.NOTEBOOK_CLOUD_EXPECTED_PRESENCE_TITLE, "");
  });

  it("rejects publish results without exported snapshot heads unless expectations are explicit", () => {
    assert.throws(
      () =>
        smokeEnvForPublishResult(
          {},
          {
            viewerUrl: "http://127.0.0.1:8787/n/live-source/source",
          },
        ),
      /did not provide headsHash/,
    );
    assert.doesNotThrow(() =>
      smokeEnvForPublishResult(
        {
          NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH: "",
          NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH: "",
          NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_STATE_DOC_ID: "",
        },
        {
          viewerUrl: "http://127.0.0.1:8787/n/live-source/source",
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
