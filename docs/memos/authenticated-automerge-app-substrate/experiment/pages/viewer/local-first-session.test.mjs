import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { PageSession, listLocalPages, retireLocalPage } from "./session.mjs";
import { readLocalPage, decodeSnapshot, writeLocalPage, encodeSnapshot } from "./local-pages.mjs";
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
    assert.equal(url, `/api/connect?page=${session.pageId}`);
    return Response.json(connectionFor(session, auth));
  });
  await session.registerDraft();
  assert.deepEqual(requests, ["/api/pages/register", `/api/connect?page=${session.pageId}`]);
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
    assert.equal(url, `/api/connect?page=${session.pageId}`);
    probes++;
    return Response.json({ error: "Page not found" }, { status: 404 });
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
        assert.equal(url, `/api/connect?page=${session.pageId}`);
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
      assert.deepEqual(requests, ["/api/pages/register", `/api/connect?page=${session.pageId}`]);
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
          assert.equal(url, `/api/connect?page=${session.pageId}`);
          if (phase === "connect") {
            arrived();
            await waiting;
            return Response.json(connectionFor(session, auth));
          }
          return Response.json({ error: "Page not found" }, { status: 404 });
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
    assert.equal(url, `/api/connect?page=${first.pageId}`);
    return Response.json({ error: "Page not found" }, { status: 404 });
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

