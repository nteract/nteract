import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker, { Catalog } from "./index.mjs";
import { listAll } from "./catalog.mjs";
import {
  DEFAULT_PAGE_QUOTA,
  MAX_PAGE_QUOTA,
  defaultPageQuota,
  migrateQuotaRules,
  normalizeRuleMatch,
  pageQuotaBounds,
  quotaRefusal,
  resetPageQuotaCache,
  resolvePageQuota,
} from "./page-quota.mjs";

const now = 1_800_000_000_000;
const namespace = "user:anaconda";
const sessionEnv = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid",
  NOTEBOOK_CLOUD_APP_SESSION_SECRET: "quota-proof-fixture-secret-".repeat(2),
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: namespace,
};

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    if (Array.isArray(key))
      return key.map((name) => this.values.delete(name)).filter(Boolean).length;
    return this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "", startAfter, limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([key, value]) => [key, structuredClone(value)]),
    );
  }
}

/** A D1 with the quota schema and `rules` as [kind, value, limit] rows. */
async function rulesDb(t, rules = []) {
  const db = sqliteD1(t, "pages-quota-").open();
  await migrateQuotaRules(db);
  for (const [kind, value, limit, updatedAt = 1] of rules)
    db.sqlite
      .prepare(
        "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(kind, value, limit, updatedAt);
  return db;
}

const apiKeyIdentity = (email, principal = "user:anaconda:api") => ({
  principal,
  credentialKind: "api-key",
  canWrite: true,
  expiresAt: now + 60_000,
  ...(email !== undefined && { verifiedEmail: email }),
});

/** A browser identity whose proof binds `email`, as auth.mjs builds it. */
async function browserIdentity(
  email,
  { verified = true, principal = `${namespace}:browser` } = {},
) {
  const session = await createServerAppSession(
    sessionEnv,
    {
      principal,
      metadata: { provider: "oidc", principalNamespace: namespace, email, emailVerified: verified },
    },
    "quota-session",
    now / 1000 + 60,
    now / 1000,
  );
  return {
    principal,
    credentialKind: "oidc",
    canWrite: true,
    expiresAt: now + 60_000,
    emailProof: {
      provider: "app-session",
      principalNamespace: namespace,
      identityVerifiedAt: session.identityVerifiedAt,
      verifiedEmailBinding: session.verifiedEmailBinding,
      verifiedEmailDomainBinding: session.verifiedEmailDomainBinding,
    },
  };
}

test("the target default is 250 unless PAGES_DEFAULT_PAGE_QUOTA sets another", () => {
  assert.equal(DEFAULT_PAGE_QUOTA, 250);
  assert.equal(defaultPageQuota({}), 250);
  assert.equal(defaultPageQuota({ PAGES_DEFAULT_PAGE_QUOTA: "1000" }), 1000);
  assert.equal(defaultPageQuota({ PAGES_DEFAULT_PAGE_QUOTA: " 0 " }), 0);
  for (const malformed of ["-1", "1e3", "ten", "12.5", String(MAX_PAGE_QUOTA + 1)])
    assert.equal(defaultPageQuota({ PAGES_DEFAULT_PAGE_QUOTA: malformed }), 250, malformed);
});

test("rule values normalize as invite emails and lowercase domains", () => {
  assert.equal(normalizeRuleMatch("email", " RGBKRK@Gmail.com "), "rgbkrk@gmail.com");
  assert.equal(normalizeRuleMatch("domain", " Anaconda.COM "), "anaconda.com");
  for (const [kind, value] of [
    ["email", "not an email"],
    ["domain", "@anaconda.com"],
    ["domain", "anaconda..com"],
    ["domain", "*.anaconda.com"],
    ["phone", "anaconda.com"],
  ])
    assert.equal(normalizeRuleMatch(kind, value), null, `${kind} ${value}`);
});

test("the table refuses unknown kinds and negative limits", async (t) => {
  const db = await rulesDb(t);
  const insert = (kind, limit) =>
    db.sqlite
      .prepare(
        "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES (?, 'x.com', ?, 1)",
      )
      .run(kind, limit);
  assert.throws(() => insert("phone", 10), /CHECK/);
  assert.throws(() => insert("domain", -1), /CHECK/);
  insert("domain", 0);
  // Migrating again changes nothing.
  await migrateQuotaRules(db);
  assert.deepEqual(db.rows("SELECT version, name FROM pages_quota_schema"), [
    { version: 1, name: "quota_rules" },
  ]);
});

test("an exact verified email beats its domain, which beats the default", async (t) => {
  const db = await rulesDb(t, [
    ["domain", "anaconda.com", 500],
    ["email", "rgbkrk@gmail.com", 1000],
    ["email", "lead@anaconda.com", 2000],
  ]);
  const env = { DB: db };
  const cases = [
    ["rgbkrk@gmail.com", { limit: 1000, source: "email" }],
    ["lead@anaconda.com", { limit: 2000, source: "email" }],
    ["someone@anaconda.com", { limit: 500, source: "domain" }],
    // The domain compares lowercased, however the provider spelled it.
    [" Someone@ANACONDA.com ", { limit: 500, source: "domain" }],
    ["RGBKRK@GMAIL.COM", { limit: 1000, source: "email" }],
    ["someone@gmail.com", { limit: 250, source: "default" }],
    // Only the exact domain matches: no subdomains or suffixes.
    ["someone@eng.anaconda.com", { limit: 250, source: "default" }],
    ["someone@notanaconda.com", { limit: 250, source: "default" }],
  ];
  for (const [email, expected] of cases)
    assert.deepEqual(await resolvePageQuota(env, apiKeyIdentity(email), now), expected, email);
});

test("browser and OAuth proofs match rules through their verified-email bindings", async (t) => {
  const db = await rulesDb(t, [
    ["domain", "anaconda.com", 500],
    ["email", "rgbkrk@gmail.com", 1000],
  ]);
  const env = { ...sessionEnv, DB: db };
  const resolve = async (email, options) =>
    resolvePageQuota(env, await browserIdentity(email, options), now);
  assert.deepEqual(await resolve("rgbkrk@gmail.com"), { limit: 1000, source: "email" });
  assert.deepEqual(await resolve("Person@Anaconda.com"), { limit: 500, source: "domain" });
  assert.deepEqual(await resolve("person@gmail.com"), { limit: 250, source: "default" });
  // The provider didn't verify this email, so the session binds nothing.
  assert.deepEqual(await resolve("rgbkrk@gmail.com", { verified: false }), {
    limit: 250,
    source: "default",
  });
  // An OAuth grant carries the same proof.
  const oauth = { ...(await browserIdentity("person@anaconda.com")), credentialKind: "oauth" };
  assert.deepEqual(await resolvePageQuota(env, oauth, now), { limit: 500, source: "domain" });
  // A proof bound to one principal proves nothing for another.
  const borrowed = {
    ...(await browserIdentity("rgbkrk@gmail.com")),
    principal: `${namespace}:other`,
  };
  assert.deepEqual(await resolvePageQuota(env, borrowed, now), { limit: 250, source: "default" });
});

test("without server-verified email the default applies and D1 is never read", async (t) => {
  const db = await rulesDb(t, [["email", "rgbkrk@gmail.com", 1000]]);
  const env = { ...sessionEnv, DB: db };
  const before = db.calls;
  for (const identity of [
    // whoami returned no verified email.
    apiKeyIdentity(undefined),
    // Only an API key's identity carries verifiedEmail; anything else
    // claiming one is ignored.
    { ...apiKeyIdentity("rgbkrk@gmail.com"), credentialKind: "oidc" },
    { ...apiKeyIdentity("rgbkrk@gmail.com"), credentialKind: "oauth" },
    // A proof without a binding, or from another provider.
    {
      principal: `${namespace}:x`,
      credentialKind: "oidc",
      emailProof: { provider: "app-session", identityVerifiedAt: now / 1000 },
    },
    {
      principal: `${namespace}:x`,
      credentialKind: "oidc",
      emailProof: { provider: "elsewhere", identityVerifiedAt: 1, verifiedEmailBinding: "x" },
    },
    undefined,
  ])
    assert.deepEqual(await resolvePageQuota(env, identity, now), { limit: 250, source: "default" });
  assert.equal(db.calls, before);
});

test("a rule replaces the default, so 0 turns creation off and a lower rule lowers it", async (t) => {
  const db = await rulesDb(t, [
    ["email", "paused@example.com", 0],
    ["domain", "small.example", 5],
  ]);
  const env = { DB: db, PAGES_DEFAULT_PAGE_QUOTA: "1000" };
  assert.deepEqual(await resolvePageQuota(env, apiKeyIdentity("paused@example.com"), now), {
    limit: 0,
    source: "email",
  });
  assert.deepEqual(await resolvePageQuota(env, apiKeyIdentity("a@small.example"), now), {
    limit: 5,
    source: "domain",
  });
  assert.deepEqual(await resolvePageQuota(env, apiKeyIdentity("a@other.example"), now), {
    limit: 1000,
    source: "default",
  });
});

test("rules are read once per snapshot, and a change shows after it expires", async (t) => {
  const db = await rulesDb(t, [["domain", "anaconda.com", 500]]);
  const env = { DB: db };
  const identity = apiKeyIdentity("a@anaconda.com");
  assert.equal((await resolvePageQuota(env, identity, now)).limit, 500);
  const reads = db.calls;
  db.sqlite.prepare("UPDATE pages_quota_rules SET page_limit = 600").run();
  for (let index = 0; index < 5; index++)
    assert.equal((await resolvePageQuota(env, identity, now + index)).limit, 500);
  assert.equal(db.calls, reads, "a cached snapshot reads nothing");
  assert.equal((await resolvePageQuota(env, identity, now + pageQuotaBounds.rulesMs)).limit, 600);
});

/** Await `promise` while advancing mocked time `step` ms at a time, at most
 * `limit` ms. Real I/O turns run between steps, so D1 calls still settle. */
async function advance(t, promise, { step = 100, limit = 60_000 } = {}) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let elapsed = 0; !settled && elapsed <= limit; elapsed += step) {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(step);
  }
  return promise;
}

