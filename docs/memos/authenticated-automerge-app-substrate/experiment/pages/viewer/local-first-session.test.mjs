import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  DRAFT_FORM_UNSUPPORTED,
  PageSession,
  STORAGE_ADOPTED,
  STORAGE_REFUSED_AGAIN,
  STORAGE_SWITCHING,
  STORAGE_SWITCH_FAILED,
  connectionFailureRetries,
  listLocalPages,
  retireLocalPage,
} from "./session.mjs";
import { readLocalPage, decodeSnapshot, writeLocalPage, encodeSnapshot } from "./local-pages.mjs";
import { store as localCatalog } from "./local-catalog.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { readRegistration } from "../worker/registration.mjs";
import { retryKey, retryKeyPrefix } from "../model/retry-key.mjs";

function browser(t) {
  const values = new Map();
  const locks = new Set();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(key, _options, callback) {
          if (locks.has(key)) return callback(null);
          locks.add(key);
          try {
            return await callback({ name: key });
          } finally {
            locks.delete(key);
          }
        },
      },
    },
  });
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
    delete globalThis.sessionStorage;
  });
}
const authentication = () => ({
  identity: { principal: crypto.randomUUID(), displayName: "Kyle", driver: "Browser" },
  canWrite: true,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settleConnection(session) {
  await session.connecting;
  await tick();
  clearTimeout(session.retryTimer);
}

test("new Pages are editable and durable without any completed network operation", async (t) => {
  browser(t);
  const auth = authentication();
  let finishRefresh;
  const refresh = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("Network must not run before authentication");
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const session = await PageSession.create(
    { title: "Local first" },
    { authentication: auth, refreshSession: () => refresh },
  );
  t.after(() => session.close());
  assert.equal(calls, 0);
  assert.equal(session.status, "Saved locally");
  assert.equal(session.statusRetry, true);
  assert.equal(session.snapshot().title, "Local first");
  assert.equal(documentIdToBinary(session.localPage.registration.document_id).byteLength, 32);
  assert.equal(session.localPage.registration.expected_principal, auth.identity.principal);
  const bootstrap = readRegistration(session.localPage.registration);
  assert.equal(bootstrap.doc.page_id, session.pageId);
  assert.equal(bootstrap.doc.title, "Local first");
  assert.deepEqual(A.getHeads(bootstrap.doc), A.getHeads(session.doc));
  A.free(bootstrap.doc);
  await session.change((doc) => A.updateText(doc, ["title"], "Written offline"));
  clearTimeout(session.savedTimer);
  await session.saveReceipt();
  assert.equal(session.status, "Saved locally");
  assert.equal(session.savedHeads.length, 0);
  const local = await readLocalPage(auth.identity, session.pageId);
  assert.equal(A.load(decodeSnapshot(local.snapshot)).title, "Written offline");
  assert.equal(
    local.registration.title,
    "Local first",
    "registration bytes and title are immutable",
  );
  assert.equal(local.registered, false);
  assert.equal(local.pending, true);
  assert.deepEqual(
    (await listLocalPages(auth.identity, { pendingOnly: true })).map((page) => page.page_id),
    [session.pageId],
  );
  assert.deepEqual(await listLocalPages(authentication().identity), []);
  await session.close();
  finishRefresh(auth);
  await settleConnection(session);
});

test("a pending Page survives reload and retries the exact original registration after local edits", async (t) => {
  browser(t);
  const auth = authentication();
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === "/api/tools") return Response.json({ retry_token: "fixture-retry-token" });
    if (url === "/api/pages/register") {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1)
        return Response.json({ error: "Temporary persistence failure" }, { status: 503 });
      return Response.json({
        page_id: requests.at(-1).page_id,
        document_id: requests.at(-1).document_id,
      });
    }
    if (url.startsWith("/api/connect")) throw Error("Offline after registration");
    throw Error(`Unexpected request: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const first = await PageSession.create(
    { title: "Original title" },
    { authentication: auth, refreshSession: async () => auth },
  );
  await first.connecting.catch(() => {});
  await tick();
  clearTimeout(first.retryTimer);
  await first.change((doc) => A.updateText(doc, ["title"], "Typed while offline"));
  const pageId = first.pageId;
  const documentId = first.handle.documentId;
  await first.close();
  const restored = await PageSession.open(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => restored.close());
  assert.equal(restored.snapshot().title, "Typed while offline");
  assert.equal(restored.handle.documentId, documentId);
  await restored.connecting.catch(() => {});
  await tick();
  clearTimeout(restored.retryTimer);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].retry_token, "fixture-retry-token");
  assert.equal(restored.localPage.registered, true);
  assert.equal(restored.localPage.pending, true);
  assert.notEqual(restored.status, "Saved", "registration is not a receipt for later edits");
  assert.equal(A.load(decodeSnapshot(requests[0].initial_snapshot_base64)).title, "Original title");
});

async function expiredRegistrationFixture(t) {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication();
  const session = await PageSession.create(
    { title: "Original bootstrap" },
    { authentication: auth, refreshSession: async () => auth },
  );
  t.after(() => session.close());
  await session.persistLocal({
    registration: {
      ...session.localPage.registration,
      retry_token: "expired-registration-token",
      idempotency_key: await retryKey("expired-registration-token"),
    },
  });
  await session.change((doc) => A.updateText(doc, ["title"], "Kept offline edits"));
  clearTimeout(session.savedTimer);
  await session.persistLocal({ pending: true });
  return { auth, session, original: structuredClone(session.localPage.registration) };
}
const expiredRegistration = () =>
  Response.json({ error: "Retry window expired", code: "retry_expired" }, { status: 410 });
const connectionFor = (session, auth) => ({
  page_id: session.pageId,
  documentId: session.localPage.document_id,
  identity: auth.identity,
  access: { canRead: true },
});

test("an expired lost registration response reconciles the same authorized document", async (t) => {
  const { auth, session, original } = await expiredRegistrationFixture(t);
  const heads = A.getHeads(session.doc);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url);
    if (url === "/api/pages/register") {
      assert.deepEqual(JSON.parse(options.body), original);
      return expiredRegistration();
    }
    assert.equal(url, `/api/connect?page=${session.pageId}&sync=automerge`);
    return Response.json(connectionFor(session, auth));
  });
  await session.registerDraft();
  assert.deepEqual(requests, [
    "/api/pages/register",
    `/api/connect?page=${session.pageId}&sync=automerge`,
  ]);
  assert.equal(session.localPage.registered, true);
  assert.equal(session.localPage.pending, true, "reconciliation is not a receipt for local edits");
  assert.deepEqual(session.localPage.registration, original);
  assert.deepEqual(A.getHeads(session.doc), heads);
  assert.equal(session.doc.title, "Kept offline edits");
  const stored = await readLocalPage(auth.identity, session.pageId);
  assert.equal(stored.registered, true);
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Kept offline edits");
});

test("an expired never-registered draft renews only retry authority after an authenticated absence", async (t) => {
  const { auth, session, original } = await expiredRegistrationFixture(t);
  const heads = A.getHeads(session.doc);
  const registrations = [];
  let probes = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/pages/register") {
      const input = JSON.parse(options.body);
      registrations.push(input);
      if (registrations.length === 1) return expiredRegistration();
      const persisted = await readLocalPage(auth.identity, session.pageId);
      assert.deepEqual(persisted.registration, input, "persist replacement before publishing");
      return Response.json({ page_id: input.page_id, document_id: input.document_id });
    }
    if (url === "/api/tools") {
      assert.equal(probes, 1);
      assert.deepEqual(JSON.parse(options.body), { operation: "list_pages", arguments: {} });
      return Response.json({ retry_token: "replacement-token" });
    }
    assert.equal(url, `/api/connect?page=${session.pageId}&sync=automerge`);
    probes++;
    return Response.json(
      { error: "Page access denied", code: "page_access_denied" },
      { status: 403 },
    );
  });
  await session.registerDraft();
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[0], original);
  const replacement = registrations[1];
  assert.equal(replacement.retry_token, "replacement-token");
  assert.ok(replacement.idempotency_key.startsWith(await retryKeyPrefix(replacement.retry_token)));
  assert.notEqual(replacement.idempotency_key, original.idempotency_key);
  assert.deepEqual(
    {
      ...replacement,
      retry_token: original.retry_token,
      idempotency_key: original.idempotency_key,
    },
    original,
    "page ID, document ID, principal and original bootstrap remain identical",
  );
  assert.equal(session.localPage.registered, true);
  assert.equal(session.localPage.registrationSupersedes, undefined);
  assert.equal(session.localPage.pending, true);
  assert.deepEqual(A.getHeads(session.doc), heads);
  assert.equal(session.doc.title, "Kept offline edits");
});

test("an expired registration whose Page was deleted marks the draft deleted", async (t) => {
  const { session } = await expiredRegistrationFixture(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    if (url === "/api/pages/register") return expiredRegistration();
    return Response.json({ error: "Page was deleted", code: "page_deleted" }, { status: 404 });
  });
  await session.registerDraft();
  assert.deepEqual(requests, [
    "/api/pages/register",
    `/api/connect?page=${session.pageId}&sync=automerge`,
  ]);
  assert.equal(session.deleted, true);
});

test("a renewed registration refused as deleted marks the draft deleted", async (t) => {
  const { session } = await expiredRegistrationFixture(t);
  let registrations = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "/api/pages/register")
      return ++registrations === 1
        ? expiredRegistration()
        : Response.json({ error: "Page was deleted" }, { status: 409 });
    if (url === "/api/tools") return Response.json({ retry_token: "replacement-token" });
    return Response.json(
      { error: "Page access denied", code: "page_access_denied" },
      { status: 403 },
    );
  });
  await assert.rejects(session.registerDraft(), /Page was deleted/);
  assert.equal(registrations, 2);
  assert.equal(session.deleted, true);
});

test("a draft the host can't read stops with a message, keeps its local copy and doesn't retry", async (t) => {
  const { session } = await expiredRegistrationFixture(t);
  const before = session.localPage;
  let registrations = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "/api/pages/register");
    registrations++;
    return Response.json(
      {
        error:
          "Pages can't read this draft Page, stored in a form from an earlier version of Pages.",
        code: "stored_form_unsupported",
      },
      { status: 409 },
    );
  });
  const error = await session.registerDraft().catch((error) => error);
  assert.equal(error.message, DRAFT_FORM_UNSUPPORTED);
  assert.equal(error.code, "stored_form_unsupported");
  assert.equal(registrations, 1);
  // The draft stays on the device, unregistered, for the person to copy out.
  assert.equal(session.deleted, false);
  assert.equal(session.localPage.registered, before.registered);
  assert.deepEqual(session.localPage.registration, before.registration);
  assert.equal(connectionFailureRetries(error), false);
});

/** A draft created where the session endpoint advertised plain storage, or
 * native storage with `recordStorage: "native"`. */
async function plainDraft(t, { recordStorage = "automerge" } = {}) {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication();
  const session = await PageSession.create(
    { title: "Plain draft" },
    {
      authentication: recordStorage === "automerge" ? { ...auth, recordStorage } : auth,
      refreshSession: async () => auth,
    },
  );
  t.after(() => session.close());
  return { auth, session };
}
const storageRefusal = () =>
  Response.json(
    { error: "This host doesn't accept plain Automerge Pages", code: "record_storage_unsupported" },
    { status: 409 },
  );
const databaseNames = async () => (await indexedDB.databases()).map(({ name }) => name);
/** A promise and the function that settles it. */
function gate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

test("a plain draft the host refuses moves to native storage and registers again", async (t) => {
  // The session endpoint advertised plain storage; the host's flag went off
  // before registration.
  const { auth, session } = await plainDraft(t);
  assert.equal(session.recordStorage, "automerge");
  assert.equal(session.localPage.registration.record_storage, "automerge");
  await session.change((doc) => A.updateText(doc, ["title"], "Typed before the refusal"));
  clearTimeout(session.savedTimer);
  const documentId = session.handle.documentId;
  const heads = A.getHeads(session.doc);
  const original = structuredClone(session.localPage.registration);
  const registrations = [];
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/tools") return Response.json({ retry_token: `token-${++tokens}` });
    assert.equal(url, "/api/pages/register");
    const input = JSON.parse(options.body);
    registrations.push(input);
    if (input.record_storage === "automerge") return storageRefusal();
    return Response.json({ page_id: input.page_id, document_id: input.document_id });
  });
  const plainDatabase = session.databaseName;
  await session.registerDraft();
  assert.equal(registrations.length, 2);
  const [refused, accepted] = registrations;
  assert.equal(refused.record_storage, "automerge");
  assert.equal(refused.retry_token, "token-1");
  assert.equal("record_storage" in accepted, false);
  assert.equal(accepted.retry_token, "token-2");
  assert.ok(accepted.idempotency_key.startsWith(await retryKeyPrefix("token-2")));
  assert.notEqual(accepted.idempotency_key, refused.idempotency_key);
  // Same Page, document and immutable bootstrap.
  for (const field of ["page_id", "document_id", "expected_principal", "title"])
    assert.equal(accepted[field], original[field], field);
  assert.equal(accepted.initial_snapshot_base64, original.initial_snapshot_base64);
  // The live replica is native now, under the same document ID, with the edit.
  assert.equal(session.recordStorage, "native");
  assert.equal(session.handle.documentId, documentId);
  assert.deepEqual(A.getHeads(session.doc), heads);
  assert.equal(session.doc.title, "Typed before the refusal");
  assert.equal(session.localPage.registered, true);
  assert.equal(session.localPage.recordStorage, undefined);
  assert.equal(session.storageSwitch$.snapshot().name, "idle");
  assert.equal(session.canWrite, true, "edits resume after the move");
  await tick();
  assert.equal((await databaseNames()).includes(plainDatabase), false, "the plain replica is gone");
  const stored = await readLocalPage(auth.identity, session.pageId);
  assert.equal(stored.recordStorage, undefined);
  assert.equal(stored.registered, true);
  assert.equal(stored.pending, true, "registration is not a receipt for the edit");
  assert.deepEqual(stored.registration, accepted);
  // This session's edits after the move still count as its own.
  assert.ok(stored.localEdits.actors.some(({ actor }) => actor === session.actor()));
  await session.change((doc) => A.updateText(doc, ["title"], "Typed after the move"));
  clearTimeout(session.savedTimer);
  await session.persistLocal();
  await session.close();
  const reopened = await PageSession.open(session.pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.recordStorage, "native");
  assert.equal(reopened.handle.documentId, documentId);
  assert.equal(reopened.doc.title, "Typed after the move");
});

test("edits during the move are refused cleanly, and an edit made before it is kept", async (t) => {
  const { auth, session } = await plainDraft(t);
  const plainDatabase = session.databaseName;
  const documents = [];
  session.subscribe(() => documents.push(session.doc));
  const registrations = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/tools")
      return Response.json({ retry_token: `token-${registrations.length}` });
    const input = JSON.parse(options.body);
    registrations.push(input);
    if (input.record_storage !== "automerge")
      return Response.json({ page_id: input.page_id, document_id: input.document_id });
    // Committed as the refusal arrives, before anything pauses.
    await session.change((doc) => A.updateText(doc, ["title"], "Typed as the refusal arrived"));
    return storageRefusal();
  });
  // Hold each step of the move, and try to edit inside it.
  const persist = session.persistLocal.bind(session);
  const openBackend = session.openBackend.bind(session);
  const attempts = [];
  const tryEdit = async (step) => {
    assert.equal(session.storageSwitch$.snapshot().name, step);
    assert.equal(session.canWrite, false, step);
    assert.equal(session.doc.title, "Typed as the refusal arrived", step);
    try {
      session.change((doc) => A.updateText(doc, ["title"], "Lost?"));
      attempts.push([step, "accepted"]);
    } catch (error) {
      attempts.push([step, error.constructor.name, error.message]);
    }
    await tick();
  };
  t.mock.method(session, "persistLocal", async (value, options) => {
    const step = session.storageSwitch$.snapshot().name;
    if (step === "checkpointing") await tryEdit(step);
    if (step === "recording") {
      await tryEdit(step);
      // The plain replica stays until the record names the native one.
      assert.ok((await databaseNames()).includes(plainDatabase));
    }
    return persist(value, options);
  });
  t.mock.method(session, "openBackend", async () => {
    await tryEdit("moving");
    return openBackend();
  });
  await session.registerDraft();
  assert.deepEqual(attempts, [
    ["checkpointing", "Error", STORAGE_SWITCHING],
    ["moving", "Error", STORAGE_SWITCHING],
    ["recording", "Error", STORAGE_SWITCHING],
  ]);
  assert.ok(documents.length > 0);
  assert.ok(
    documents.every((doc) => doc?.title === "Typed as the refusal arrived"),
    "every render during the move has the Page",
  );
  assert.equal(registrations.length, 2);
  assert.equal(session.recordStorage, "native");
  assert.equal(session.doc.title, "Typed as the refusal arrived");
  const stored = await readLocalPage(auth.identity, session.pageId);
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Typed as the refusal arrived");
  await session.change((doc) => A.updateText(doc, ["title"], "Typed after the move"));
  assert.equal(session.doc.title, "Typed after the move");
});

test("a session closed during the move stops, and its plain draft reopens intact", async (t) => {
  for (const step of ["checkpointing", "moving"]) {
    await t.test(step, async (t) => {
      const { auth, session } = await plainDraft(t);
      await session.change((doc) => A.updateText(doc, ["title"], "Kept through the close"));
      clearTimeout(session.savedTimer);
      const plainDatabase = session.databaseName;
      const original = structuredClone(session.localPage.registration);
      const registrations = [];
      t.mock.method(globalThis, "fetch", async (url, options) => {
        if (url === "/api/tools") return Response.json({ retry_token: "token" });
        registrations.push(JSON.parse(options.body));
        return storageRefusal();
      });
      const reached = gate();
      const release = gate();
      const hold = async () => {
        reached.open();
        await release.opened;
      };
      if (step === "checkpointing") {
        const persist = session.persistLocal.bind(session);
        let held = false;
        t.mock.method(session, "persistLocal", async (value, options) => {
          if (!held && session.storageSwitch$.snapshot().name === "checkpointing") {
            held = true;
            await hold();
          }
          return persist(value, options);
        });
      } else {
        const openBackend = session.openBackend.bind(session);
        t.mock.method(session, "openBackend", async () => {
          await hold();
          return openBackend();
        });
      }
      const registering = session.registerDraft();
      await reached.opened;
      const closing = session.close();
      release.open();
      await registering;
      await closing;
      assert.equal(session.storageSwitch$.snapshot().name, "closed");
      assert.equal(registrations.length, 1, "the plain registration isn't sent again");
      assert.ok((await databaseNames()).includes(plainDatabase), "the plain replica is kept");
      const stored = await readLocalPage(auth.identity, session.pageId);
      assert.equal(stored.recordStorage, "automerge");
      assert.equal(stored.registered, false);
      assert.equal(stored.registration.record_storage, "automerge");
      assert.equal(stored.registration.document_id, original.document_id);
      const reopened = await PageSession.open(session.pageId, {
        authentication: auth,
        refreshSession: async () => auth,
      });
      t.after(() => reopened.close());
      assert.equal(reopened.recordStorage, "automerge");
      assert.equal(reopened.doc.title, "Kept through the close");
    });
  }
});

test("a move that fails to open native storage keeps edits paused and the plain draft intact", async (t) => {
  const { auth, session } = await plainDraft(t);
  await session.change((doc) => A.updateText(doc, ["title"], "Kept through the failure"));
  clearTimeout(session.savedTimer);
  t.mock.method(globalThis, "fetch", async (url) =>
    url === "/api/tools" ? Response.json({ retry_token: "token" }) : storageRefusal(),
  );
  t.mock.method(session, "openBackend", async () => {
    throw Error("simulated IndexedDB failure");
  });
  await assert.rejects(session.registerDraft(), { message: STORAGE_SWITCH_FAILED });
  assert.equal(session.storageSwitch$.snapshot().name, "failed");
  assert.equal(session.problem, STORAGE_SWITCH_FAILED);
  assert.equal(session.canWrite, false);
  assert.throws(() => session.change(() => {}), { message: STORAGE_SWITCH_FAILED });
  assert.equal(session.doc.title, "Kept through the failure");
  await session.close();
  const stored = await readLocalPage(auth.identity, session.pageId);
  assert.equal(stored.recordStorage, "automerge");
  const reopened = await PageSession.open(session.pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.recordStorage, "automerge");
  assert.equal(reopened.doc.title, "Kept through the failure");
});

test("a second refusal ends the attempt, and a native replica with a plain registration strips it", async (t) => {
  const { auth, session } = await plainDraft(t);
  const documentId = session.handle.documentId;
  const registrations = [];
  let prepares = 0;
  let staleTab;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/tools") {
      prepares++;
      // Another tab on the same draft, still plain, writes its checkpoint
      // back over this tab's move before this tab stores its new token.
      if (prepares === 2) await writeLocalPage(auth.identity, staleTab);
      return Response.json({ retry_token: `token-${prepares}` });
    }
    const input = JSON.parse(options.body);
    registrations.push(input);
    if (registrations.length === 1)
      staleTab = structuredClone(await readLocalPage(auth.identity, session.pageId));
    if (input.record_storage === "automerge") return storageRefusal();
    return Response.json({ page_id: input.page_id, document_id: input.document_id });
  });
  await assert.rejects(session.registerDraft(), { message: STORAGE_REFUSED_AGAIN });
  assert.deepEqual(
    registrations.map(({ record_storage, retry_token }) => [record_storage, retry_token]),
    [
      ["automerge", "token-1"],
      ["automerge", "token-1"],
    ],
    "the other tab's plain registration came back",
  );
  assert.equal(session.recordStorage, "native");
  assert.equal(session.localPage.registered, false);
  assert.equal(session.canWrite, true);
  // The next attempt finds a native replica: it drops record_storage and
  // prepares fresh authority instead of moving again.
  await session.registerDraft();
  assert.equal(registrations.length, 4);
  const accepted = registrations.at(-1);
  assert.equal("record_storage" in accepted, false);
  assert.equal(accepted.retry_token, "token-3");
  assert.equal(accepted.document_id, documentId);
  assert.equal(session.localPage.registered, true);
  const stored = await readLocalPage(auth.identity, session.pageId);
  assert.equal(stored.recordStorage, undefined);
  assert.equal(stored.registration.record_storage, undefined);
});

test("a stale plain tab can't write plain storage back over a draft another tab moved", async (t) => {
  const { auth, session } = await plainDraft(t);
  // The other tab's record, read while the draft was still plain.
  const staleTab = structuredClone(await readLocalPage(auth.identity, session.pageId));
  assert.equal(staleTab.recordStorage, "automerge");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/tools") return Response.json({ retry_token: "token" });
    const input = JSON.parse(options.body);
    if (input.record_storage === "automerge") return storageRefusal();
    return Response.json({ page_id: input.page_id, document_id: input.document_id });
  });
  await session.registerDraft();
  assert.equal(session.localPage.registered, true);
  // The stale tab checkpoints with an edit of its own.
  const edited = A.change(A.load(decodeSnapshot(staleTab.snapshot)), (doc) =>
    A.updateText(doc, ["title"], "Typed in the stale tab"),
  );
  const written = await writeLocalPage(auth.identity, {
    ...staleTab,
    snapshot: encodeSnapshot(A.save(edited)),
  });
  assert.equal(written.recordStorage, undefined, "the record keeps native storage");
  assert.equal(written.registered, true);
  assert.equal(written.registration.record_storage, undefined);
  assert.equal(A.load(decodeSnapshot(written.snapshot)).title, "Typed in the stale tab");
  // Only the host's discovery answer may name plain storage.
  const confirmed = await writeLocalPage(auth.identity, written, { storageFromHost: true });
  assert.equal(confirmed.recordStorage, undefined);
  const plain = await writeLocalPage(
    auth.identity,
    { ...written, recordStorage: "automerge" },
    { storageFromHost: true },
  );
  assert.equal(plain.recordStorage, "automerge");
});

test("discovery that names other storage than the open replica pauses edits, records it, and the reload opens it", async (t) => {
  for (const [local, host] of [
    ["automerge", "native"],
    ["native", "automerge"],
  ]) {
    await t.test(`${local} replica, ${host} Page`, async (t) => {
      const { auth, session } = await plainDraft(t, { recordStorage: local });
      const pageId = session.pageId;
      const documentId = session.handle.documentId;
      // A replica of a Page the host knows in the other storage: what a
      // stale tab's write-back used to leave behind.
      await session.persistLocal({ registered: true, pending: false });
      await session.close();
      const reopened = await PageSession.open(pageId, {
        authentication: auth,
        refreshSession: async () => auth,
      });
      t.after(() => reopened.close());
      assert.equal(reopened.recordStorage, local);
      // Typed inside the checkpoint debounce: only the adopt can save it.
      await reopened.change((doc) => A.updateText(doc, ["title"], "Typed before discovery"));
      clearTimeout(reopened.savedTimer);
      const requests = [];
      t.mock.method(globalThis, "fetch", async (url) => {
        requests.push(url);
        assert.equal(url, `/api/connect?page=${pageId}&sync=automerge`);
        return Response.json({
          page_id: pageId,
          documentId,
          identity: auth.identity,
          access: { canRead: true, canWrite: true, role: "owner" },
          ...(host === "automerge" && { recordStorage: "automerge" }),
        });
      });
      const changed = { code: "RECORD_STORAGE_CHANGED", status: 409, message: STORAGE_ADOPTED };
      await assert.rejects(reopened.connect(), changed);
      assert.equal(reopened.storageSwitch$.snapshot().name, "adopted");
      const stored = await readLocalPage(auth.identity, pageId);
      assert.equal(stored.recordStorage, host === "automerge" ? "automerge" : undefined);
      assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Typed before discovery");
      // Edits after the adopt are refused visibly: the reload opens the
      // other storage's replica, which only the recorded checkpoint reaches.
      assert.equal(reopened.canWrite, false);
      assert.throws(
        () => reopened.change((doc) => A.updateText(doc, ["title"], "Typed after the adopt")),
        { message: STORAGE_ADOPTED },
      );
      assert.equal(reopened.doc.title, "Typed before discovery");
      // A manual retry answers the same way without recording again.
      await assert.rejects(reopened.connect(), changed);
      assert.equal(requests.length, 2);
      await reopened.close();
      const reloaded = await PageSession.open(pageId, {
        authentication: auth,
        refreshSession: async () => auth,
      });
      t.after(() => reloaded.close());
      assert.equal(reloaded.recordStorage, host);
      assert.equal(reloaded.handle.documentId, documentId);
      assert.equal(reloaded.doc.title, "Typed before discovery");
      assert.equal(reloaded.canWrite, true);
      await reloaded.change((doc) => A.updateText(doc, ["title"], "Typed after the reload"));
      assert.equal(reloaded.doc.title, "Typed after the reload");
    });
  }
});

/** A reopened `local` replica of a Page the host knows in `host` storage,
 * with an edit inside the checkpoint debounce and discovery mocked. */
async function mismatchedReplica(t, { local = "automerge", host = "native" } = {}) {
  const { auth, session } = await plainDraft(t, { recordStorage: local });
  const pageId = session.pageId;
  const documentId = session.handle.documentId;
  await session.persistLocal({ registered: true, pending: false });
  await session.close();
  const reopened = await PageSession.open(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => reopened.close());
  await reopened.change((doc) => A.updateText(doc, ["title"], "Typed before discovery"));
  clearTimeout(reopened.savedTimer);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    assert.equal(url, `/api/connect?page=${pageId}&sync=automerge`);
    return Response.json({
      page_id: pageId,
      documentId,
      identity: auth.identity,
      access: { canRead: true, canWrite: true, role: "owner" },
      ...(host === "automerge" && { recordStorage: "automerge" }),
    });
  });
  return { auth, reopened, pageId, requests };
}
/** Fail the first local-record write made while adopting with `error`. */
function failAdoptWrite(t, session, error) {
  const run = localCatalog.run.bind(localCatalog);
  let failed = false;
  t.mock.method(localCatalog, "run", (mode, ...rest) => {
    if (!failed && mode === "readwrite" && session.storageSwitch$.snapshot().name === "adopting") {
      failed = true;
      return Promise.reject(error);
    }
    return run(mode, ...rest);
  });
}

test("a failed adopt write leaves the record and memory as they were, and the next attempt adopts", async (t) => {
  const { auth, reopened, pageId } = await mismatchedReplica(t);
  failAdoptWrite(t, reopened, Error("simulated IndexedDB failure"));
  await assert.rejects(reopened.connect(), { message: "simulated IndexedDB failure" });
  assert.equal(reopened.storageSwitch$.snapshot().name, "idle");
  assert.equal(reopened.localPage.recordStorage, "automerge", "memory keeps the stored mode");
  assert.equal(reopened.canWrite, true, "edits resume");
  // A routine debounced save must not write the host's mode unguarded.
  await reopened.change((doc) => A.updateText(doc, ["title"], "Typed after the failed adopt"));
  clearTimeout(reopened.savedTimer);
  await reopened.saveReceipt();
  let stored = await readLocalPage(auth.identity, pageId);
  assert.equal(stored.recordStorage, "automerge");
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Typed after the failed adopt");
  // The next attempt adopts, with that edit.
  await assert.rejects(reopened.connect(), { code: "RECORD_STORAGE_CHANGED", status: 409 });
  stored = await readLocalPage(auth.identity, pageId);
  assert.equal(stored.recordStorage, undefined);
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Typed after the failed adopt");
});

test("a local copy deleted during the adopt retires the tab without resuming edits", async (t) => {
  const { reopened, requests } = await mismatchedReplica(t);
  failAdoptWrite(
    t,
    reopened,
    Object.assign(Error("Page was deleted"), { code: "LOCAL_PAGE_DELETED", status: 410 }),
  );
  await assert.rejects(reopened.connect(), { code: "LOCAL_PAGE_DELETED" });
  assert.equal(reopened.storageSwitch$.snapshot().name, "closed");
  assert.equal(reopened.deleted, true);
  assert.equal(reopened.canWrite, false);
  assert.equal(requests.length, 1);
});

test("an adopt through the reconnect loop shows the reload notice and schedules no retry", async (t) => {
  const { reopened, requests } = await mismatchedReplica(t);
  PageSession.prototype.retryConnection.mock.restore();
  await reopened.retryConnection();
  assert.equal(reopened.storageSwitch$.snapshot().name, "adopted");
  assert.equal(reopened.problem, STORAGE_ADOPTED);
  assert.notEqual(reopened.reconnect$.snapshot().name, "waiting");
  assert.equal(reopened.retryTimer, undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.length, 1, "nothing reconnects after the 409");
});

test("a failed move stops re-sending the plain registration", async (t) => {
  const { session } = await plainDraft(t);
  const registrations = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/tools") return Response.json({ retry_token: "token" });
    registrations.push(JSON.parse(options.body));
    return storageRefusal();
  });
  t.mock.method(session, "openBackend", async () => {
    throw Error("simulated IndexedDB failure");
  });
  await assert.rejects(session.registerDraft(), { message: STORAGE_SWITCH_FAILED, status: 409 });
  await assert.rejects(session.registerDraft(), { message: STORAGE_SWITCH_FAILED, status: 409 });
  assert.equal(registrations.length, 1);
});

test("a storage refusal after an expired registration also moves the draft", async (t) => {
  const { auth, session } = await plainDraft(t);
  await session.persistLocal({
    registration: {
      ...session.localPage.registration,
      retry_token: "expired-registration-token",
      idempotency_key: await retryKey("expired-registration-token"),
    },
  });
  const registrations = [];
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/tools") return Response.json({ retry_token: `token-${++tokens}` });
    if (url.startsWith("/api/connect"))
      return Response.json(
        { error: "Page access denied", code: "page_access_denied" },
        { status: 403 },
      );
    const input = JSON.parse(options.body);
    registrations.push(input);
    if (registrations.length === 1) return expiredRegistration();
    if (input.record_storage === "automerge") return storageRefusal();
    return Response.json({ page_id: input.page_id, document_id: input.document_id });
  });
  await session.registerDraft();
  assert.deepEqual(
    registrations.map(({ record_storage, retry_token }) => [record_storage, retry_token]),
    [
      ["automerge", "expired-registration-token"],
      ["automerge", "token-1"],
      [undefined, "token-2"],
    ],
  );
  assert.equal(session.recordStorage, "native");
  assert.equal(session.localPage.registered, true);
  const stored = await readLocalPage(auth.identity, session.pageId);
  assert.equal(stored.recordStorage, undefined);
});

test("ambiguous or unauthorized expiry reconciliation preserves the draft and original request", async (t) => {
  for (const failure of [
    "offline",
    "unavailable",
    "forbidden",
    "unrelated-missing",
    "other-document",
    "other-account",
    "cannot-read",
  ]) {
    await t.test(failure, async (t) => {
      const { auth, session, original } = await expiredRegistrationFixture(t);
      const requests = [];
      t.mock.method(globalThis, "fetch", async (url) => {
        requests.push(url);
        if (url === "/api/pages/register") return expiredRegistration();
        assert.equal(url, `/api/connect?page=${session.pageId}&sync=automerge`);
        if (failure === "offline") throw new TypeError("Network unavailable");
        if (failure === "unavailable")
          return Response.json({ error: "Recovering registration" }, { status: 503 });
        if (failure === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
        if (failure === "unrelated-missing")
          return Response.json({ error: "Route not found" }, { status: 404 });
        const connection = connectionFor(session, auth);
        if (failure === "other-document")
          connection.documentId = interpretAsDocumentId(generateAutomergeUrl());
        if (failure === "other-account") connection.identity = authentication().identity;
        if (failure === "cannot-read") connection.access.canRead = false;
        return Response.json(connection);
      });
      await assert.rejects(session.registerDraft());
      assert.deepEqual(requests, [
        "/api/pages/register",
        `/api/connect?page=${session.pageId}&sync=automerge`,
      ]);
      assert.equal(session.localPage.registered, false);
      assert.deepEqual(session.localPage.registration, original);
      assert.equal(session.doc.title, "Kept offline edits");
      const stored = await readLocalPage(auth.identity, session.pageId);
      assert.equal(stored.registered, false);
      assert.deepEqual(stored.registration, original);
      assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Kept offline edits");
    });
  }
});

test("expiry reconciliation does not resume a closed or signed-out session", async (t) => {
  for (const phase of ["connect", "prepare", "register"]) {
    for (const invalidation of ["close", "account"]) {
      await t.test(`${phase}: ${invalidation}`, async (t) => {
        const { auth, session } = await expiredRegistrationFixture(t);
        let complete, arrived;
        const waiting = new Promise((resolve) => {
          complete = resolve;
        });
        const started = new Promise((resolve) => {
          arrived = resolve;
        });
        const requests = [];
        let attempts = 0;
        t.mock.method(globalThis, "fetch", async (url) => {
          requests.push(url);
          if (url === "/api/pages/register") {
            if (++attempts === 1) return expiredRegistration();
            assert.equal(phase, "register");
            arrived();
            await waiting;
            return Response.json({
              page_id: session.pageId,
              document_id: session.localPage.document_id,
            });
          }
          if (url === "/api/tools") {
            if (phase === "prepare") {
              arrived();
              await waiting;
            }
            return Response.json({ retry_token: "replacement-token" });
          }
          assert.equal(url, `/api/connect?page=${session.pageId}&sync=automerge`);
          if (phase === "connect") {
            arrived();
            await waiting;
            return Response.json(connectionFor(session, auth));
          }
          return Response.json(
            { error: "Page access denied", code: "page_access_denied" },
            { status: 403 },
          );
        });
        const registering = session.registerDraft();
        await started;
        const before = requests.length;
        if (invalidation === "close") await session.close();
        else session.acceptAuthentication(authentication());
        complete();
        await registering;
        assert.equal(requests.length, before, "no later requests from invalidated reconciliation");
        assert.equal((await readLocalPage(auth.identity, session.pageId)).registered, false);
      });
    }
  }
});

test("simultaneous expiry reconciliation adopts one persisted replacement request", async (t) => {
  const { auth, session: first, original } = await expiredRegistrationFixture(t);
  const second = await PageSession.open(first.pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => second.close());
  const replacements = [];
  let preparations = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/pages/register") {
      const input = JSON.parse(options.body);
      if (input.idempotency_key === original.idempotency_key) return expiredRegistration();
      replacements.push(input);
      return Response.json({ page_id: input.page_id, document_id: input.document_id });
    }
    if (url === "/api/tools")
      return Response.json({ retry_token: `replacement-token-${++preparations}` });
    assert.equal(url, `/api/connect?page=${first.pageId}&sync=automerge`);
    return Response.json(
      { error: "Page access denied", code: "page_access_denied" },
      { status: 403 },
    );
  });
  await Promise.all([first.registerDraft(), second.registerDraft()]);
  assert.ok(preparations >= 1);
  assert.ok(replacements.length >= 1);
  for (const replacement of replacements) assert.deepEqual(replacement, replacements[0]);
  assert.deepEqual(first.localPage.registration, second.localPage.registration);
  assert.equal(first.localPage.registered, true);
  assert.equal(second.localPage.registered, true);
});

test("local drafts retain their original account boundary before registration", async (t) => {
  browser(t);
  const auth = authentication();
  const other = authentication();
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw Error("Should not publish a different account's draft");
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const session = await PageSession.create(
    {},
    { authentication: auth, refreshSession: async () => other },
  );
  t.after(() => session.close());
  await session.connecting.catch(() => {});
  await tick();
  assert.equal(session.authRequired, true);
  assert.equal(session.identity.principal, auth.identity.principal);
  assert.equal(calls, 0);
  assert.equal(await readLocalPage(other.identity, session.pageId), null);
  await session.close();
  await retireLocalPage(auth.identity, session.pageId, { reason: "deleted" });
  assert.equal(await readLocalPage(auth.identity, session.pageId), null);
});

test("a successful connection clears its transient error without hiding a local save problem", () => {
  const session = new PageSession("test");
  session.connectionProblem = "Handshake failed";
  session.problem = session.connectionProblem;
  session.clearConnectionProblem();
  assert.equal(session.problem, "");
  session.connectionProblem = "Handshake failed";
  session.localProblem = session.problem = "Disk full";
  session.clearConnectionProblem();
  assert.equal(session.problem, "Disk full");
});

test("independent offline tabs merge their shared recovery checkpoints instead of overwriting edits", async (t) => {
  browser(t);
  const auth = authentication();
  let finishRefresh;
  const refresh = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const first = await PageSession.create(
    {},
    { authentication: auth, refreshSession: () => refresh },
  );
  const second = await PageSession.open(first.pageId, {
    authentication: auth,
    refreshSession: () => refresh,
  });
  t.after(async () => {
    await first.close();
    await second.close();
    finishRefresh(auth);
  });
  assert.notEqual(first.local.seed, second.local.seed);
  const blockId = Object.keys(first.doc.blocks)[0];
  await first.change((doc) => {
    doc.blocks[blockId].metadata.first = "From first tab";
  });
  await second.change((doc) => {
    doc.blocks[blockId].metadata.second = "From second tab";
  });
  clearTimeout(first.savedTimer);
  clearTimeout(second.savedTimer);
  await Promise.all([first.saveReceipt(), second.saveReceipt()]);
  await first.saveReceipt();
  const cache = await readLocalPage(auth.identity, first.pageId);
  const combined = A.load(decodeSnapshot(cache.snapshot));
  assert.equal(combined.blocks[blockId].metadata.first, "From first tab");
  assert.equal(combined.blocks[blockId].metadata.second, "From second tab");
  assert.equal(cache.pending, true);
  assert.equal(
    first.doc.blocks[blockId].metadata.second,
    undefined,
    "cache merging does not mutate a live replica",
  );
});

test("cached permission cannot raise a current read-only credential or cross an account change", async (t) => {
  browser(t);
  const auth = authentication();
  let finishCreationRefresh;
  const creationRefresh = new Promise((resolve) => {
    finishCreationRefresh = resolve;
  });
  const created = await PageSession.create(
    {},
    { authentication: auth, refreshSession: () => creationRefresh },
  );
  const pageId = created.pageId;
  await created.close();
  finishCreationRefresh(auth);
  await settleConnection(created);
  let finishOpenRefresh;
  const openRefresh = new Promise((resolve) => {
    finishOpenRefresh = resolve;
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("Wrong account must not publish cached Page");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const opened = await PageSession.open(pageId, {
    authentication: { ...auth, canWrite: false },
    refreshSession: () => openRefresh,
  });
  t.after(() => opened.close());
  assert.equal(opened.localPage.canWrite, true, "the cache was written with an editing credential");
  assert.equal(opened.canWrite, false, "current read-only credential is the upper bound");
  assert.throws(
    () =>
      opened.change((doc) => {
        doc.title = "Forbidden edit";
      }),
    /read only/,
  );
  finishOpenRefresh(authentication());
  await opened.connecting.catch(() => {});
  await tick();
  assert.equal(opened.identity.principal, auth.identity.principal);
  assert.equal(opened.canWrite, false);
  assert.equal(opened.authRequired, true);
  assert.equal(calls, 0);
});

function receiptSession() {
  const session = new PageSession("receipt-fixture");
  const doc = A.from({ text: "Pending edit" });
  session.handle = {
    doc: () => doc,
    documentId: interpretAsDocumentId(generateAutomergeUrl()),
  };
  session.repo = { flush: async () => {} };
  session.receiptRevision = 1;
  return session;
}
const drainTasks = () => new Promise((resolve) => setImmediate(resolve));

test("one transient receipt failure retries without reconnecting or another edit", async (t) => {
  for (const failure of [409, 503, "network"]) {
    await t.test(String(failure), async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const session = receiptSession();
      let requests = 0;
      t.mock.method(globalThis, "fetch", async () => {
        requests++;
        if (requests === 1) {
          if (failure === "network") throw new TypeError("Fetch failed");
          return Response.json({ error: "Temporary receipt failure" }, { status: failure });
        }
        return Response.json({ durableHeads: A.getHeads(session.doc) });
      });
      t.after(() => session.close());
      await session.saveReceipt();
      assert.equal(requests, 1);
      assert.ok(session.receiptRetryTimer);
      t.mock.timers.tick(500);
      await drainTasks();
      assert.equal(requests, 2);
      assert.equal(session.status, "Saved");
      assert.equal(session.receiptRetryTimer, undefined);
      assert.equal(session.problem, "");
    });
  }
});

test("receipt retries stop after three attempts and stale, signed-out, or closed sessions cancel them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ error: "Temporary receipt failure" }, { status: 500 });
  });
  const bounded = receiptSession();
  await bounded.saveReceipt();
  for (const delay of [500, 1000, 2000]) {
    t.mock.timers.tick(delay);
    await drainTasks();
  }
  assert.equal(requests, 4);
  assert.equal(bounded.receiptRetryTimer, undefined);
  t.mock.timers.tick(10000);
  await drainTasks();
  assert.equal(requests, 4);
  await bounded.close();
  for (const invalidate of [
    (session) => {
      session.receiptRevision++;
    },
    (session) => session.requireSignIn(),
    (session) => session.close(),
  ]) {
    const session = receiptSession();
    await session.saveReceipt();
    const before = requests;
    await invalidate(session);
    t.mock.timers.tick(10000);
    await drainTasks();
    assert.equal(requests, before);
    await session.close();
  }
});

test("missing-heads receipt retries re-arm native catch-up before asking the host again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = receiptSession();
  const events = [];
  session.backend = {
    open(id) {
      assert.deepEqual(id, documentIdToBinary(session.handle.documentId));
      events.push("open");
      return {
        async synchronize() {
          events.push("synchronize");
          return { outcome: "complete" };
        },
        async close() {
          events.push("close");
        },
      };
    },
  };
  t.mock.method(session, "connect", () => assert.fail("catch-up must not reconnect"));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    events.push("receipt");
    return ++requests === 1
      ? Response.json({ error: "Requested edits have not arrived" }, { status: 409 })
      : Response.json({ durableHeads: A.getHeads(session.doc) });
  });
  t.after(() => session.close());
  await session.saveReceipt();
  t.mock.timers.tick(500);
  await drainTasks();
  assert.deepEqual(events, ["receipt", "open", "synchronize", "close", "receipt"]);
  assert.equal(session.status, "Saved");
  assert.equal(session.problem, "");
  assert.equal(session.receiptRevision, 1, "catch-up keeps the same receipt generation");
});

test("native catch-up retains the receipt retry bound and cannot itself claim Saved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = receiptSession();
  let rounds = 0,
    closed = 0,
    requests = 0;
  session.backend = {
    open() {
      return {
        async synchronize() {
          rounds++;
          return { outcome: "complete" };
        },
        async close() {
          closed++;
        },
      };
    },
  };
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ error: "Requested edits have not arrived" }, { status: 409 });
  });
  await session.saveReceipt();
  for (const delay of [500, 1000, 2000]) {
    t.mock.timers.tick(delay);
    await drainTasks();
  }
  assert.equal(requests, 4);
  assert.equal(rounds, 3);
  assert.equal(closed, 3);
  assert.notEqual(session.status, "Saved");
  assert.equal(session.receiptRetryTimer, undefined);
  t.mock.timers.tick(10000);
  await drainTasks();
  assert.equal(requests, 4);
  await session.close();
});

test("failed native catch-up closes its session and remains scheduled within the same budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = receiptSession();
  let rounds = 0,
    closed = 0,
    requests = 0;
  session.backend = {
    open() {
      return {
        async synchronize() {
          if (++rounds === 1) throw Error("Native synchronization failed");
          return { outcome: "complete" };
        },
        async close() {
          closed++;
        },
      };
    },
  };
  t.mock.method(globalThis, "fetch", async () =>
    ++requests === 1
      ? Response.json({ error: "Requested edits have not arrived" }, { status: 409 })
      : Response.json({ durableHeads: A.getHeads(session.doc) }),
  );
  t.after(() => session.close());
  await session.saveReceipt();
  t.mock.timers.tick(500);
  await drainTasks();
  assert.equal(closed, 1);
  assert.equal(requests, 1);
  assert.equal(session.receiptRetryAttempts, 2);
  t.mock.timers.tick(1000);
  await drainTasks();
  assert.equal(rounds, 2);
  assert.equal(closed, 2);
  assert.equal(requests, 2);
  assert.equal(session.status, "Saved");
});

test("unrelated receipt failures do not start native catch-up", async (t) => {
  for (const status of [409, 503]) {
    await t.test(String(status), async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const session = receiptSession();
      session.backend = { open: () => assert.fail("unrelated error must not trigger catch-up") };
      let requests = 0;
      t.mock.method(globalThis, "fetch", async () =>
        ++requests === 1
          ? Response.json({ error: "Unrelated error" }, { status })
          : Response.json({ durableHeads: A.getHeads(session.doc) }),
      );
      t.after(() => session.close());
      await session.saveReceipt();
      t.mock.timers.tick(500);
      await drainTasks();
      assert.equal(requests, 2);
      assert.equal(session.status, "Saved");
    });
  }
});

test("native catch-up cannot publish a stale receipt after either asynchronous boundary", async (t) => {
  for (const phase of ["synchronize", "close"]) {
    for (const invalidate of ["revision", "signout", "account", "deleted", "closed"]) {
      await t.test(`${phase}: ${invalidate}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const session = receiptSession();
        session.identity = { principal: "original" };
        let finish,
          fail,
          closed = 0,
          requests = 0;
        const pending = new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        session.backend = {
          open() {
            return {
              async synchronize() {
                if (phase === "synchronize") await pending;
                return { outcome: "complete" };
              },
              async close() {
                closed++;
                if (phase === "close") await pending;
              },
            };
          },
        };
        t.mock.method(globalThis, "fetch", async () => {
          requests++;
          return Response.json({ error: "Requested edits have not arrived" }, { status: 409 });
        });
        await session.saveReceipt();
        t.mock.timers.tick(500);
        await drainTasks();
        if (invalidate === "revision") session.receiptRevision++;
        else if (invalidate === "signout") session.requireSignIn();
        else if (invalidate === "account")
          session.acceptAuthentication({ identity: { principal: "other" }, canWrite: true });
        else if (invalidate === "deleted") {
          session.phase$.update(() => ({ name: "retired", reason: "deleted" }));
          session.status = "Deleted";
          session.statusId = "deleted";
        } else await session.close();
        if (invalidate === "deleted") fail(Error("Stale native failure"));
        else finish();
        await drainTasks();
        assert.equal(closed, 1);
        assert.equal(requests, 1, "no stale HTTP receipt after native catch-up");
        if (invalidate === "deleted") assert.equal(session.status, "Deleted");
        assert.equal(session.receiptRetryTimer, undefined);
        await session.close();
      });
    }
  }
});

