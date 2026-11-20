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
    choose_layout: ["ready", "rendering", "render_failed"],
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
      const state = {
        name,
        draft: { title: "Title", visual: "upload", layout: "caption" },
        prepared: {},
        value: { snapshot: {} },
      };
      const next = step(state, {
        type,
        draft: state.draft,
        value: { snapshot: null },
        prepared: {},
        patch: {},
        file: {},
        visual: "text",
        layout: "fill",
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
  assert.equal(failed.prepared, state.prepared, "a failed upload keeps the prepared image visible");
  assert.equal(step(failed, { type: "reload" }).name, "loading");
});

test("reopening restores the private cover and render recovery preserves edited text", () => {
  const cover = { asset_id: "a".repeat(64), name: "cover.png" };
  const value = {
    revision: 1,
    snapshot: { title: "Published", description: "Before", author: "Kyle Kelley", cover },
  };
  const loaded = step({ name: "loading", draft: {} }, { type: "loaded", value });
  assert.equal(loaded.draft.visual, "upload");
  assert.equal(loaded.draft.author, "Kyle Kelley");
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
  assert.equal(uploadFailed.prepared, prepared.prepared);
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

test("a selected visual's exact source is uploaded on approval and restored for later text edits", () => {
  const start = {
    name: "ready",
    draft: { title: "Chart", visual: "text" },
    value: { revision: 0, snapshot: null },
  };
  const rendering = step(start, { type: "choose_visual", visual: "chart" });
  const sourceFile = new File(["chart pixels"], "Chart.png", { type: "image/png" });
  const ready = step(rendering, {
    type: "prepared",
    draft: rendering.draft,
    prepared: { sourceFile, blob: new Blob(["captioned card"]) },
  });
  assert.equal(ready.value.snapshot, null, "preparing does not publish or upload");
  const uploading = step(ready, { type: "publish", nonce: "nonce" });
  assert.equal(uploading.name, "uploading_cover");
  assert.equal(uploading.prepared.sourceFile, sourceFile);
  const failed = step(uploading, { type: "failed", error: "Offline" });
  assert.equal(failed.prepared.sourceFile, sourceFile, "failed uploads retain the approved source");
  const cover = { asset_id: "a".repeat(64), name: "Chart.png" };
  const covered = step(uploading, { type: "cover_uploaded", cover });
  assert.equal(covered.name, "uploading");
  assert.equal(covered.draft.visual, "upload", "text edits no longer depend on the live chart");
  assert.equal(covered.draft.cover, cover);
  const value = { revision: 1, snapshot: { title: "Chart", description: "", author: "", cover } };
  const reopened = step({ name: "loading", draft: {} }, { type: "loaded", value });
  const edited = step(reopened, { type: "edit", patch: { author: "Kyle Kelley" } });
  assert.equal(edited.draft.visual, "upload");
  assert.equal(edited.draft.cover, cover);
  const newer = step(rendering, { type: "choose_visual", visual: "text" });
  assert.equal(
    step(newer, { type: "prepared", draft: rendering.draft, prepared: ready.prepared }),
    newer,
    "a stale chart capture cannot restore a removed cover",
  );
});

test("an uploaded cover starts filling the card; other visuals keep their caption", () => {
  const start = {
    name: "ready",
    draft: { title: "Card", visual: "text", layout: "caption" },
    value: { revision: 0, snapshot: null },
  };
  const uploaded = step(start, { type: "choose_cover", file: { name: "card.png" } });
  assert.equal(uploaded.draft.layout, "fill", "a new upload starts in fill");
  const prepared = step(uploaded, { type: "prepared", draft: uploaded.draft, prepared: {} });
  const caption = step(prepared, { type: "choose_layout", layout: "caption" });
  assert.equal(caption.name, "rendering", "the author sees the new raster before publishing");
  assert.equal(caption.draft.layout, "caption");
  assert.equal(caption.prepared, null, "the old approval does not survive a layout change");
  assert.equal(step(caption, { type: "choose_layout", layout: "caption" }), caption);
  assert.equal(step(caption, { type: "choose_layout", layout: "stretch" }), caption);
  assert.equal(step(caption, { type: "choose_layout", layout: "fill" }).draft.layout, "fill");
  const chart = step(uploaded, { type: "choose_visual", visual: "0" });
  assert.equal(chart.draft.layout, "caption", "a captured visual uses caption");
  assert.equal(
    step(chart, { type: "choose_layout", layout: "fill" }),
    chart,
    "only an uploaded cover can fill the card",
  );
  const text = step(uploaded, { type: "choose_visual", visual: "text" });
  assert.equal(text.draft.layout, "caption", "a text card uses caption");
  assert.equal(step(text, { type: "choose_layout", layout: "fill" }), text);
});

test("a loaded snapshot restores its layout, and one without a layout is caption", () => {
  const cover = { asset_id: "a".repeat(64), name: "card.png" };
  const load = (snapshot) =>
    step({ name: "loading", draft: {} }, { type: "loaded", value: { revision: 1, snapshot } })
      .draft;
  const base = { title: "Card", description: "", author: "" };
  assert.equal(load({ ...base, cover, layout: "fill" }).layout, "fill");
  assert.equal(load({ ...base, cover, layout: "caption" }).layout, "caption");
  assert.equal(load({ ...base, cover }).layout, "caption", "older previews keep their look");
  assert.equal(load({ ...base, cover: null, layout: "fill" }).layout, "caption");
});