test("when D1 fails or hangs every account gets the default, and the failure is logged", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  for (const mode of ["fail", "hang"]) {
    const db = await rulesDb(t, [["email", "rgbkrk@gmail.com", 1000]]);
    const env = { DB: db, PAGES_DEFAULT_PAGE_QUOTA: "300" };
    const identity = apiKeyIdentity("rgbkrk@gmail.com");
    // The schema is ready before the outage starts.
    assert.equal((await resolvePageQuota(env, identity, Date.now())).limit, 1000);
    resetPageQuotaCache(db);
    db.mode = mode;
    const started = Date.now();
    assert.deepEqual(await advance(t, resolvePageQuota(env, identity, Date.now())), {
      limit: 300,
      source: "default",
    });
    // A hung read gives up at its own deadline.
    assert.ok(Date.now() - started <= pageQuotaBounds.readMs, mode);
    // The failure is cached briefly, so an outage costs one read per window.
    const calls = db.calls;
    assert.equal((await resolvePageQuota(env, identity, Date.now())).limit, 300);
    assert.equal(db.calls, calls);
    // Once D1 answers again, the next window reads the rules.
    db.mode = "ok";
    t.mock.timers.tick(pageQuotaBounds.failureMs);
    assert.equal((await resolvePageQuota(env, identity, Date.now())).limit, 1000, mode);
  }
  assert.ok(errors.mock.callCount() >= 2, "each outage is logged");
  // A missing binding is the default too, never unlimited.
  assert.deepEqual(await resolvePageQuota({}, apiKeyIdentity("rgbkrk@gmail.com"), now), {
    limit: 250,
    source: "default",
  });
});

