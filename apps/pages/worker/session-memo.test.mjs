import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  oidcDatabase,
  randomSecret,
  readServerAppSession,
  sealServerSecret,
  serverSessionContext,
  serverSessionId,
  SERVER_SESSION_COOKIE,
} from "@cloud/oidc-session-store.ts";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker from "./index.mjs";
import { gatewayFixture } from "./gateway-fixture.mjs";
import {
  forgetPrincipalSessions,
  forgetServerAppSession,
  MAX_REMEMBERED,
  rememberedServerAppSession,
  SESSION_MEMO_MS,
} from "./session-memo.mjs";

const origin = "https://pages-session-memo.example";
const person = "user:anaconda:person";
const other = "user:anaconda:other";
const SELECT = /^\s*SELECT \* FROM oidc_server_sessions/;

/** An env over its own D1, counting session SELECTs. Each test gets a new D1
 * binding, so it gets its own memo. */
async function fixture(t, secret = "session-memo-fixture-".repeat(3)) {
  const db = sqliteD1(t).open();
  const counted = {
    selects: 0,
    fail: false,
    onSelect: null,
    prepare(sql) {
      if (SELECT.test(sql)) {
        counted.selects++;
        counted.onSelect?.();
        if (counted.fail) throw new Error("D1 unavailable");
      }
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
  };
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: secret,
    DB: counted,
  };
  await oidcDatabase(env);
  return { env, db: counted };
}

/** A session row for `principal`, whose access window ends `seconds` after
 * `now` (whole seconds). */
async function signIn(env, { principal = person, now, seconds = 3600, name = "Example" } = {}) {
  const token = randomSecret(),
    id = await serverSessionId(env, token);
  const context = serverSessionContext(env, origin);
  const app = await createServerAppSession(
    env,
    {
      principal,
      metadata: { provider: "oidc", principalNamespace: "user:anaconda", displayName: name },
    },
    id,
    now + seconds,
    now,
  );
  await env.DB.prepare(
    "INSERT INTO oidc_server_sessions (id,context,session_json,sealed,access_expires_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      context,
      JSON.stringify(app),
      await sealServerSecret(env, {}, `session:${id}:${context}`),
      now + seconds,
      now + 7200,
      now + 86400,
    )
    .run();
  return { cookie: `${SERVER_SESSION_COOKIE}=${token}`, token, id };
}

const request = (cookie, path = "/") =>
  new Request(origin + path, { headers: cookie ? { cookie } : {} });
/** A whole second near the real clock, so rows and virtual time agree. */
const second = () => Math.floor(Date.now() / 1000);
const read = (env, cookie, nowMs) => rememberedServerAppSession(env, request(cookie), nowMs);

test("the memo lasts 10 seconds and has a fixed size", () => {
  assert.equal(SESSION_MEMO_MS, 10_000);
  assert.equal(MAX_REMEMBERED, 1000);
});

test("a settled read answers repeats for 10 seconds, then reads D1 again", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  const fresh = await read(env, login.cookie, now * 1000);
  assert.equal(fresh.principal, person);
  assert.equal(db.selects, 1);
  assert.deepEqual(await read(env, login.cookie, now * 1000 + SESSION_MEMO_MS - 1), fresh);
  assert.equal(db.selects, 1);
  assert.deepEqual(await read(env, login.cookie, now * 1000 + SESSION_MEMO_MS), fresh);
  assert.equal(db.selects, 2);
});

test("a hit is the same value as a fresh read and no caller can change it", async (t) => {
  const { env } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  const first = await read(env, login.cookie, now * 1000);
  const hit = await read(env, login.cookie, now * 1000 + 1);
  assert.deepEqual(hit, await readServerAppSession(env, request(login.cookie), now));
  assert.notEqual(hit, first);
  hit.principal = "user:anaconda:intruder";
  first.expiresAt = now + 999_999;
  const again = await read(env, login.cookie, now * 1000 + 2);
  assert.equal(again.principal, person);
  assert.deepEqual(again, await readServerAppSession(env, request(login.cookie), now));
});

test("the key is the verified session, not the cookie string", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  await read(env, login.cookie, now * 1000);
  // The same token among other cookies is the same session.
  const withOthers = `theme=dark; ${login.cookie}; other=1`;
  assert.equal((await read(env, withOthers, now * 1000 + 1)).principal, person);
  assert.equal(db.selects, 1);
});