test("a forbidden receipt pauses page access without requesting sign-in or scheduling a retry", async (t) => {
  const session = receiptSession();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Forbidden" }, { status: 403 }),
  );
  await session.saveReceipt();
  assert.equal(session.authRequired, false);
  assert.equal(session.accessDenied, true);
  assert.equal(session.canWrite, false);
  assert.equal(session.status, "Access removed");
  assert.equal(session.receiptRetryTimer, undefined);
  await session.close();
});

test("authenticated deleted Pages and deleted registrations terminate local editing", async (t) => {
  for (const failure of ["connect-deleted", "registration-deleted", "registration-quota"]) {
    await t.test(failure, async (t) => {
      browser(t);
      const auth = authentication();
      let authenticate;
      const refresh = new Promise((resolve) => {
        authenticate = resolve;
      });
      t.mock.method(globalThis, "fetch", async (url, options) => {
        if (url === "/api/tools") return Response.json({ retry_token: "fixture-retry-token" });
        if (url === "/api/pages/register") {
          if (failure.startsWith("registration"))
            return Response.json(
              {
                error:
                  failure === "registration-deleted"
                    ? "Page was deleted"
                    : "This prototype permits 100 pages per account",
              },
              { status: 409 },
            );
          const input = JSON.parse(options.body);
          return Response.json({ page_id: input.page_id, document_id: input.document_id });
        }
        assert.match(url, /^\/api\/connect/);
        return Response.json({ error: "Page not found", code: "page_deleted" }, { status: 404 });
      });
      const session = await PageSession.create(
        {},
        { authentication: auth, refreshSession: () => refresh },
      );
      t.after(() => session.close());
      authenticate(auth);
      await session.connecting.catch(() => {});
      await tick();
      if (failure === "registration-quota") {
        assert.notEqual(session.deleted, true);
        assert.equal(session.canWrite, true);
        assert.equal((await listLocalPages(auth.identity)).length, 1);
      } else {
        assert.equal(session.deleted, true);
        assert.equal(session.canWrite, false);
        assert.equal(session.status, "Deleted");
        assert.equal(session.alive, false);
        assert.equal(session.retryTimer, undefined);
        assert.equal(await readLocalPage(auth.identity, session.pageId), null);
        assert.deepEqual(await listLocalPages(auth.identity), []);
        await session.persistLocal({ pending: true });
        assert.equal(await readLocalPage(auth.identity, session.pageId), null);
      }
    });
  }
});

