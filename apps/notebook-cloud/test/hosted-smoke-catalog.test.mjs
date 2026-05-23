import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogExpectationFailures,
  summarizeCatalog,
} from "../scripts/hosted-render-smoke-catalog.mjs";

describe("hosted render smoke catalog checks", () => {
  it("uses notebook.latest_revision_id to select the revision actor", () => {
    const summary = summarizeCatalog({
      notebook: {
        owner_principal: "user:dev:live-publish",
        latest_revision_id: "revision-2",
      },
      revisions: [
        { id: "revision-1", actor_label: "user:dev:fixture/agent:publish-fixture" },
        {
          id: "revision-2",
          actor_label: "user:dev:live-publish/agent:publish-live",
          notebook_heads_hash: "heads-notebook",
          runtime_heads_hash: "heads-runtime",
        },
      ],
    });

    assert.deepEqual(summary, {
      ownerPrincipal: "user:dev:live-publish",
      latestRevisionId: "revision-2",
      latestRevisionActorLabel: "user:dev:live-publish/agent:publish-live",
      latestRevisionNotebookHeadsHash: "heads-notebook",
      latestRevisionRuntimeHeadsHash: "heads-runtime",
      revisionCount: 2,
    });
  });

  it("does not fall back to the first revision when latest_revision_id is absent", () => {
    const summary = summarizeCatalog({
      notebook: { owner_principal: "user:dev:live-publish" },
      revisions: [{ id: "revision-1", actor_label: "user:dev:live-publish/agent:publish-live" }],
    });

    assert.equal(summary.latestRevisionId, null);
    assert.equal(summary.latestRevisionActorLabel, null);
    assert.equal(summary.latestRevisionNotebookHeadsHash, null);
    assert.equal(summary.latestRevisionRuntimeHeadsHash, null);
  });

  it("reports catalog expectation mismatches", () => {
    assert.deepEqual(
      catalogExpectationFailures(
        {
          ownerPrincipal: "user:dev:fixture",
          latestRevisionId: "revision-1",
          latestRevisionActorLabel: null,
          revisionCount: 1,
        },
        {
          expectedCatalogOwnerPrincipal: "user:dev:live-publish",
          expectedLatestRevisionActorLabel: "user:dev:live-publish/agent:publish-live",
          expectedLatestRevisionNotebookHeadsHash: "heads-notebook",
          expectedLatestRevisionRuntimeHeadsHash: "heads-runtime",
        },
      ),
      [
        {
          text: "expected catalog owner user:dev:live-publish, got user:dev:fixture",
        },
        {
          text: "expected latest revision actor user:dev:live-publish/agent:publish-live, got missing",
        },
        {
          text: "expected latest notebook heads heads-notebook, got missing",
        },
        {
          text: "expected latest runtime heads heads-runtime, got missing",
        },
      ],
    );
  });
});