test("a forged or malformed cookie never reaches the memo", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  await read(env, login.cookie, now * 1000);
  const forged = [
    `${SERVER_SESSION_COOKIE}=${"x".repeat(43)}`,
    `${SERVER_SESSION_COOKIE}=${randomSecret()}`,
    // The token's shape, almost: one character off.
    `${SERVER_SESSION_COOKIE}=${login.token.slice(0, 42)}${login.token[42] === "A" ? "B" : "A"}`,
  ];
  for (const cookie of forged) {
    assert.equal(await read(env, cookie, now * 1000 + 1), null);
    assert.equal(await read(env, cookie, now * 1000 + 2), null);
  }
  // Each well-shaped forgery reads D1 every time; none was stored.
  assert.equal(db.selects, 1 + forged.length * 2);
  // A malformed token is refused before D1, every time.
  for (const cookie of [
    `${SERVER_SESSION_COOKIE}=short`,
    `${SERVER_SESSION_COOKIE}=${login.token}!`,
    `${login.cookie}; ${login.cookie}`,
    "",
  ])
    assert.equal(await read(env, cookie, now * 1000 + 3), null);
  assert.equal(db.selects, 1 + forged.length * 2);
});

test("missing, expired and failed reads are never stored", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const unknown = `${SERVER_SESSION_COOKIE}=${randomSecret()}`;
  assert.equal(await read(env, unknown, now * 1000), null);
  assert.equal(await read(env, unknown, now * 1000 + 1), null);
  assert.equal(db.selects, 2);

  const expired = await signIn(env, { now: now - 100, seconds: 50 });
  assert.equal(await read(env, expired.cookie, now * 1000), null);
  assert.equal(await read(env, expired.cookie, now * 1000 + 1), null);
  assert.equal(db.selects, 4);

  const login = await signIn(env, { now });
  db.fail = true;
  await assert.rejects(read(env, login.cookie, now * 1000), /D1 unavailable/);
  db.fail = false;
  assert.equal((await read(env, login.cookie, now * 1000 + 1)).principal, person);
  assert.equal(db.selects, 6);
  await read(env, login.cookie, now * 1000 + 2);
  assert.equal(db.selects, 6);
});

test("concurrent misses each read D1; no pending read is shared", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  const [a, b] = await Promise.all([
    read(env, login.cookie, now * 1000),
    read(env, login.cookie, now * 1000),
  ]);
  assert.deepEqual(a, b);
  assert.equal(db.selects, 2);
  await read(env, login.cookie, now * 1000 + 1);
  assert.equal(db.selects, 2);
});

test("a hit never outlives the session's own expiry", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now, seconds: 3 });
  assert.equal((await read(env, login.cookie, now * 1000)).expiresAt, now + 3);
  assert.equal((await read(env, login.cookie, now * 1000 + 2999)).principal, person);
  assert.equal(db.selects, 1);
  assert.equal(await read(env, login.cookie, now * 1000 + 3000), null);
  assert.equal(db.selects, 2);
});

test("a session revoked in D1 alone stops being accepted within 10 seconds", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  await read(env, login.cookie, now * 1000);
  await env.DB.prepare("DELETE FROM oidc_server_sessions WHERE id = ?").bind(login.id).run();
  // Another isolate's sign-out: this one still answers from memory...
  assert.equal((await read(env, login.cookie, now * 1000 + 9_999)).principal, person);
  // ...until the entry ends.
  assert.equal(await read(env, login.cookie, now * 1000 + SESSION_MEMO_MS), null);
  assert.equal(await read(env, login.cookie, now * 1000 + SESSION_MEMO_MS + 1), null);
  assert.equal(db.selects, 3);
});

test("two principals never see each other's session", async (t) => {
  const { env } = await fixture(t);
  const now = second();
  const mine = await signIn(env, { now, principal: person, name: "Mine" });
  const theirs = await signIn(env, { now, principal: other, name: "Theirs" });
  for (const at of [0, 1, 2]) {
    const a = await read(env, mine.cookie, now * 1000 + at);
    const b = await read(env, theirs.cookie, now * 1000 + at);
    assert.equal(a.principal, person);
    assert.equal(a.displayName, "Mine");
    assert.equal(b.principal, other);
    assert.equal(b.displayName, "Theirs");
  }
});

test("a session read under another key or deployment is a different entry", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  await read(env, login.cookie, now * 1000);
  const rotated = { ...env, NOTEBOOK_CLOUD_APP_SESSION_SECRET: "another-session-key-".repeat(3) };
  assert.equal(await read(rotated, login.cookie, now * 1000 + 1), null);
  const elsewhere = { ...env, NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "another-client" };
  assert.equal(await read(elsewhere, login.cookie, now * 1000 + 2), null);
  assert.equal(db.selects, 3);
});

test("signing out forgets the session in this isolate", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  const kept = await signIn(env, { now });
  await read(env, login.cookie, now * 1000);
  await read(env, kept.cookie, now * 1000);
  await env.DB.prepare("DELETE FROM oidc_server_sessions WHERE id = ?").bind(login.id).run();
  await forgetServerAppSession(env, request(login.cookie));
  assert.equal(await read(env, login.cookie, now * 1000 + 1), null);
  assert.equal(db.selects, 3);
  // Another browser of the same account is a different session.
  assert.equal((await read(env, kept.cookie, now * 1000 + 1)).principal, person);
  assert.equal(db.selects, 3);
});