test("a deletion marker from another tab terminates stale local checkpoint writes", async (t) => {
  browser(t);
  const auth = authentication();
  let finishRefresh;
  const refresh = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const session = await PageSession.create(
    {},
    { authentication: auth, refreshSession: () => refresh },
  );
  t.after(async () => {
    await session.close();
    finishRefresh(auth);
  });
  await retireLocalPage(auth.identity, session.pageId, { reason: "deleted" });
  await session.change((doc) => A.updateText(doc, ["title"], "A stale tab's edit"));
  clearTimeout(session.savedTimer);
  await session.saveReceipt();
  assert.equal(session.status, "Deleted");
  assert.equal(session.statusKey, "attention");
  assert.equal(session.statusRetry, false);
  assert.equal(session.canWrite, false);
  assert.equal(session.alive, false);
  assert.equal(session.receiptRetryTimer, undefined);
  await session.persistLocal({ pending: true }, { allowClosed: true });
  assert.deepEqual(await listLocalPages(auth.identity), []);
  assert.equal(await readLocalPage(auth.identity, session.pageId), null);
});

test("duplicated tabs open a shared checkpoint larger than an ordinary native edit batch", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication(),
    pageId = "0fbd48c2-6e1b-47e3-a42b-325abc946044";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const data = createPageData({ pageId, title: "Cached history" });
  const block = Object.values(data.blocks)[0];
  block.id = "36f62da1-539d-4d43-9974-dd46e51997a1";
  data.blocks = { [block.id]: block };
  // Fixed IDs and timestamps keep fragment aggregation stable across runs.
  let doc = A.change(A.init({ actor: "ab".repeat(16) }), { time: 0 }, (draft) =>
    Object.assign(draft, data),
  );
  doc = A.change(doc, { time: 0 }, initializePage);
  // Fragment boundaries follow change hashes, so the count that exceeds the
  // batch limit depends on the fixture's exact history.
  for (let i = 0; i < 1200; i++)
    doc = A.change(doc, { time: 0 }, (draft) => {
      draft.title = `Cached history ${i % 2}`;
    });
  const snapshot = A.save(doc);
  assert.ok(extractRecords(doc).length > 128, "fixture must exceed ordinary batch admission");
  const heads = A.getHeads(doc);
  await writeLocalPage(auth.identity, {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: documentId,
    title: doc.title,
    snapshot: encodeSnapshot(snapshot),
    canWrite: true,
    registered: true,
    pending: true,
  });
  A.free(doc);
  const first = await PageSession.open(pageId, { authentication: auth });
  t.after(() => first.close());
  const second = await PageSession.open(pageId, { authentication: auth });
  t.after(() => second.close());
  assert.notEqual(first.local.seed, second.local.seed, "each tab owns its native replica");
  assert.deepEqual(A.getHeads(first.doc), heads);
  assert.deepEqual(A.getHeads(second.doc), heads);
  assert.equal(second.handle.documentId, documentId);
  assert.equal(second.status, "Saved locally", "local import is not a server receipt");
});

