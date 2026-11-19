// An executable view loads only what its own record binds. A Page source is
// data to the view whatever its id, so a source named widget-imports is read
// by nothing and listed like any other source.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";
import { BehaviorSubject, of } from "rxjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { readView, setView, viewGenesis } from "../model/view-doc.mjs";
import { imageAssetUrl } from "../shared/image-assets.mjs";
import { mount } from "./anywidget-view.mjs";
import { PageSourceStore } from "./page-source-store.mjs";
import { projectSourcesPanel } from "./sources-panel-store.mjs";
import { sourceLine } from "./source-line.mjs";

const PAGE = "33333333-3333-4333-8333-333333333333";
const by = { principal: "account:test", displayName: "Test", driver: "Agent" };
// A loopback output host serves a catalog (widget-imports.mjs).
const FRAME = "http://127.0.0.1:9896/frame/v2/";
const encoder = new TextEncoder();
const sha256 = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

const entry = encoder.encode("export default { render() {} };");
const entryId = await sha256(entry);
const moduleBytes = encoder.encode("export const injected = true;");
const moduleId = await sha256(moduleBytes);
const declaration = encoder.encode(
  JSON.stringify({
    catalog: "standard",
    catalog_revision: "e".repeat(64),
    imports: ["react"],
    modules: [{ name: "injected", source_id: "entry", revision: "1", asset_id: moduleId }],
  }),
);
const declarationId = await sha256(declaration);
const assets = new Map([
  [entryId, { bytes: entry, media_type: "text/javascript" }],
  [moduleId, { bytes: moduleBytes, media_type: "text/javascript" }],
  [declarationId, { bytes: declaration, media_type: "application/octet-stream" }],
]);

const sourcesDoc = A.change(sourcesGenesis(PAGE), (draft) =>
  setSources(
    draft,
    [
      {
        op: "set_source",
        source_id: "entry",
        name: "Entry",
        source_revision: null,
        asset_id: entryId,
      },
      {
        op: "set_source",
        source_id: "widget-imports",
        name: "Imports",
        source_revision: null,
        asset_id: declarationId,
      },
    ],
    { by, mediaTypes: new Map([...assets].map(([id, asset]) => [id, asset.media_type])) },
  ),
);

function viewRecord(catalogRevision) {
  const doc = A.change(viewGenesis("44444444-4444-4444-8444-444444444444"), (draft) =>
    setView(
      draft,
      {
        op: "set_view",
        view_id: "daily",
        title: "Daily",
        view_type: "module",
        module: { source_id: "entry" },
        view_revision: null,
      },
      { sourcesDoc, by, catalogRevision },
    ),
  );
  return readView(doc, "daily");
}

async function mountView(view) {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const requested = [];
  const request = async (url) => {
    requested.push(url);
    const id = url.split("/").at(-1);
    const asset = assets.get(id);
    if (!asset) return new Response(null, { status: 404 });
    return new Response(asset.bytes, { headers: { "content-type": asset.media_type } });
  };
  const sources = new PageSourceStore({
    pageId: PAGE,
    doc$: new BehaviorSubject(sourcesDoc),
    request,
  });
  let mounted;
  const settled = new Promise((resolve) => {
    mounted = mount(window.document.body, {
      view$: of({ status: "ready", view }),
      sources,
      frameUrl: FRAME,
      theme: { subscribe: () => () => {}, getSnapshot: () => ({ resolved: "light" }) },
      mountOutput(_container, payload, options) {
        resolve({ payload, frameUrl: options.frameUrl });
        return { destroy() {}, setHostContext() {} };
      },
    });
    const root = window.document.querySelector(".pages-anywidget-view");
    new window.MutationObserver(() => {
      if (root.dataset.outputState === "failed")
        resolve({ failed: root.querySelector("p").textContent });
    }).observe(root, { attributes: true, subtree: true, childList: true });
  });
  const result = await settled;
  mounted.destroy();
  sources.destroy();
  return { ...result, requested };
}

test("a source named widget-imports is an ordinary source an executable view never loads", async () => {
  const declarationUrl = imageAssetUrl(PAGE, declarationId);
  const moduleUrl = imageAssetUrl(PAGE, moduleId);
  for (const catalog of [null, "a".repeat(64)]) {
    const view = viewRecord(catalog);
    assert.equal(view.catalog_revision, catalog ?? undefined);
    const mounted = await mountView(view);
    assert.equal(mounted.failed, undefined, mounted.failed);
    assert.deepEqual(mounted.requested, [imageAssetUrl(PAGE, entryId)]);
    assert.ok(!mounted.requested.includes(declarationUrl));
    assert.ok(!mounted.requested.includes(moduleUrl));
    assert.equal(mounted.payload.imports, undefined);
    assert.equal(new URL(mounted.frameUrl).searchParams.get("catalog"), catalog);
  }

  const view = viewRecord("a".repeat(64));
  const panel = projectSourcesPanel(
    sourcesDoc,
    { unreadableBlocks: 0, placements: [{ key: "v:0", kind: "view", viewId: "daily" }] },
    { daily: { status: "ready", view } },
  );
  const listed = panel.sources.find((source) => source.source_id === "widget-imports");
  assert.equal(listed.name, "Imports");
  assert.equal(listed.media_type, "application/octet-stream");
  assert.deepEqual(listed.uses, []);
  assert.ok(panel.sources.every((source) => source.uses.every((use) => use.role !== "catalog")));
  assert.deepEqual(
    panel.libraryPins.map((pin) => pin.digest),
    ["a".repeat(64)],
  );
  const line = sourceLine(
    {
      "widget-imports": {
        source_id: "widget-imports",
        name: "Imports",
        revision: "1",
        set_at: new Date().toISOString(),
        media_type: "application/octet-stream",
        asset_id: declarationId,
      },
    },
    Date.now(),
  );
  assert.deepEqual(
    line.entries.map((entry) => entry.id),
    ["widget-imports"],
  );
});