test("a schema setup that hangs is abandoned, and a 0 rule applies once D1 recovers", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  // A fresh D1: the first read must create the schema, and it hangs.
  const db = sqliteD1(t, "pages-quota-").open();
  db.mode = "hang";
  const env = { DB: db };
  const identity = apiKeyIdentity("paused@example.com");
  assert.deepEqual(await advance(t, resolvePageQuota(env, identity, Date.now())), {
    limit: 250,
    source: "default",
  });
  // D1 recovers and an operator pauses the account.
  db.mode = "ok";
  await migrateQuotaRules(db);
  db.sqlite
    .prepare(
      "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('email', 'paused@example.com', 0, 1)",
    )
    .run();
  // The failed read is cached for its window, then the next refresh starts a
  // new setup attempt instead of waiting behind the hung one.
  t.mock.timers.tick(pageQuotaBounds.failureMs);
  assert.deepEqual(await advance(t, resolvePageQuota(env, identity, Date.now())), {
    limit: 0,
    source: "email",
  });
});

test("refusals carry their code, limit and count, and the alpha wording", () => {
  assert.deepEqual(quotaRefusal("page/", { limit: 1000, count: 1000 }), {
    status: 409,
    body: {
      error: "This alpha release allows 1,000 Pages per account.",
      code: "page_quota_exceeded",
      limit: 1000,
      count: 1000,
    },
  });
  assert.deepEqual(quotaRefusal("trash/", { limit: 250, count: 250 }).body, {
    error:
      "This alpha release allows 250 Pages in Trash per account. Permanently delete Pages from Trash before moving more Pages there.",
    code: "trash_capacity",
    limit: 250,
    count: 250,
  });
  assert.equal(
    quotaRefusal("page/", { limit: 0, count: 3 }).body.error,
    "Creating Pages is turned off for this account.",
  );
  assert.equal(
    quotaRefusal("page/", { limit: 1, count: 1 }).body.error,
    "This alpha release allows 1 Page per account.",
  );
});