/** A Page whose two concurrent edits merge in a fragment-headed change, in
 * the two orders peers can apply them. */
function concurrentMergeFixture(pageId) {
  const data = createPageData({ pageId, title: "Shared history" });
  const block = Object.values(data.blocks)[0];
  block.id = "7a3c0e52-9a59-4b6e-8f0a-2d6c5f4b1e90";
  data.blocks = { [block.id]: block };
  let base = A.change(A.init({ actor: "ab".repeat(16) }), { time: 0 }, (draft) =>
    Object.assign(draft, data),
  );
  base = A.change(base, { time: 0 }, initializePage);
  const concurrent = (actor, time, field) =>
    A.getChanges(
      base,
      A.change(A.clone(base, { actor }), { time }, (draft) => {
        draft[field] = actor;
      }),
    )[0];
  const x = concurrent("1c".repeat(16), 1, "left");
  const y = concurrent("1d".repeat(16), 2, "right");
  const both = () => A.applyChanges(A.clone(base), [x, y])[0];
  let m;
  for (let time = 3; time < 4096 && !m; time++) {
    const merged = A.change(A.clone(both(), { actor: "1e".repeat(16) }), { time }, (draft) => {
      draft.title = "Merged";
    });
    const [head] = A.getHeads(merged);
    if (extractRecords(merged).some((record) => record.kind === "fragment" && record.head === head))
      [m] = A.getChanges(both(), merged);
  }
  assert.ok(m, "a fragment-headed merge within the timestamp bound");
  return {
    base,
    head: A.decodeChange(m).hash,
    leftFirst: A.applyChanges(A.clone(base), [x, y, m])[0],
    rightFirst: A.applyChanges(A.applyChanges(A.clone(base), [y])[0], [x, m])[0],
  };
}

