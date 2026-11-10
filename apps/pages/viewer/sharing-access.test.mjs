import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharingAccess, SHARING_FRESH_MS, sharingAvailable } from "./sharing-access.mjs";

const session = (pageId = "page-a", principal = "account-a") => ({
  pageId,
  identity: { principal },
  access: { canRead: true, role: "owner" },
  canManageAccess: true,
});
const ledger = (revision = 1, principal = "account-a") => ({
  owner: { principal, displayName: principal },
  access: { canManageAccess: true, revision },
  members: [],
  invites: [],
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => Promise.resolve();

test("preload and repeated opens share one request and retain the fresh ledger", async () => {
  const response = deferred(),
    calls = [];
  const cache = createSharingAccess(session(), {
    request: (...args) => {
      calls.push(args);
      return response.promise;
    },
  });
  const preload = cache.read();
  assert.equal(cache.read(), preload);
  assert.equal(cache.getSnapshot().refreshing, true);
  await tick();
  assert.equal(calls.length, 1);
  response.resolve(ledger());
  await preload;
  const ready = cache.getSnapshot();
  assert.equal(await cache.read(), ready.value);
  assert.equal(cache.getSnapshot(), ready);
  assert.equal(calls.length, 1);
});

test("expired data stays visible during one deduplicated background refresh", async () => {
  let clock = 0,
    calls = 0;
  const background = deferred();
  const cache = createSharingAccess(session(), {
    now: () => clock,
    request: () => (++calls === 1 ? ledger() : background.promise),
  });
  await cache.read();
  clock = SHARING_FRESH_MS;
  const refresh = cache.read();
  assert.equal(cache.getSnapshot().value.access.revision, 1);
  assert.equal(cache.getSnapshot().refreshing, true);
  assert.equal(cache.read(), refresh);
  background.resolve(ledger(2));
  await refresh;
  assert.equal(cache.getSnapshot().value.access.revision, 2);
  assert.equal(calls, 2);
});

test("a mutation replaces cached access and a late GET cannot overwrite it", async () => {
  const stale = deferred(),
    write = deferred(),
    calls = [];
  const cache = createSharingAccess(session(), {
    request: (_url, options) => {
      calls.push(options);
      return calls.length === 1
        ? ledger()
        : options.method === "POST"
          ? write.promise
          : stale.promise;
    },
  });
  await cache.read();
  const read = cache.read({ force: true });
  await tick();
  const mutation = cache.mutate(
    { action: "invite", email: "person@example.com", role: "viewer" },
    "invite",
  );
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(cache.getSnapshot().busy, "invite");
  assert.equal(await cache.mutate({ action: "invite" }, "invite"), null);
  await tick();
  const body = JSON.parse(calls[2].body);
  assert.equal(body.expected_revision, 1);
  assert.ok(body.idempotency_key);
  write.resolve(ledger(2));
  await mutation;
  stale.resolve(ledger(1));
  await read;
  assert.equal(cache.getSnapshot().value.access.revision, 2);
  await cache.read();
  assert.equal(calls.length, 3);
});

test("a conflict refreshes the ledger while retaining the actionable error", async () => {
  let calls = 0;
  const conflict = Object.assign(Error("Sharing changed"), { status: 409 });
  const cache = createSharingAccess(session(), {
    request: (_url, options) => {
      calls++;
      if (options.method === "POST") throw conflict;
      return ledger(calls === 1 ? 1 : 2);
    },
  });
  await cache.read();
  await assert.rejects(cache.mutate({ action: "invite" }, "invite"), conflict);
  assert.equal(cache.getSnapshot().value.access.revision, 2);
  assert.equal(cache.getSnapshot().error, conflict);
  assert.equal(cache.getSnapshot().busy, null);
  assert.equal(calls, 3);
});

test("a company-proof refusal keeps the ledger and reloads its proof state", async () => {
  let calls = 0;
  const refused = Object.assign(Error("Your anaconda.com email verification expired."), {
    status: 403,
    code: "company_email_proof_required",
  });
  const cache = createSharingAccess(session(), {
    request: (_url, options) => {
      calls++;
      if (options.method === "POST") throw refused;
      return {
        ...ledger(),
        domainOptions: calls === 1 ? ["anaconda.com"] : [],
        domainProof: { "anaconda.com": calls === 1 ? "verified" : "expired" },
      };
    },
  });
  await cache.read();
  await assert.rejects(
    cache.mutate({ action: "set_domain_view", domain: "anaconda.com" }, "domain-view"),
    refused,
  );
  assert.equal(calls, 3);
  assert.deepEqual(cache.getSnapshot().value.domainProof, { "anaconda.com": "expired" });
  assert.equal(cache.getSnapshot().error, null);
  assert.equal(cache.getSnapshot().busy, null);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} clears cached private access and refresh can recover`, async () => {
    let failure = false;
    const cache = createSharingAccess(session(), {
      request: () => {
        if (failure) throw Object.assign(Error("Access changed"), { status });
        return ledger();
      },
    });
    await cache.read();
    failure = true;
    await assert.rejects(cache.read({ force: true }), { status });
    assert.equal(cache.getSnapshot().value, null);
    assert.equal(cache.getSnapshot().refreshing, false);
    failure = false;
    await cache.read();
    assert.equal(cache.getSnapshot().error, null);
    assert.ok(cache.getSnapshot().value);
  });
}

test("a transient refresh error retains the ledger and retries without waiting for TTL", async () => {
  let calls = 0;
  const cache = createSharingAccess(session(), {
    request: () => {
      if (++calls === 2) throw Object.assign(Error("Offline"), { code: "NETWORK_ERROR" });
      return ledger(calls);
    },
  });
  await cache.read();
  await assert.rejects(cache.read({ force: true }), /Offline/);
  assert.equal(cache.getSnapshot().value.access.revision, 1);
  await cache.read();
  assert.equal(cache.getSnapshot().value.access.revision, 3);
});

test("Page/account resources stay separate, including ignored-abort late responses", async () => {
  const delayed = deferred(),
    original = session();
  const old = createSharingAccess(original, { request: () => delayed.promise });
  const read = old.read();
  await tick();
  old.dispose();
  const other = createSharingAccess(session("page-b", "account-b"), {
    request: (url) => {
      assert.equal(url, "/api/access?page=page-b");
      return ledger(8, "account-b");
    },
  });
  await other.read();
  delayed.resolve(ledger());
  await read;
  assert.equal(old.getSnapshot().value, null);
  assert.equal(other.getSnapshot().value.owner.principal, "account-b");
});

test("late completion is discarded if the original session changes account or loses access", async () => {
  for (const change of [
    (value) => {
      value.identity = { principal: "account-b" };
    },
    (value) => {
      value.pageId = "page-b";
    },
    (value) => {
      value.authRequired = true;
    },
    (value) => {
      value.accessDenied = true;
    },
  ]) {
    const response = deferred(),
      current = session();
    const cache = createSharingAccess(current, { request: () => response.promise });
    const read = cache.read();
    await tick();
    change(current);
    response.resolve(ledger());
    await read;
    assert.equal(cache.getSnapshot().value, null);
    assert.equal(cache.getSnapshot().refreshing, false);
  }
});

test("a changed browser cookie cannot install another owner's ledger", async () => {
  const cache = createSharingAccess(session(), { request: () => ledger(1, "account-b") });
  await assert.rejects(cache.read(), { status: 401 });
  assert.equal(cache.getSnapshot().value, null);
});

test("local drafts and unavailable sessions do not preload or mutate sharing", async () => {
  for (const props of [
    { authRequired: true },
    { accessDenied: true },
    { accessReloadRequired: true },
    { localPage: { registered: false } },
    { alive: false },
  ]) {
    const value = { ...session(), ...props };
    const cache = createSharingAccess(value, { request: () => assert.fail("No request expected") });
    assert.equal(sharingAvailable(value), false);
    assert.equal(await cache.read(), null);
    assert.equal(await cache.mutate({}, "invite"), null);
  }
});

test("permission downgrade hides management data on revalidation and forbids writes", async () => {
  const value = session();
  let calls = 0;
  const cache = createSharingAccess(value, {
    request: () => (++calls === 1 ? ledger() : { access: { canManageAccess: false, revision: 2 } }),
  });
  await cache.read();
  value.canManageAccess = false;
  cache.invalidate();
  await cache.read();
  assert.equal(cache.getSnapshot().value.owner, undefined);
  assert.equal(await cache.mutate({}, "invite"), null);
  assert.equal(calls, 2);
});

test("effect cleanup/restart cancels the old preload without poisoning its successor", async () => {
  const old = deferred();
  let calls = 0;
  const cache = createSharingAccess(session(), {
    request: () => (++calls === 1 ? old.promise : ledger(2)),
  });
  const read = cache.read();
  await tick();
  cache.dispose();
  cache.activate();
  await cache.read();
  old.resolve(ledger());
  await read;
  assert.equal(cache.getSnapshot().value.access.revision, 2);
});
