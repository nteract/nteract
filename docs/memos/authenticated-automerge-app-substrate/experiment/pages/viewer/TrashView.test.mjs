// Trash mounted in jsdom, with list_pages and purge_page answered by a fake
// tool, and the local catalog in fake IndexedDB.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createPageData, initializePage } from "../model/page.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  listLocalPages,
  listLocalRecoveries,
  readLocalPage,
  writeLocalPage,
} from "./local-pages.mjs";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "http://localhost/trash",
  pretendToBeVisual: true,
});
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  location: dom.window.location,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./TrashView.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { TrashView } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const click = (element) =>
  act(() => {
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
const button = (host, name, within = host) =>
  [...within.querySelectorAll("button")].find((node) => node.textContent.trim() === name);

test("a permanent deletion from Trash moves this browser's copy to the recovery archive", async () => {
  const identity = { principal: crypto.randomUUID() };
  const pageId = crypto.randomUUID();
  const doc = A.change(A.from(createPageData({ pageId, title: "Trashed plans" })), (d) =>
    initializePage(d, "Only this browser still holds this sentence."),
  );
  await writeLocalPage(identity, {
    principal: identity.principal,
    page_id: pageId,
    title: doc.title,
    snapshot: encodeSnapshot(A.save(doc)),
    registered: true,
    pending: false,
  });
  let trashed = [{ page_id: pageId, title: "Trashed plans", trashed_at: new Date().toISOString() }];
  const calls = [];
  const tool = async (name, args = {}) => {
    calls.push([name, args.action]);
    if (name === "list_pages")
      return args.in_trash ? { pages: trashed, next_cursor: null } : { retry_token: "token" };
    if (name === "purge_page" && args.action === "preview")
      return {
        page_id: pageId,
        title: "Trashed plans",
        preview_token: "preview",
        comment_count: 0,
        collaborators: [],
        invitations: [],
      };
    if (name === "purge_page" && args.action === "confirm") {
      trashed = [];
      return { applied: true };
    }
    throw Error(`unexpected ${name}`);
  };
  const purged = [];
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(() =>
    root.render(
      createElement(TrashView, {
        tool,
        principal: identity.principal,
        identity,
        onOpen: () => {},
        onRestored: () => {},
        onPurged: async (id) => {
          // The archive is written before the app hears about the purge.
          purged.push([id, (await listLocalRecoveries(identity, id)).length]);
        },
        onBack: () => {},
      }),
    ),
  );
  await settle();
  await click(button(host, "Delete permanently"));
  await settle();
  const dialog = host.querySelector('[role="alertdialog"]');
  assert.ok(dialog, "the confirmation shows");
  await click(button(host, "Delete permanently", dialog));
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(
    calls.filter(([name]) => name === "purge_page"),
    [
      ["purge_page", "preview"],
      ["purge_page", "confirm"],
    ],
  );
  assert.deepEqual(purged, [[pageId, 1]]);
  assert.equal(host.querySelector('[role="alert"]'), null, "no error");
  // The checkpoint is a recovery record now; a deletion marker holds its key.
  const marker = await readLocalPage(identity, pageId, { markers: true });
  assert.equal(marker.deleted, true);
  assert.equal(marker.snapshot, undefined);
  assert.equal(await readLocalPage(identity, pageId), null);
  assert.deepEqual(await listLocalPages(identity), []);
  const [record] = await listLocalRecoveries(identity, pageId);
  assert.equal(record.retired, "deleted");
  const archived = A.load(decodeSnapshot(record.snapshot));
  assert.equal(archived.title, "Trashed plans");
  assert.match(JSON.stringify(archived), /Only this browser still holds this sentence\./);
  await act(() => root.unmount());
});
