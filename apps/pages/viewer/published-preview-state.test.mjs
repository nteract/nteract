import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PREVIEW_STATES,
  PREVIEW_EVENTS,
  previewEditorTransition as step,
} from "./published-preview-state.mjs";

test("every preview state/event pair rejects invalid transitions", () => {
  const allowed = {
    loaded: ["loading"],
    edit: ["ready"],
    prepare: ["ready"],
    prepared: ["rendering"],
    publish: ["ready"],
    uploaded: ["uploading"],
    unpublish: ["ready"],
    saved: ["publishing", "unpublishing"],
    failed: ["loading", "rendering", "uploading", "publishing", "unpublishing"],
    reload: ["ready", "failed"],
  };
  for (const name of PREVIEW_STATES)
    for (const type of PREVIEW_EVENTS) {
      const state = { name, draft: { title: "Title" }, prepared: {}, value: { snapshot: {} } };
      const next = step(state, {
        type,
        value: { snapshot: null },
        prepared: {},
        patch: {},
        nonce: "n",
        error: "Error",
      });
      assert.equal(next === state, !allowed[type].includes(name), `${name}/${type}`);
    }
});
test("edits invalidate approval; rendering, publishing and removing block duplicate actions", () => {
  const state = {
    name: "ready",
    draft: { title: "Title" },
    prepared: {},
    value: { revision: 1, snapshot: {} },
  };
  const edited = step(state, { type: "edit", patch: { description: "changed" } });
  assert.equal(edited.prepared, null);
  assert.equal(step(edited, { type: "publish" }), edited);
  const publishing = step(state, { type: "publish", nonce: "nonce" });
  assert.equal(step(publishing, { type: "edit", patch: { title: "late" } }), publishing);
  assert.equal(step(publishing, { type: "publish", nonce: "other" }), publishing);
  const failed = step(publishing, { type: "failed", error: "Connection lost" });
  assert.equal(failed.value.revision, 1);
  assert.equal(step(failed, { type: "reload" }).name, "loading");
});
