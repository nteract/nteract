import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalViewerUrl,
  createUlid,
  isCanonicalUlid,
  notebookIdFromEnvOrGenerated,
  runtimeStateDocIdFromEnvOrDefault,
  vanityNameFromEnvOrNotebookName,
} from "../scripts/publish-notebook-id.mjs";

describe("publish notebook ids", () => {
  it("generates canonical ULID-shaped notebook ids by default", () => {
    const id = notebookIdFromEnvOrGenerated({});

    assert.equal(isCanonicalUlid(id), true);
  });

  it("preserves explicit notebook id overrides", () => {
    assert.equal(
      notebookIdFromEnvOrGenerated({ NOTEBOOK_CLOUD_NOTEBOOK_ID: "topic-viz" }),
      "topic-viz",
    );
  });

  it("keeps runtime state document ids paired to generated notebook ids", () => {
    assert.equal(
      runtimeStateDocIdFromEnvOrDefault("01KSQKEPFJVHV4T4ZDYS9V7T80"),
      "runtime:01KSQKEPFJVHV4T4ZDYS9V7T80",
    );
    assert.equal(
      runtimeStateDocIdFromEnvOrDefault("doc", {
        NOTEBOOK_CLOUD_RUNTIME_STATE_DOC_ID: "runtime:explicit",
      }),
      "runtime:explicit",
    );
  });

  it("builds canonical vanity viewer URLs", () => {
    assert.equal(
      canonicalViewerUrl("https://preview.runt.run", "01KSQKEPFJVHV4T4ZDYS9V7T80", "lets-edit"),
      "https://preview.runt.run/n/01KSQKEPFJVHV4T4ZDYS9V7T80/lets-edit",
    );
  });

  it("uses semantic notebook titles for vanity names", () => {
    assert.equal(vanityNameFromEnvOrNotebookName("Let's edit"), "let-s-edit");
    assert.equal(vanityNameFromEnvOrNotebookName("~/notebooks/topic viz.ipynb"), "topic-viz");
    assert.equal(
      vanityNameFromEnvOrNotebookName("ignored.ipynb", { NOTEBOOK_CLOUD_VANITY_NAME: "topic-viz" }),
      "topic-viz",
    );
  });

  it("encodes ULID timestamp and random bytes predictably", () => {
    const id = createUlid(0x0198387e6c00, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

    assert.equal(id, "01K0W7WV00000G40R40M30E209");
  });
});