test("authenticated missing Pages and deleted registrations terminate local editing", async (t) => {
  for (const failure of ["connect-missing", "registration-deleted", "registration-quota"]) {
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
        return Response.json({ error: "Page not found" }, { status: 404 });
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

// An offline tab from before the preserved-block conversion converted a raw
// table with its Edit table action. The host converted the same table and
// refused that tab's write (its build lacks the conversion feature). The tab
// reloads into this build: its pre-cutover edit must not sync, or the merge
// holds the table twice.
test("reopening sets aside a pre-cutover conversion of a preserved block, so sync holds one copy", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const { pmNodeToSpans } = await import("@automerge/prosemirror");
  const { adapter, schema, textPath, exportMarkdown, richDoc } =
    await import("../model/richtext.mjs");
  const { convertPreservedBlocks, convertedSpans, hasPreservedBlocks } =
    await import("../model/raw-migration.mjs");
  const { orderedBlockIds } = await import("../model/page.mjs");
  const auth = authentication(),
    pageId = "0b6c1f5e-8a2d-4f3b-9c7e-1d2e3f4a5b6c";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  // The Page as an older build stored it, already on the host.
  let base = A.change(A.from(createPageData({ pageId, title: "Release" })), (draft) =>
    initializePage(draft, ""),
  );
  const id = orderedBlockIds(base)[0];
  base = A.change(base, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      pmNodeToSpans(
        adapter,
        schema.node("doc", null, [
          schema.node("paragraph", null, [schema.text("Plan")]),
          schema.node("raw", {
            source: "| Step | Owner |\n| --- | --- |\n| Tag release | Kyle |",
            importId: "",
            kind: "markdown",
          }),
        ]),
      ),
      adapter.updateSpansConfig(),
    ),
  );
  const oldActor = "1c".repeat(16);
  const oldTab = A.change(A.clone(base, { actor: oldActor }), (draft) => {
    const spans = A.spans(draft, textPath(id)).flatMap((span) =>
      span.type === "block" && String(span.value.type) === "pages-opaque"
        ? convertedSpans(span)
        : [span],
    );
    A.updateSpans(draft, textPath(id), spans, adapter.updateSpansConfig());
  });
  const host = A.change(A.clone(base), (draft) => convertPreservedBlocks(draft));
  const copies = (doc) => exportMarkdown(richDoc(doc.blocks[id])).split("Tag release").length - 1;
  // Without the fix: both conversions merge and the table appears twice.
  assert.equal(copies(A.merge(A.clone(host), oldTab)), 2);
  // The host refused the old tab's write: its build lacks the stamp.
  const { missingFeatures, documentFeatures, BUILD_FEATURES } =
    await import("../model/schema-features.mjs");
  const { CONVERSION_FEATURE } = await import("../model/raw-migration.mjs");
  const oldBuild = BUILD_FEATURES.filter((feature) => feature !== CONVERSION_FEATURE);
  assert.deepEqual(missingFeatures(documentFeatures(host), oldBuild), [CONVERSION_FEATURE]);

  await writeLocalPage(auth.identity, {
    ...checkpointPage(auth, pageId, documentId, oldTab),
    localEdits: {
      actors: [{ actor: oldActor, replica: "ab".repeat(16) }],
      ackedHeads: A.getHeads(base),
      unattributed: false,
    },
  });
  const reopened = await PageSession.open(pageId, { authentication: auth });
  t.after(() => reopened.close());
  assert.equal(reopened.recoveredPreservedEdits, true);
  assert.match(reopened.problem, /Download previous local draft/);
  assert.deepEqual(A.getHeads(reopened.doc).sort(), A.getHeads(base).sort());
  assert.equal(hasPreservedBlocks(reopened.doc), true, "the host's conversion will arrive");
  assert.equal(reopened.status, "Saved locally", "nothing of its own is waiting to sync");
  // The set-aside edit is kept as a recovery copy.
  const [recovery] = (await reopened.listRecoveries()).slice(-1);
  const kept = A.load(decodeSnapshot(recovery.snapshot));
  assert.ok(A.hasHeads(kept, A.getHeads(oldTab)));
  assert.match(reopened.exportRecovery(recovery).markdown, /Tag release/);
  // Native sync: the host's history plus everything this replica can publish.
  const synced = A.merge(A.clone(host), reopened.doc);
  assert.equal(copies(synced), 1);
  assert.equal(hasPreservedBlocks(synced), false);
  // A second open finds nothing to set aside.
  await reopened.close();
  const again = await PageSession.open(pageId, { authentication: auth });
  t.after(() => again.close());
  assert.ok(!again.recoveredPreservedEdits);
  assert.deepEqual(A.getHeads(again.doc).sort(), A.getHeads(base).sort());
});

// The same pre-cutover conversion in a checkpoint with no acknowledgement
// record (unattributed edits): the whole history is read, and the set-aside
// still leaves exactly one copy after sync. An ordinary offline edit made
// beside it with the new build is kept.
test("reopening sets aside a pre-cutover conversion with no acknowledged heads", async (t) => {
  browser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const { pmNodeToSpans } = await import("@automerge/prosemirror");
  const { adapter, schema, textPath, exportMarkdown, richDoc } =
    await import("../model/richtext.mjs");
  const { convertPreservedBlocks, convertedSpans, preservedBlockEdits } =
    await import("../model/raw-migration.mjs");
  const { orderedBlockIds } = await import("../model/page.mjs");
  const auth = authentication(),
    pageId = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  let base = A.change(A.from(createPageData({ pageId, title: "Notes" })), (draft) =>
    initializePage(draft, ""),
  );
  const id = orderedBlockIds(base)[0];
  base = A.change(base, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      pmNodeToSpans(
        adapter,
        schema.node("doc", null, [
          schema.node("raw", { source: "~~Only once~~", importId: "", kind: "markdown" }),
        ]),
      ),
      adapter.updateSpansConfig(),
    ),
  );
  const oldTab = A.change(A.clone(base, { actor: "2c".repeat(16) }), (draft) => {
    const spans = A.spans(draft, textPath(id)).flatMap((span) =>
      span.type === "block" && String(span.value.type) === "pages-opaque"
        ? convertedSpans(span)
        : [span],
    );
    A.updateSpans(draft, textPath(id), spans, adapter.updateSpansConfig());
  });
  // An ordinary title edit, also unconfirmed, on a different branch.
  const titled = A.change(A.clone(base, { actor: "3c".repeat(16) }), (draft) => {
    draft.title = "Notes (edited)";
  });
  const local = A.merge(A.clone(oldTab), titled);
  // The host's own conversion is never selected.
  const host = A.change(A.clone(base), (draft) => convertPreservedBlocks(draft));
  assert.equal(preservedBlockEdits(A.merge(A.clone(host), titled), []), null);
  await writeLocalPage(auth.identity, {
    ...checkpointPage(auth, pageId, documentId, local),
    localEdits: { actors: [], ackedHeads: [], unattributed: true },
  });
  const reopened = await PageSession.open(pageId, { authentication: auth });
  t.after(() => reopened.close());
  assert.equal(reopened.recoveredPreservedEdits, true);
  // The title edit doesn't depend on the conversion, so it stays.
  assert.equal(reopened.doc.title, "Notes (edited)");
  const synced = A.merge(A.clone(host), reopened.doc);
  assert.equal(exportMarkdown(richDoc(synced.blocks[id])).split("Only once").length - 1, 1);
  assert.equal(synced.title, "Notes (edited)");
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