/** The gateway in front of one Catalog whose Pages accept every creation. */
async function gateway(t, { rules = [], env: extra = {} } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const db = await rulesDb(t, rules);
  const storage = new Storage();
  const forwarded = [];
  const env = {
    ...auth.env,
    DB: db,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid",
    ...extra,
    PAGES: {
      getByName: (id) => ({
        fetch: async (request) => {
          const body = await request.json();
          return Response.json({ page_id: id, title: body.title, heads: ["a".repeat(64)] });
        },
      }),
    },
  };
  const catalog = new Catalog(
    { id: { name: `user:anaconda-fixture:${auth.subject}` }, storage },
    env,
  );
  env.CATALOGS = {
    getByName: () => ({
      fetch: async (request, init) => {
        forwarded.push(await request.clone().json());
        return catalog.fetch(request, init);
      },
    }),
  };
  const token = auth.apiKey();
  const call = async (operation, args = {}) => {
    const response = await worker.fetch(
      new Request("https://pages.invalid/api/tools", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "Quota test" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  const mcp = async (name, args = {}) => {
    const response = await worker.fetch(
      new Request("https://pages.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    const { result } = await response.json();
    return result;
  };
  let keys = 0;
  const create = (args = {}) =>
    call("create_page", { title: "Quota", idempotency_key: `quota-key-${++keys}`, ...args });
  return { auth, db, env, storage, catalog, forwarded, call, mcp, create };
}

test("the gateway forwards the resolved limit beside the caller's arguments", async (t) => {
  // The fixture's whoami verifies fixture@example.invalid.
  const g = await gateway(t, { rules: [["domain", "example.invalid", 2]] });
  // A caller-supplied limit or email is just an unknown argument.
  const first = await g.create({ page_limit: 100_000, email: "rgbkrk@gmail.com" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(g.forwarded.at(-1).page_limit, 2);
  assert.equal(g.forwarded.at(-1).arguments.page_limit, 100_000);
  assert.equal((await g.create()).status, 200);
  const refused = await g.create();
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: "This alpha release allows 2 Pages per account.",
    code: "page_quota_exceeded",
    limit: 2,
    count: 2,
  });
  assert.equal((await listAll(g.storage, "page/")).size, 2);
});

test("list_pages reports the caller's own quota", async (t) => {
  const g = await gateway(t, { env: { PAGES_DEFAULT_PAGE_QUOTA: "10" } });
  assert.deepEqual((await g.call("list_pages")).body.quota, {
    limit: 10,
    count: 0,
    trash_count: 0,
  });
  await g.create();
  await g.create();
  const listed = await g.call("list_pages");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.quota, { limit: 10, count: 2, trash_count: 0 });
  // A filtered listing reports the same account-wide numbers.
  assert.deepEqual(
    (await g.call("list_pages", { query: "nothing" })).body.quota,
    listed.body.quota,
  );
});

test("an MCP refusal at the limit carries the code in structuredContent", async (t) => {
  const g = await gateway(t, { rules: [["email", "fixture@example.invalid", 1]] });
  assert.equal((await g.create()).status, 200);
  const result = await g.mcp("create_page", { title: "Over", idempotency_key: "mcp-over-limit" });
  assert.equal(result.isError, true);
  const expected = {
    error: "This alpha release allows 1 Page per account.",
    code: "page_quota_exceeded",
    limit: 1,
    count: 1,
  };
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  assert.deepEqual(result.structuredContent, expected);
});

test("a 0 rule refuses creates and restores but keeps existing Pages", async (t) => {
  const g = await gateway(t);
  const kept = (await g.create()).body.page_id;
  g.db.sqlite
    .prepare(
      "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('email', 'fixture@example.invalid', 0, 2)",
    )
    .run();
  const t0 = Date.now();
  t.mock.method(Date, "now", () => t0 + pageQuotaBounds.rulesMs);
  const refused = await g.create();
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: "Creating Pages is turned off for this account.",
    code: "page_quota_exceeded",
    limit: 0,
    count: 1,
  });
  const listed = await g.call("list_pages");
  assert.deepEqual(
    listed.body.pages.map((page) => page.page_id),
    [kept],
  );
  assert.deepEqual(listed.body.quota, { limit: 0, count: 1, trash_count: 0 });
});

test("concurrent creates in the serial queue stop exactly at the limit", async (t) => {
  const g = await gateway(t, { env: { PAGES_DEFAULT_PAGE_QUOTA: "7" } });
  const results = await Promise.all(Array.from({ length: 20 }, () => g.create()));
  assert.equal(results.filter((result) => result.status === 200).length, 7);
  for (const result of results.filter((result) => result.status !== 200))
    assert.equal(result.body.code, "page_quota_exceeded");
  assert.equal((await listAll(g.storage, "page/")).size, 7);
  assert.equal(await g.storage.get("host/count/active"), 7);
});

test("a Catalog with more than 100 uncounted entries counts them all before deciding", async (t) => {
  const g = await gateway(t, { env: { PAGES_DEFAULT_PAGE_QUOTA: "150" } });
  // Entries a build without stored counts wrote.
  for (let index = 0; index < 149; index++)
    g.storage.values.set(`page/fill-${String(index).padStart(3, "0")}`, {
      page_id: `fill-${index}`,
    });
  for (let index = 0; index < 120; index++)
    g.storage.values.set(`trash/fill-${String(index).padStart(3, "0")}`, {
      page_id: `trash-${index}`,
      state: "trashed",
    });
  assert.equal(await g.storage.get("host/count/active"), undefined);
  assert.equal((await g.create()).status, 200);
  assert.equal(await g.storage.get("host/count/active"), 150);
  assert.equal(await g.storage.get("host/count/trash"), 120);
  const refused = await g.create();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.count, 150);
});

test("a listing repairs stored counts that disagree with storage", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const g = await gateway(t, { env: { PAGES_DEFAULT_PAGE_QUOTA: "5" } });
  for (let index = 0; index < 3; index++) await g.create();
  // An older build wrote two entries without touching the counts.
  g.storage.values.set("page/old-a", { page_id: "old-a" });
  g.storage.values.set("page/old-b", { page_id: "old-b" });
  assert.equal(await g.storage.get("host/count/active"), 3);
  // A fresh Catalog object reads the stored counts, as after eviction.
  g.catalog.counted = undefined;
  const listed = await g.call("list_pages");
  assert.equal(listed.body.quota.count, 5);
  assert.equal(await g.storage.get("host/count/active"), 5);
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(warnings.mock.calls[0].arguments[0], /catalog\.count_repaired/);
  assert.doesNotMatch(warnings.mock.calls[0].arguments[0], /fixture/);
  assert.equal((await g.create()).status, 409);
  // Agreeing counts are left alone.
  await g.call("list_pages");
  assert.equal(warnings.mock.callCount(), 1);
});

test("listAll reads past any page size", async () => {
  const raw = new Storage();
  for (let index = 0; index < 1234; index++)
    raw.values.set(`page/${String(index).padStart(5, "0")}`, index);
  raw.values.set("pagez", "outside");
  assert.equal((await listAll(raw, "page/")).size, 1234);
  assert.equal((await listAll(raw, "page/", 7)).size, 1234);
  assert.equal((await listAll(raw, "page/", 1234)).size, 1234);
});