const checkpointPage = (auth, pageId, documentId, doc) => ({
  principal: auth.identity.principal,
  page_id: pageId,
  document_id: documentId,
  title: doc.title,
  snapshot: encodeSnapshot(A.save(doc)),
  canWrite: true,
  registered: true,
  pending: true,
});

async function replaceCheckpoint(auth, pageId, doc) {
  await writeLocalPage(auth.identity, {
    ...(await readLocalPage(auth.identity, pageId)),
    snapshot: encodeSnapshot(A.save(doc)),
  });
}

test("reopening imports only checkpoint history the replica does not already hold", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication(),
    pageId = "5d0f3a5e-2f4e-4a8e-9a43-3c1f0f6f2b71";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const { leftFirst, rightFirst } = concurrentMergeFixture(pageId);
  // The same history, applied in two orders, encodes the fragment differently.
  const fragment = (doc) => extractRecords(doc).find((record) => record.kind === "fragment");
  assert.notDeepEqual(fragment(leftFirst).blob, fragment(rightFirst).blob);
  await writeLocalPage(auth.identity, checkpointPage(auth, pageId, documentId, rightFirst));
  const first = await PageSession.open(pageId, { authentication: auth });
  const seed = first.local.seed;
  await first.close();
  // A later checkpoint of this replica's own document orders the history
  // differently from the fragment the replica already stores.
  await replaceCheckpoint(auth, pageId, leftFirst);
  const reopened = await PageSession.open(pageId, { authentication: auth });
  t.after(() => reopened.close());
  assert.equal(reopened.local.seed, seed, "the same replica reopens");
  assert.deepEqual(A.getHeads(reopened.doc).sort(), A.getHeads(leftFirst).sort());
  assert.equal(reopened.snapshot().title, "Merged");
});

