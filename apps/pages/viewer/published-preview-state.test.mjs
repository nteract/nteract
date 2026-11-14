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
    edit: ["ready", "rendering", "render_failed"],
    choose_cover: ["ready", "rendering", "render_failed"],
    choose_visual: ["ready", "rendering", "render_failed"],
    prepare: ["ready", "render_failed"],
    prepared: ["rendering"],
    publish: ["ready"],
    uploaded: ["uploading"],
    cover_uploaded: ["uploading_cover"],
    unpublish: ["ready"],
    saved: ["publishing", "unpublishing"],
    failed: ["loading", "rendering", "uploading_cover", "uploading", "publishing", "unpublishing"],
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

test("reopening restores the private cover and render recovery preserves edited text", () => {
  const cover = { asset_id: "a".repeat(64), name: "cover.png" };
  const value = { revision: 1, snapshot: { title: "Published", description: "Before", cover } };
  const loaded = step({ name: "loading", draft: {} }, { type: "loaded", value });
  assert.equal(loaded.draft.visual, "upload");
  assert.deepEqual(loaded.draft.cover, cover);
  const edited = step(loaded, { type: "edit", patch: { description: "After" } });
  const failed = step(edited, { type: "failed", draft: edited.draft, error: "Decode failed" });
  assert.equal(failed.name, "render_failed");
  const retry = step(failed, { type: "prepare" });
  assert.equal(retry.name, "rendering");
  assert.equal(retry.draft, edited.draft);
  assert.equal(step(failed, { type: "edit", patch: { title: "Corrected" } }).name, "rendering");
  assert.equal(
    step(failed, { type: "choose_cover", file: { name: "replacement.png" } }).name,
    "rendering",
  );
  const prepared = step(retry, { type: "prepared", draft: retry.draft, prepared: {} });
  const upload = step(prepared, { type: "publish", nonce: "n" });
  assert.equal(upload.name, "uploading", "a saved cover does not need another upload");
  const uploadFailed = step(upload, { type: "failed", error: "Offline" });
  const reloaded = step(step(uploadFailed, { type: "reload" }), { type: "loaded", value });
  assert.equal(reloaded.edited, true, "the retained draft is not presented as the published image");
  assert.equal(
    reloaded.draft,
    edited.draft,
    "a network-error reload refreshes the revision without discarding the draft",
  );
  const replacement = step(prepared, { type: "choose_cover", file: { name: "new.png" } });
  const ready = step(replacement, { type: "prepared", draft: replacement.draft, prepared: {} });
  assert.equal(step(ready, { type: "publish" }).name, "uploading_cover");
});
