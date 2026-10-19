import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { PageSession, listLocalPages, forgetLocalPage } from "./session.mjs";
import { readLocalPage, decodeSnapshot } from "./local-pages.mjs";
import { documentIdToBinary } from "@automerge/automerge-repo";
import { readRegistration } from "../worker/registration.mjs";

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
  assert.equal(restored.localPage.registered, true);
  assert.equal(restored.localPage.pending, true);
  assert.notEqual(restored.status, "Saved", "registration is not a receipt for later edits");
  assert.equal(A.load(decodeSnapshot(requests[0].initial_snapshot_base64)).title, "Original title");
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
  await forgetLocalPage(auth.identity, session.pageId);
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
  session.handle = { doc: () => doc };
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
    return Response.json({ error: "Temporary receipt failure" }, { status: 503 });
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

test("a forbidden receipt pauses authentication without scheduling a retry", async (t) => {
  const session = receiptSession();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Forbidden" }, { status: 403 }),
  );
  await session.saveReceipt();
  assert.equal(session.authRequired, true);
  assert.equal(session.status, "Sign in to sync");
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
  await forgetLocalPage(auth.identity, session.pageId);
  await session.change((doc) => A.updateText(doc, ["title"], "A stale tab's edit"));
  clearTimeout(session.savedTimer);
  await session.saveReceipt();
  assert.equal(session.status, "Deleted");
  assert.equal(session.canWrite, false);
  assert.equal(session.alive, false);
  assert.equal(session.receiptRetryTimer, undefined);
  await session.persistLocal({ pending: true }, { allowClosed: true });
  assert.deepEqual(await listLocalPages(auth.identity), []);
  assert.equal(await readLocalPage(auth.identity, session.pageId), null);
});
