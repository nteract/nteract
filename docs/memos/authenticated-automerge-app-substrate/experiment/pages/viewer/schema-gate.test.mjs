import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import { createPageData, initializePage } from "../model/page.mjs";
import { PageSession, pageSyncAddress } from "./session.mjs";

const owner = {
  role: "owner",
  generation: 0,
  revision: 0,
  canRead: true,
  canWrite: true,
  canComment: true,
  canManageAccess: true,
  canDelete: true,
};
const unstamped = () =>
  A.change(A.from(createPageData({ pageId: "page_fixture", title: "Plan" })), (draft) =>
    initializePage(draft, "We ship on Friday."),
  );
const stamp = (doc, features) =>
  A.change(doc, (draft) => {
    draft.schema = { features };
  });

/** An open writer session over `doc`, with receipts stubbed out. */
function session(t, doc, options) {
  const value = new PageSession("page_fixture", options);
  let current = doc;
  value.credentialCanWrite = true;
  value.access = owner;
  value.handle = {
    doc: () => current,
    change(fn) {
      current = A.change(current, fn);
      return Promise.resolve();
    },
  };
  value.queueSaved = () => {};
  value.observeSchema();
  value.updateCapabilities();
  const receive = (next) => {
    const before = current;
    current = next;
    value.receiveChange({
      doc: next,
      patches: A.diff(next, A.getHeads(before), A.getHeads(next)),
      patchInfo: { before, after: next },
    });
  };
  t.after(() => clearTimeout(value.savedTimer));
  return { session: value, receive, doc: () => current };
}

test("an unstamped Page is editable", (t) => {
  const { session: s } = session(t, unstamped(), { buildFeatures: [] });
  assert.deepEqual(s.schemaGate, { editable: true, unsupported: [], refused: false });
  assert.equal(s.canWrite, true);
  assert.equal(s.canComment, true);
  assert.doesNotThrow(() => s.change((draft) => A.updateText(draft, ["title"], "Renamed")));
});

test("a Page stamped with a feature this build has stays editable", (t) => {
  const { session: s } = session(t, stamp(unstamped(), ["known"]), { buildFeatures: ["known"] });
  assert.equal(s.schemaGate.editable, true);
  assert.equal(s.canWrite, true);
});

test("a Page opened with an unknown feature is read-only", (t) => {
  const { session: s } = session(t, stamp(unstamped(), ["known", "future"]), {
    buildFeatures: ["known"],
  });
  assert.deepEqual(s.schemaGate, { editable: false, unsupported: ["future"], refused: false });
  assert.equal(s.canWrite, false);
  assert.equal(s.canComment, false);
  // Access and Trash are host actions, not document writes.
  assert.equal(s.canManageAccess, true);
  assert.equal(s.canDelete, true);
  assert.throws(() => s.change(() => {}), /read only/);
  assert.throws(
    () => s.comment({ action: "add", block_id: Object.keys(s.doc.blocks)[0], body: "Hi" }),
    /read only/,
  );
});

test("a remote change that adds an unknown feature makes the open Page read-only before observers run", (t) => {
  const { session: s, receive, doc } = session(t, unstamped(), { buildFeatures: [] });
  assert.equal(s.canWrite, true);
  const seen = [];
  s.observeChange(() => seen.push(s.canWrite));
  let emitted = 0;
  s.subscribe(() => emitted++);
  receive(stamp(doc(), ["future"]));
  assert.deepEqual(seen, [false], "the editor sees read-only with the change");
  assert.ok(emitted > 0);
  assert.equal(s.schemaGate.editable, false);
  assert.equal(s.canWrite, false);
  const heads = A.getHeads(doc());
  assert.throws(() => s.change((draft) => A.updateText(draft, ["title"], "No")), /read only/);
  assert.deepEqual(A.getHeads(doc()), heads, "no local write reaches the document");
  // Later capability updates keep it read-only; edits stay held until reload.
  s.updateCapabilities();
  assert.equal(s.canWrite, false);
  receive(A.change(doc(), (draft) => A.updateText(draft, ["title"], "Peer rename")));
  assert.equal(s.canWrite, false);
  assert.equal(s.doc.title, "Peer rename", "sync continues");
});

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./SchemaNotice.jsx", import.meta.url))],
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
const { SchemaNotice, SCHEMA_UNSUPPORTED } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);

test("the notice shows only while the schema gate holds the Page", () => {
  const render = (gate) =>
    JSDOM.fragment(renderToStaticMarkup(createElement(SchemaNotice, { gate, reload() {} })));
  assert.equal(render({ editable: true, unsupported: [] }).childNodes.length, 0);
  assert.equal(render(undefined).childNodes.length, 0);
  const notice = render({ editable: false, unsupported: ["future"] }).querySelector(
    '[role="alert"]',
  );
  assert.equal(notice.querySelector("p").textContent, SCHEMA_UNSUPPORTED);
  assert.equal(
    SCHEMA_UNSUPPORTED,
    "This Page uses features this version doesn't support. Reload to update.",
  );
  assert.match(notice.querySelector("button").textContent, /Reload/);
});

test("the sync address declares this build's features; none means the baseline", () => {
  const plain = pageSyncAddress("p", "http://localhost:9894/", null);
  assert.equal(plain.searchParams.has("schema_features"), false);
  const declared = pageSyncAddress("p", "http://localhost:9894/", null, ["b", "a"]);
  assert.equal(declared.searchParams.get("schema_features"), "a,b");
});

test("a receipt refused for an unsupported feature makes the Page read-only without retrying", async (t) => {
  const { session: s } = session(t, unstamped(), { buildFeatures: [] });
  s.repo = { flush: async () => {} };
  s.persistLocal = async () => {};
  s.connection = { documentId: "doc" };
  let sent;
  s.requestWithRenewal = async (_url, request) => {
    sent = JSON.parse(request.body);
    throw Object.assign(
      Error("This Page uses features this version doesn't support. Reload to update."),
      {
        status: 409,
        code: "schema_unsupported",
      },
    );
  };
  let retries = 0;
  s.scheduleReceiptRetry = () => retries++;
  await s.saveReceipt();
  assert.deepEqual(sent.schema_features, []);
  assert.deepEqual(s.schemaGate, { editable: false, unsupported: [], refused: true });
  assert.equal(s.canWrite, false);
  assert.equal(retries, 0);
  assert.notEqual(
    s.problem,
    "This Page uses features this version doesn't support. Reload to update.",
  );
});

test("every local change repairs an incomplete stamp in the same change", (t) => {
  const base = unstamped();
  const left = stamp(A.clone(base), ["alpha"]);
  const right = stamp(A.clone(base), ["beta"]);
  const { session: s, doc } = session(t, A.merge(left, right), {
    buildFeatures: ["alpha", "beta"],
  });
  assert.equal(doc().schema.features.length, 1);
  s.change((draft) => A.updateText(draft, ["title"], "Renamed"));
  assert.deepEqual([...doc().schema.features], ["alpha", "beta"]);
});