test("signing out everywhere forgets every session of that account only", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const here = await signIn(env, { now });
  const laptop = await signIn(env, { now });
  const theirs = await signIn(env, { now, principal: other });
  for (const login of [here, laptop, theirs]) await read(env, login.cookie, now * 1000);
  assert.equal(db.selects, 3);
  forgetPrincipalSessions(env, person);
  await read(env, here.cookie, now * 1000 + 1);
  await read(env, laptop.cookie, now * 1000 + 1);
  assert.equal(db.selects, 5);
  await read(env, theirs.cookie, now * 1000 + 1);
  assert.equal(db.selects, 5);
});

test("a read in flight when a forget runs is not stored", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  // The sign-out lands while this read's SELECT is out.
  db.onSelect = () => {
    db.onSelect = null;
    forgetPrincipalSessions(env, person);
  };
  assert.equal((await read(env, login.cookie, now * 1000)).principal, person);
  await read(env, login.cookie, now * 1000 + 1);
  assert.equal(db.selects, 2);
});

test("the memo holds at most MAX_REMEMBERED sessions, oldest out first", async (t) => {
  const { env, db } = await fixture(t);
  const now = second();
  const logins = [];
  for (let i = 0; i <= MAX_REMEMBERED; i++) logins.push(await signIn(env, { now }));
  for (const login of logins) await read(env, login.cookie, now * 1000);
  assert.equal(db.selects, MAX_REMEMBERED + 1);
  await read(env, logins.at(-1).cookie, now * 1000 + 1);
  await read(env, logins[1].cookie, now * 1000 + 1);
  assert.equal(db.selects, MAX_REMEMBERED + 1);
  await read(env, logins[0].cookie, now * 1000 + 1);
  assert.equal(db.selects, MAX_REMEMBERED + 2);
});

// Routes, through the Worker's real clock.

const call = (env, path, { method = "GET", cookie } = {}) =>
  worker.fetch(
    new Request(origin + path, {
      method,
      headers: { ...(cookie && { cookie }), Origin: origin },
    }),
    env,
  );

test("POST /api/auth/logout ends the session at once in this isolate", async (t) => {
  const { env } = await fixture(t);
  const login = await signIn(env, { now: second() });
  assert.equal((await call(env, "/whoami", { cookie: login.cookie })).status, 200);
  assert.equal(
    (await call(env, "/api/auth/logout", { method: "POST", cookie: login.cookie })).status,
    200,
  );
  assert.equal((await call(env, "/whoami", { cookie: login.cookie })).status, 401);
});

test("POST /api/auth/logout-all ends every session of the account at once in this isolate", async (t) => {
  const { env } = await fixture(t);
  const now = second();
  const here = await signIn(env, { now });
  const laptop = await signIn(env, { now });
  const theirs = await signIn(env, { now, principal: other });
  for (const login of [here, laptop, theirs])
    assert.equal((await call(env, "/whoami", { cookie: login.cookie })).status, 200);
  const response = await call(env, "/api/auth/logout-all", { method: "POST", cookie: here.cookie });
  assert.equal(response.status, 200);
  assert.equal((await call(env, "/whoami", { cookie: here.cookie })).status, 401);
  assert.equal((await call(env, "/whoami", { cookie: laptop.cookie })).status, 401);
  assert.equal((await call(env, "/whoami", { cookie: theirs.cookie })).status, 200);
});

test("GET /api/auth/session reports the row as it is now", async (t) => {
  const { env } = await fixture(t);
  const now = second();
  const login = await signIn(env, { now });
  const before = await (await call(env, "/api/auth/session", { cookie: login.cookie })).json();
  assert.equal(before.expiresAt, (now + 3600) * 1000);
  // Another isolate renewed the session: the row now ends later.
  const row = await env.DB.prepare("SELECT session_json FROM oidc_server_sessions WHERE id = ?")
    .bind(login.id)
    .first();
  const renewed = { ...JSON.parse(row.session_json), expiresAt: now + 5000 };
  await env.DB.prepare(
    "UPDATE oidc_server_sessions SET session_json = ?, access_expires_at = ? WHERE id = ?",
  )
    .bind(JSON.stringify(renewed), now + 5000, login.id)
    .run();
  const after = await (await call(env, "/api/auth/session", { cookie: login.cookie })).json();
  assert.equal(after.expiresAt, (now + 5000) * 1000);
});

test("a gateway call that the Page host authenticates again reads the session once", async (t) => {
  const fixture = await gatewayFixture(t);
  const prepare = fixture.env.DB.prepare;
  let selects = 0;
  fixture.env.DB.prepare = (sql) => {
    if (SELECT.test(sql)) selects++;
    return prepare(sql);
  };
  const response = await worker.fetch(
    fixture.request({ headers: { cookie: fixture.cookie } }),
    fixture.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fixture.forwarded.length, 1, "the Page host authenticated the forwarded request");
  assert.equal(selects, 1);
});
