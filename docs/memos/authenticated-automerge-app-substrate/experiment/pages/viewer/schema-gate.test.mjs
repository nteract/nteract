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
import "fake-indexeddb/auto";
import { VirtualTimeScheduler } from "rxjs";
import { PageSession, pageSyncAddress } from "./session.mjs";
import { SessionHost } from "./session-host.mjs";
import { ReloadGate } from "./build-freshness.mjs";
import { SAVE_TIMEOUT, SCHEMA_CHECKPOINT_FAILED } from "./reload-gate-machine.mjs";
import { decodeSnapshot, readLocalPage } from "./local-pages.mjs";

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

/** A session whose receipt the host refused for an unsupported feature,
 * owned by a SessionHost the reload gate follows. */
async function refusedForReload(t, persistLocal) {
  const { session: s } = session(t, unstamped(), { buildFeatures: [] });
  s.identity = { principal: "dev" };
  s.repo = { flush: async () => {} };
  s.connection = { documentId: "doc" };
  s.localPage = { pending: true };
  s.persistLocal = persistLocal;
  s.requestWithRenewal = async () => {
    throw Object.assign(Error("refused"), { status: 409, code: "schema_unsupported" });
  };
  s.scheduleReceiptRetry = () => assert.fail("a schema refusal never retries");
  await s.saveReceipt();
  assert.equal(s.schemaHold, "refused");
  const host = new SessionHost();
  const gate = new ReloadGate({ scheduler: new VirtualTimeScheduler() });
  gate.watch(host);
  host.install(s, host.generation, "dev");
  return { session: s, gate };
}

