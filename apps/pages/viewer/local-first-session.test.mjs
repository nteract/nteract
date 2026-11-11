import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  DRAFT_FORM_UNSUPPORTED,
  LOCAL_COPY_DISCARDED,
  PageSession,
  connectionFailureRetries,
  listLocalPages,
  retireLocalPage,
} from "./session.mjs";
import { readLocalPage, decodeSnapshot, writeLocalPage, encodeSnapshot } from "./local-pages.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { readRegistration } from "../worker/registration.mjs";
import { host as syncHost, until } from "../sync/test-helpers.mjs";
import { framePipe } from "../sync/wire.mjs";
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
  await session.connecting?.catch(() => {});
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
    A.splice(doc, ["blocks", blockId, "richText"], 0, 0, "From first tab");
  });
  await second.change((doc) => {
    A.splice(doc, ["blocks", blockId, "richText"], 0, 0, "From second tab");
  });
  clearTimeout(first.savedTimer);
  clearTimeout(second.savedTimer);
  await Promise.all([first.saveReceipt(), second.saveReceipt()]);
  await first.saveReceipt();
  const cache = await readLocalPage(auth.identity, first.pageId);
  const combined = A.load(decodeSnapshot(cache.snapshot));
  assert.match(combined.blocks[blockId].richText, /From first tab/);
  assert.match(combined.blocks[blockId].richText, /From second tab/);
  assert.equal(cache.pending, true);
  assert.doesNotMatch(
    first.doc.blocks[blockId].richText,
    /From second tab/,
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

test("duplicated tabs open a shared checkpoint larger than an ordinary edit batch", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication(),
    pageId = "0fbd48c2-6e1b-47e3-a42b-325abc946044";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const data = createPageData({ pageId, title: "Cached history" });
  const block = Object.values(data.blocks)[0];
  data.blocks = { "36f62da1-539d-4d43-9974-dd46e51997a1": block };
  // Fixed IDs and timestamps keep fragment aggregation stable across runs.
  let doc = A.change(A.init({ actor: "ab".repeat(16) }), { time: 0 }, (draft) =>
    Object.assign(draft, data),
  );
  doc = A.change(doc, { time: 0 }, initializePage);
  // Fragment boundaries follow change hashes, so the count that exceeds the
  // batch limit depends on the fixture's exact history.
  for (let i = 0; i < 1300; i++)
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
  assert.notEqual(first.local.seed, second.local.seed, "each tab owns its replica");
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
  data.blocks = { "7a3c0e52-9a59-4b6e-8f0a-2d6c5f4b1e90": block };
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
  assert.equal(String(Object.values(threads[0].messages)[0].richText), "Typed offline");
  assert.match(restored.exportRecovery().markdown, /Typed offline/);
});

/** Attach `session`'s replica to `h` as the Page host's socket would. */
function attach(session, h) {
  const link = framePipe();
  h.accept(link.host, {
    principal: session.identity.principal,
    sessionId: `s-${session.senderId}`,
    senderId: session.senderId,
    role: "owner",
  });
  session.backend.addConnection(link.client, { hostId: h.hostId });
}
const hexOfDocument = (documentId) => Buffer.from(documentIdToBinary(documentId)).toString("hex");

test("a local copy saved beside a Subduction replica restores into plain sync, and its unsent edit uploads", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = authentication(),
    pageId = "6f0b8a52-5d0e-4c4f-9a3e-7f2a1c9d4b10";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  // The host holds the Page as last saved.
  const base = A.change(A.from(createPageData({ pageId, title: "Before" })), initializePage);
  const h = await syncHost();
  await h.seed(hexOfDocument(documentId), "page", base);
  // An earlier build's checkpoint: no recordStorage (its Subduction replica),
  // and an edit made offline that the host never confirmed.
  const edited = A.change(A.clone(base, { actor: "cd".repeat(16) }), (doc) => {
    doc.title = "Edited offline";
  });
  await writeLocalPage(auth.identity, {
    ...checkpointPage(auth, pageId, documentId, edited),
    replicaKey: "0:writer",
    access: { role: "owner", revision: 0, generation: 0, canRead: true, canWrite: true },
  });
  const session = await PageSession.open(pageId, { authentication: auth });
  t.after(() => session.close());
  assert.match(session.databaseName, /^pages-plain-/);
  assert.equal(session.doc.title, "Edited offline");
  assert.equal(session.recoveryPending, true, "the offline edit still needs a receipt");
  assert.equal((await readLocalPage(auth.identity, pageId)).recordStorage, "automerge");
  attach(session, h);
  await until(
    async () => (await h.document(hexOfDocument(documentId))).title === "Edited offline",
    {
      label: "the host has the offline edit",
    },
  );
});

test("a local copy with no readable checkpoint is discarded, and the Page opens from the host with a notice", async (t) => {
  browser(t);
  const auth = authentication(),
    pageId = "1e7c4b90-3a2f-4d8b-b5c6-0f9e8d7a6b54";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const hosted = A.change(A.from(createPageData({ pageId, title: "On the host" })), initializePage);
  const h = await syncHost();
  await h.seed(hexOfDocument(documentId), "page", hosted);
  await writeLocalPage(auth.identity, {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: documentId,
    title: "Unreadable",
    snapshot: encodeSnapshot(new Uint8Array([1, 2, 3, 4])),
    canWrite: true,
    registered: true,
    pending: true,
  });
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  t.mock.method(PageSession.prototype, "queueSaved", () => {});
  // Discovery and the socket, as the host answers them.
  t.mock.method(PageSession.prototype, "connect", async function () {
    this.connection = { documentId, serverSenderId: h.hostId, peerProfiles: {} };
    attach(this, h);
  });
  const session = await PageSession.open(pageId, { authentication: auth });
  t.after(() => session.close());
  assert.equal(session.openNotice, LOCAL_COPY_DISCARDED);
  assert.equal(session.doc.title, "On the host");
  const stored = await readLocalPage(auth.identity, pageId);
  assert.equal(stored.recordStorage, "automerge");
  assert.equal(stored.pending, false);
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "On the host");
});
