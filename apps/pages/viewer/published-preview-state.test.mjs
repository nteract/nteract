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
    edit: ["ready", "rendering"],
    choose_cover: ["ready", "rendering"],
    choose_visual: ["ready", "rendering"],
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
        draft: state.draft,
        value: { snapshot: null },
        prepared: {},
        patch: {},
        file: {},
        visual: "text",
        nonce: "n",
        error: "Error",
      });
      assert.equal(next === state, !allowed[type].includes(name), `${name}/${type}`);
    }
});

test("choosing a cover renders immediately without publishing, even before a title is entered", () => {
  const state = {
    name: "ready",
    draft: { title: "", visual: "upload" },
    prepared: null,
    value: { revision: 2, snapshot: {} },
  };
  assert.equal(
    step(state, { type: "choose_cover" }),
    state,
    "cancelling the picker keeps the draft",
  );
  const file = { name: "cover.png" };
  const rendering = step(state, { type: "choose_cover", file });
  assert.equal(rendering.name, "rendering");
  assert.equal(rendering.draft.file, file);
  assert.equal(rendering.value, state.value, "the published snapshot remains unchanged");
  const prepared = step(rendering, { type: "prepared", draft: rendering.draft, prepared: {} });
  assert.equal(
    step(prepared, { type: "publish", nonce: "n" }),
    prepared,
    "a title is still required to publish",
  );
});
test("edits invalidate approval; rendering, publishing and removing block duplicate actions", () => {
  const state = {
    name: "ready",
    draft: { title: "Title" },
    prepared: {},
    value: { revision: 1, snapshot: {} },
  };
  const edited = step(state, { type: "edit", patch: { description: "changed" } });
  assert.equal(edited.name, "rendering");
  assert.equal(edited.prepared, state.prepared, "keep the last image visible while rendering");
  const cleared = step(edited, { type: "edit", patch: { description: "" } });
  assert.equal(cleared.draft.description, "");
  assert.equal(
    step(cleared, { type: "prepared", draft: edited.draft, prepared: {} }),
    cleared,
    "a late render cannot replace newer text",
  );
  assert.equal(
    edited.edited,
    true,
    "a local draft no longer presents the published image as its preview",
  );
  assert.equal(step(edited, { type: "publish" }), edited);
  const publishing = step(state, { type: "publish", nonce: "nonce" });
  assert.equal(step(publishing, { type: "edit", patch: { title: "late" } }), publishing);
  assert.equal(step(publishing, { type: "publish", nonce: "other" }), publishing);
  const failed = step(publishing, { type: "failed", error: "Connection lost" });
  assert.equal(failed.value.revision, 1);
  assert.equal(step(failed, { type: "reload" }).name, "loading");
});