test("a schema refusal checkpoints the edits locally, then the notice's Reload goes ahead", async (t) => {
  let writes = 0;
  const { session: s, gate } = await refusedForReload(t, async (patch) => {
    assert.equal(patch.pending, true);
    writes++;
  });
  writes = 0;
  let reloaded = false;
  const result = await gate.reload({ reload: () => (reloaded = true), acceptCheckpoints: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(reloaded, true);
  assert.equal(writes, 1, "the reload wrote one checkpoint");
  assert.equal(s.schemaHold, "written");
});

test("a failed schema checkpoint blocks the reload and keeps the edits", async (t) => {
  let fail = false;
  const { session: s, gate } = await refusedForReload(t, async () => {
    if (fail) throw Error("QuotaExceededError");
  });
  fail = true;
  let reloaded = false;
  const result = await gate.reload({ reload: () => (reloaded = true), acceptCheckpoints: true });
  assert.deepEqual(result, { ok: false, message: SCHEMA_CHECKPOINT_FAILED });
  assert.equal(reloaded, false);
  assert.equal(s.schemaHold, "failed");
  assert.equal(s.recoveryPending, true, "the edits stay pending in this tab");
  assert.equal(s.canWrite, false);
  // The next Reload writes again.
  fail = false;
  assert.deepEqual(
    await gate.reload({ reload: () => (reloaded = true), acceptCheckpoints: true }),
    { ok: true },
  );
  assert.equal(reloaded, true);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** The build banner's Reload starts while a receipt is in flight; the host
 * then refuses it for an unsupported feature. `checkpoint` is the local
 * write the reload asks for afterwards. Time is virtual: the reload timeout
 * fires only when the test flushes the scheduler. */
async function refusedDuringReload(t, checkpoint, { acceptCheckpoints = false } = {}) {
  const { session: s } = session(t, unstamped(), { buildFeatures: [] });
  s.identity = { principal: "dev" };
  s.repo = { flush: async () => {} };
  s.connection = { documentId: "doc" };
  s.localPage = { pending: true };
  let writes = 0;
  // The receipt's own pending write succeeds; later writes are the checkpoint.
  s.persistLocal = (patch) => (writes++ === 0 ? Promise.resolve() : checkpoint(patch));
  const receipt = deferred();
  s.requestWithRenewal = () => receipt.promise;
  s.queueSaved = () => {};
  s.scheduleReceiptRetry = () => assert.fail("a schema refusal never retries");
  const saving = s.saveReceipt();
  await new Promise((resolve) => setImmediate(resolve));
  const host = new SessionHost();
  const scheduler = new VirtualTimeScheduler();
  const gate = new ReloadGate({ scheduler });
  gate.watch(host);
  host.install(s, host.generation, "dev");
  const reloads = [];
  const outcome = gate.reload({ reload: () => reloads.push("reload"), acceptCheckpoints });
  assert.equal(gate.store.snapshot().name, "waiting");
  assert.equal(s.schemaHold, undefined, "still waiting on the receipt");
  receipt.reject(Object.assign(Error("refused"), { status: 409, code: "schema_unsupported" }));
  await saving;
  return { session: s, gate, scheduler, outcome, reloads };
}

test("reload, then refusal, then checkpoint written: the attempt settles without its timeout", async (t) => {
  const {
    session: s,
    gate,
    scheduler,
    outcome,
    reloads,
  } = await refusedDuringReload(t, async () => {});
  const result = await outcome;
  assert.equal(s.schemaHold, "written");
  // The banner's Reload didn't accept checkpoints: it lists the Page.
  assert.equal(result.ok, false);
  assert.equal(result.reason, "checkpointed");
  assert.deepEqual(
    result.pages.map((page) => page.key),
    ["dev:page_fixture"],
  );
  assert.equal(scheduler.actions.length, 0, "the timeout was cancelled, never fired");
  assert.deepEqual(reloads, []);
  // Reload anyway, or the schema notice's Reload, goes ahead.
  assert.deepEqual(
    await gate.reload({ reload: () => reloads.push("reload"), acceptCheckpoints: true }),
    {
      ok: true,
    },
  );
  assert.deepEqual(reloads, ["reload"]);
});

test("reload accepting checkpoints, then refusal, then checkpoint written: reloads", async (t) => {
  const { outcome, reloads } = await refusedDuringReload(t, async () => {}, {
    acceptCheckpoints: true,
  });
  assert.deepEqual(await outcome, { ok: true });
  assert.deepEqual(reloads, ["reload"]);
});

test("reload, then refusal, then checkpoint failed: blocked, edits kept", async (t) => {
  const {
    session: s,
    outcome,
    reloads,
  } = await refusedDuringReload(t, async () => {
    throw Error("QuotaExceededError");
  });
  assert.deepEqual(await outcome, { ok: false, message: SCHEMA_CHECKPOINT_FAILED });
  assert.equal(s.schemaHold, "failed");
  assert.equal(s.recoveryPending, true);
  assert.equal(s.canWrite, false);
  assert.deepEqual(reloads, []);
});

test("reload, then refusal, then a checkpoint slower than the timeout: blocked; the next Reload succeeds", async (t) => {
  const slow = deferred();
  const {
    session: s,
    gate,
    scheduler,
    outcome,
    reloads,
  } = await refusedDuringReload(t, () => slow.promise);
  assert.equal(s.schemaHold, "writing");
  scheduler.flush();
  assert.deepEqual(await outcome, { ok: false, message: SAVE_TIMEOUT });
  assert.deepEqual(reloads, []);
  slow.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.schemaHold, "written");
  assert.deepEqual(
    await gate.reload({ reload: () => reloads.push("reload"), acceptCheckpoints: true }),
    {
      ok: true,
    },
  );
  assert.deepEqual(reloads, ["reload"]);
});

test("the schema checkpoint's IndexedDB transaction commits before the session reports written", async (t) => {
  const { session: s, doc } = session(t, unstamped(), { buildFeatures: [] });
  const identity = { principal: "account:schema-idb" };
  s.identity = identity;
  s.repo = { flush: async () => {} };
  s.localPage = {
    principal: identity.principal,
    page_id: "page_fixture",
    document_id: "doc-schema-idb",
    pending: true,
  };
  s.stepSchema({ type: "refused" });
  const order = [];
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const opened = transaction.apply(this, args);
    if (args[1] === "readwrite") opened.addEventListener("complete", () => order.push("committed"));
    return opened;
  };
  t.after(() => {
    IDBDatabase.prototype.transaction = transaction;
  });
  s.subscribe(() => {
    if (s.schemaHold === "written") order.push("written");
  });
  await s.checkpointForSchema();
  assert.equal(s.schemaHold, "written");
  assert.deepEqual(order.slice(-2), ["committed", "written"]);
  assert.equal(order.indexOf("written"), order.length - 1);
  const stored = await readLocalPage(identity, "page_fixture");
  assert.equal(stored.pending, true);
  const restored = A.load(decodeSnapshot(stored.snapshot));
  assert.deepEqual(A.getHeads(restored), A.getHeads(doc()));
});