test("reopening restores checkpoint changes a same-head stored fragment lacks", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication(),
    pageId = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const { base, head, leftFirst } = concurrentMergeFixture(pageId);
  const full = extractRecords(leftFirst).find((record) => record.head === head);
  assert.ok(A.readBundle(full.blob).changes.length > 1, "the checkpoint bundles history");
  // A valid partial bundle: the same head, holding only the merge itself.
  const partial = {
    kind: "fragment",
    head,
    boundary: [],
    checkpoints: [],
    blob: A.saveBundle(leftFirst, [head]),
  };
  await writeLocalPage(auth.identity, checkpointPage(auth, pageId, documentId, base));
  const first = await PageSession.open(pageId, { authentication: auth });
  await first.backend.storeSnapshot(documentIdToBinary(documentId), [partial]);
  await first.close();
  await replaceCheckpoint(auth, pageId, leftFirst);
  const reopened = await PageSession.open(pageId, { authentication: auth });
  t.after(() => reopened.close());
  assert.deepEqual(A.getHeads(reopened.doc).sort(), A.getHeads(leftFirst).sort());
  assert.equal(reopened.doc.left, "1c".repeat(16));
  assert.equal(reopened.doc.right, "1d".repeat(16));
  assert.equal(reopened.snapshot().title, "Merged");
});

test("an offline comment survives a reload: both documents restore from the checkpoint", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication();
  const first = await PageSession.create(
    { title: "Offline comments" },
    { authentication: auth, refreshSession: async () => auth },
  );
  // A comments document as discovery would have named it; offline, the
  // replica creates it locally the way the host's deterministic genesis does.
  const { commentsGenesis } = await import("../model/comments-doc.mjs");
  const comments = await first.repo.import(
    A.save(commentsGenesis("c0000000-0000-4000-8000-0000000000aa")),
  );
  first.commentsHandle = comments;
  await first.change((doc) => {
    doc.schema = { features: ["comments-doc"] };
  });
  first.access = { ...first.access, canComment: true };
  first.updateCapabilities();
  const blockId = Object.keys(first.doc.blocks)[0];
  await first.comment({ action: "add", block_id: blockId, body: "Typed offline" });
  clearTimeout(first.savedTimer);
  await first.persistLocal({ pending: true });
  const pageId = first.pageId;
  const commentsId = comments.documentId;
  await first.close();

  const restored = await PageSession.open(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => restored.close());
  assert.equal(restored.localPage.comments_document_id, commentsId);
  // Offline, the stored ID opens the restored copy. "ready" is the machine's
  // state; the install that adopts the handle still reads the stored entry
  // first (installComments), so wait for the document itself.
  await new Promise((resolve) => {
    const check = () => (restored.commentsDoc ? resolve() : setTimeout(check, 5));
    check();
  });
  const threads = Object.values(restored.commentsDoc.threads);
  assert.equal(threads.length, 1);
  assert.equal(String(Object.values(threads[0].messages)[0].body), "Typed offline");
  assert.match(restored.exportRecovery().markdown, /Typed offline/);
});
