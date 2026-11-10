import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readServerAppSession, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { ServerSessionGrantRejected } from "@cloud/server-oidc.ts";
import { KiloUnavailable } from "./kilo-pairing-client.mjs";
import { startLocalKilo } from "../scripts/fixtures/local-kilo.mjs";
import { handleKiloSignIn, kiloSessionProvider, pairingTransition } from "./kilo-sign-in.mjs";

const origin = "http://127.0.0.1:9477";
const user = { id: "person:one", email: "person@example.test", name: "Example Person" };
const events = [
  "kilo_pending",
  "kilo_approved",
  "kilo_denied",
  "kilo_expired",
  "profile_read",
  "profile_refused",
  "profile_mismatch",
  "kilo_protocol_error",
  "deadline_passed",
];
const states = ["pending", "approved", "signed_in", "denied", "expired", "failed"];
class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: this.sqlite.prepare(sql).all(...values) }),
      run: async () => ({
        success: true,
        meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) },
      }),
    });
    return build();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map((statement) => statement.run());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
function fixture(t, kilo, extra = {}) {
  const env = {
    DB: new SqliteD1(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "kilo-session-fixture-secret-".repeat(3),
    PAGES_KILO_APP_URL: kilo.origin,
    ...extra,
  };
  const lines = [];
  const restore = t.mock.method(console, "info", (line) => lines.push(String(line)));
  t.after(async () => {
    restore.mock.restore();
    await kilo.close();
    env.DB.sqlite.close();
  });
  return { env, lines };
}
function request(path, { method = "GET", cookie, headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
}
function pairingCookie(response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-pages_kilo_pairing="));
}
function cookieValue(header) {
  return header.split(";", 1)[0];
}
async function begin(env, returnTo = "/pages") {
  const response = await handleKiloSignIn(
    request(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
      headers: { "cf-connecting-ip": "127.0.0.9" },
    }),
    env,
  );
  assert.equal(response.status, 303);
  return { response, cookie: cookieValue(pairingCookie(response)) };
}
async function poll(env, cookie, headers = {}) {
  const response = await handleKiloSignIn(
    request("/api/auth/pairing", {
      method: "POST",
      cookie,
      headers: { Origin: origin, ...headers },
    }),
    env,
  );
  return { response, body: await response.json() };
}
async function approve(kilo, pageResponse, account = user) {
  const page = await pageResponse.text();
  const code = page.match(/class="pairing-code"><strong>([^<]+)/)?.[1];
  assert.ok(code);
  assert.equal(await kilo.approve(code, account), true);
  return page;
}

test("pairingTransition accepts only the declared state and event combinations", () => {
  const valid = new Map([
    ["pending:kilo_pending", ["pending", "wait"]],
    ["pending:kilo_approved", ["approved", "persist_grant"]],
    ["pending:kilo_denied", ["denied", "delete"]],
    ["pending:kilo_expired", ["expired", "delete"]],
    ["pending:kilo_protocol_error", ["failed", "delete"]],
    ["pending:deadline_passed", ["expired", "delete"]],
    ["approved:profile_read", ["signed_in", "create_session"]],
    ["approved:profile_refused", ["failed", "delete"]],
    ["approved:profile_mismatch", ["failed", "delete"]],
    ["approved:kilo_protocol_error", ["failed", "delete"]],
    ["approved:deadline_passed", ["expired", "delete"]],
  ]);
  for (const state of states)
    for (const event of events) {
      const expected = valid.get(`${state}:${event}`);
      if (!expected) assert.throws(() => pairingTransition(state, event));
      else assert.deepEqual(Object.values(pairingTransition(state, event)), expected);
    }
});

test("browser pairing persists the grant before profile lookup and issues a no-proof session", async (t) => {
  const kilo = await startLocalKilo();
  const { env, lines } = fixture(t, kilo);
  const secrets = [user.email, user.id];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const response = await originalFetch(input, init);
    const path = new URL(input).pathname;
    if (["/api/device-auth/codes", "/api/device-auth/token"].includes(path)) {
      const body = await response.clone().json();
      for (const value of [
        body.device_code,
        body.token,
        body.refreshToken,
        body.userEmail,
        body.userId,
      ])
        if (typeof value === "string") secrets.push(value);
    }
    return response;
  });
  const started = await begin(env);
  assert.match(started.response.headers.get("location"), /\/sign-in$/);
  const pageResponse = await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env);
  const page = await pageResponse.text();
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.match(page, /Pages uses your Kilo account/);
  assert.match(page, /Approve in Kilo/);
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /kilo-pairing\.js/);
  assert.match(pageResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.doesNotMatch(page, /deviceCode|device_code/);
  const scriptResponse = await handleKiloSignIn(request("/api/auth/kilo-pairing.js"), env);
  const script = await scriptResponse.text();
  assert.match(script, /setTimeout\(poll, 2000\)/);
  await approve(kilo, new Response(page));
  const completed = await poll(env, started.cookie);
  assert.deepEqual(completed.body, { status: "signed_in", return_to: "/pages" });
  const publicResponses = [
    [started.response, ""],
    [pageResponse, page],
    [scriptResponse, script],
    [completed.response, JSON.stringify(completed.body)],
  ];
  for (const [response, body] of publicResponses) {
    const headers = [...response.headers]
      .filter(([name]) => name.toLowerCase() !== "set-cookie")
      .map(([, value]) => value)
      .join("\n");
    const content = `${headers}\n${body}`;
    for (const secret of secrets) assert.equal(content.includes(secret), false);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The audit log names the principal, which holds the account id, and nothing else.
  assert.ok(lines.some((line) => line.includes("sign_in.succeeded")));
  for (const line of lines)
    for (const secret of secrets.filter((value) => value !== user.id))
      assert.equal(line.includes(secret), false);
  const responses = await kilo.requests();
  assert.equal(responses.filter((item) => item.path === "/api/device-auth/token").length, 1);
  const table = env.DB.sqlite.prepare("SELECT count(*) AS count FROM kilo_pairings").get();
  assert.equal(table.count, 0);
  const probe = await handleKiloSignIn(
    request("/api/auth/pairing", {
      method: "POST",
      cookie: started.cookie,
      headers: { Origin: origin },
    }),
    env,
  );
  assert.equal((await probe.json()).status, "expired");
  assert.ok(lines.some((line) => line.includes('"action":"sign_in.succeeded"')));
});

test("the session cookie authenticates as the encoded Kilo principal without email proof", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  const page = await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env);
  await approve(kilo, page);
  const result = await poll(env, started.cookie);
  const cookies = result.response.headers.getSetCookie();
  // Only the session cookie: a poll's answer leaves the pairing cookie alone.
  assert.equal(cookies.length, 1);
  const sessionCookie = cookies.find((value) => value.startsWith(`${SERVER_SESSION_COOKIE}=`));
  const session = await readServerAppSession(
    env,
    request("/api/auth/session", { cookie: cookieValue(sessionCookie) }),
    Math.floor(Date.now() / 1000),
  );
  assert.equal(session.principal, "user:kilo:person%3Aone");
  assert.equal(session.principalNamespace, "user:kilo");
  assert.equal(session.displayName, "Example Person");
  assert.equal(session.identityVerifiedAt, undefined);
  assert.equal(session.verifiedEmailBinding, undefined);
});

test("pairing cookies isolate browsers and concurrent approval polls", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const first = await begin(env),
    second = await begin(env);
  const firstPage = await handleKiloSignIn(request("/sign-in", { cookie: first.cookie }), env);
  await approve(kilo, firstPage);
  assert.equal((await poll(env, undefined)).body.status, "expired");
  const wrong = await poll(env, second.cookie);
  assert.equal(wrong.body.status, "pending");
  const before = (await kilo.requests()).filter(
    (item) => item.path === "/api/device-auth/token",
  ).length;
  const concurrent = await Promise.all([poll(env, first.cookie), poll(env, first.cookie)]);
  assert.equal(concurrent.filter(({ body }) => body.status === "signed_in").length, 1);
  assert.equal(
    (await kilo.requests()).filter((item) => item.path === "/api/device-auth/token").length,
    before + 1,
  );
});

test("profile lookup outage resumes the stored approved grant without re-exchange", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  await approve(kilo, await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env));
  const original = globalThis.fetch;
  let failed = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (!failed && new URL(input).pathname === "/api/profile") {
      failed = true;
      throw new Error("offline");
    }
    return original(input, init);
  });
  assert.equal((await poll(env, started.cookie)).body.status, "pending");
  // The failed request gave up its claim, so the next poll resumes at once.
  assert.equal((await poll(env, started.cookie)).body.status, "signed_in");
  assert.equal(
    (await kilo.requests()).filter((item) => item.path === "/api/device-auth/token").length,
    1,
  );
});

test("denial, expiry, user mismatch, origin refusal, and unavailable start are bounded", async (t) => {
  let fakeNow = Date.now();
  const kilo = await startLocalKilo({ now: () => fakeNow });
  const { env } = fixture(t, kilo);
  const denied = await begin(env);
  const deniedPage = await handleKiloSignIn(request("/sign-in", { cookie: denied.cookie }), env);
  const deniedCode = (await deniedPage.text()).match(/class="pairing-code"><strong>([^<]+)/)[1];
  await kilo.deny(deniedCode);
  assert.equal((await poll(env, denied.cookie)).body.status, "denied");
  const expired = await begin(env);
  const row = env.DB.sqlite
    .prepare(
      "SELECT id FROM kilo_pairings WHERE user_code = (SELECT user_code FROM kilo_pairings ORDER BY rowid DESC LIMIT 1)",
    )
    .get();
  env.DB.sqlite.prepare("UPDATE kilo_pairings SET expires_at = 1 WHERE id = ?").run(row.id);
  assert.equal((await poll(env, expired.cookie)).body.status, "expired");
  const mismatch = await begin(env);
  const mismatchPage = await handleKiloSignIn(
    request("/sign-in", { cookie: mismatch.cookie }),
    env,
  );
  await approve(kilo, mismatchPage);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(input).pathname !== "/api/profile") return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, user: { ...body.user, id: "another" } }), {
      status: 200,
      headers: response.headers,
    });
  });
  assert.equal((await poll(env, mismatch.cookie)).body.status, "failed");
  // The gateway turns this refusal into its 403 answer.
  await assert.rejects(poll(env, mismatch.cookie, { Origin: "https://evil.example" }), {
    status: 403,
  });
  const unavailable = await startLocalKilo();
  await unavailable.close();
  const badEnv = { ...env, PAGES_KILO_APP_URL: unavailable.origin };
  const failedStart = await handleKiloSignIn(request("/api/auth/login"), badEnv);
  assert.equal(failedStart.status, 503);
  assert.match(await failedStart.text(), /couldn(&#39;|')t reach Kilo/);
});

test("the landing path stays on this origin, and a second click keeps the pairing", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const landing = async (returnTo) => {
    const started = await begin(env, returnTo);
    const page = await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env);
    await approve(kilo, page);
    return (await poll(env, started.cookie)).body.return_to;
  };
  assert.equal(await landing("/p/abc?x=1#top"), "/p/abc?x=1#top");
  // A URL parser drops the tab, which would leave a scheme-relative URL.
  for (const hostile of [
    "/\t/evil.example",
    "//evil.example",
    // Dot segments the parser resolves, leaving a path that starts with two slashes.
    "/a/..//evil.example",
    "/%2e%2e//evil.example",
    "/.//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "/api/auth/login",
    "/sign-in",
  ])
    assert.equal(await landing(hostile), "/", hostile);

  const first = await begin(env, "/pages");
  const starts = () =>
    kilo.requests().filter((item) => item.path === "/api/device-auth/codes").length;
  const before = starts();
  const again = await handleKiloSignIn(
    request("/api/auth/login?return_to=%2Fp%2Flater", { cookie: first.cookie }),
    env,
  );
  assert.equal(again.status, 303);
  assert.equal(pairingCookie(again), undefined, "the browser keeps the pairing it has");
  assert.equal(starts(), before, "Kilo is not asked for another pairing");
  await approve(kilo, await handleKiloSignIn(request("/sign-in", { cookie: first.cookie }), env));
  assert.equal((await poll(env, first.cookie)).body.return_to, "/p/later");
});

test("a second click while a poll owns the pairing doesn't lose the approved grant", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  await approve(kilo, await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env));
  const original = globalThis.fetch;
  let entered;
  const exchanging = new Promise((resolve) => (entered = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const response = await original(input, init);
    if (new URL(input).pathname === "/api/device-auth/token") {
      entered();
      await held;
    }
    return response;
  });
  const owner = poll(env, started.cookie);
  await exchanging;
  // Kilo has consumed the device code; the owner has not stored the grant yet.
  assert.equal((await poll(env, started.cookie)).body.status, "pending");
  await handleKiloSignIn(
    request("/api/auth/login?return_to=%2Fp%2Flater", { cookie: started.cookie }),
    env,
  );
  release();
  const finished = (await owner).body;
  assert.deepEqual(finished, { status: "signed_in", return_to: "/p/later" });
  assert.equal(kilo.requests().filter((item) => item.path === "/api/device-auth/token").length, 1);
});

test("two pairing cookies name no pairing, and the page loads its script from this origin", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const a = await begin(env);
  const b = await begin(env);
  assert.deepEqual((await poll(env, `${a.cookie}; ${b.cookie}`)).body, { status: "expired" });
  const page = await handleKiloSignIn(request("/sign-in", { cookie: a.cookie }), env);
  const policy = page.headers.get("content-security-policy");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'$/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const body = await page.text();
  assert.match(body, /<script src="\/api\/auth\/kilo-pairing\.js" defer><\/script>/);
  assert.doesNotMatch(body, /<script>|onclick=|javascript:/);
  const script = await handleKiloSignIn(request("/api/auth/kilo-pairing.js"), env);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.match(await script.text(), /fetch\("\/api\/auth\/pairing"/);
  const none = await handleKiloSignIn(request("/sign-in"), env);
  assert.match(await none.text(), /expired or already finished/);
});

test("session renewal rotates the stored credential and rejects ended or foreign grants", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const provider = kiloSessionProvider(env, request("/api/auth/session"));
  const initial = await (
    await import("./kilo-pairing-client.mjs")
  ).startKiloPairing(fetch, {
    appUrl: kilo.origin,
    client: { id: "pages", name: "Pages", redirectOrigin: origin },
  });
  await kilo.approve(initial.userCode, user);
  const exchange = await (
    await import("./kilo-pairing-client.mjs")
  ).exchangeKiloDeviceCode(fetch, { appUrl: kilo.origin, deviceCode: initial.deviceCode });
  const grant = {
    kind: "kilo",
    appUrl: kilo.origin,
    userId: user.id,
    refreshToken: exchange.refreshToken,
  };
  const refreshed = await provider.refresh(grant);
  assert.notEqual(refreshed.bundle.refreshToken, grant.refreshToken);
  assert.equal(refreshed.identity.principal, "user:kilo:person%3Aone");
  await assert.rejects(
    provider.refresh({ ...grant, appUrl: "https://elsewhere.example" }),
    ServerSessionGrantRejected,
  );
  kilo.revoke(user.id);
  await assert.rejects(provider.refresh(refreshed.bundle), ServerSessionGrantRejected);
  const second = await startLocalKilo();
  t.after(() => second.close());
  const secondStart = await (
    await import("./kilo-pairing-client.mjs")
  ).startKiloPairing(fetch, {
    appUrl: second.origin,
    client: { id: "pages", name: "Pages", redirectOrigin: origin },
  });
  await second.approve(secondStart.userCode, user);
  const secondGrant = await (
    await import("./kilo-pairing-client.mjs")
  ).exchangeKiloDeviceCode(fetch, { appUrl: second.origin, deviceCode: secondStart.deviceCode });
  const secondProvider = kiloSessionProvider(
    { ...env, PAGES_KILO_APP_URL: second.origin },
    request("/api/auth/session"),
  );
  second.block(user.id);
  await assert.rejects(
    secondProvider.refresh({
      kind: "kilo",
      appUrl: second.origin,
      userId: user.id,
      refreshToken: secondGrant.refreshToken,
    }),
    ServerSessionGrantRejected,
  );
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  await assert.rejects(
    secondProvider.refresh({
      kind: "kilo",
      appUrl: second.origin,
      userId: user.id,
      refreshToken: secondGrant.refreshToken,
    }),
    KiloUnavailable,
  );
  assert.equal(typeof originalFetch, "function");
});

test("a renewal keeps the rotated refresh token when the profile can't be read", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const client = await import("./kilo-pairing-client.mjs");
  const started = await client.startKiloPairing(fetch, {
    appUrl: kilo.origin,
    client: { id: "pages", name: "Pages", redirectOrigin: origin },
  });
  await kilo.approve(started.userCode, user);
  const exchange = await client.exchangeKiloDeviceCode(fetch, {
    appUrl: kilo.origin,
    deviceCode: started.deviceCode,
  });
  const bundle = {
    kind: "kilo",
    appUrl: kilo.origin,
    userId: user.id,
    name: "Stored Name",
    refreshToken: exchange.refreshToken,
  };
  const original = globalThis.fetch;
  const outage = t.mock.method(globalThis, "fetch", async (input, init) => {
    if (new URL(input).pathname === "/api/profile") throw new Error("offline");
    return original(input, init);
  });
  const provider = kiloSessionProvider(env, request("/api/auth/session"));
  const renewed = await provider.refresh(bundle);
  outage.mock.restore();
  // Kilo retired the old refresh token, so the new one must reach the row.
  assert.notEqual(renewed.bundle.refreshToken, bundle.refreshToken);
  assert.equal(renewed.identity.principal, "user:kilo:person%3Aone");
  assert.equal(renewed.identity.metadata.displayName, "Stored Name");
  assert.equal(renewed.bundle.name, "Stored Name");
  // The stored token still renews, and a readable profile refreshes the name.
  const again = await provider.refresh(renewed.bundle);
  assert.equal(again.identity.metadata.displayName, user.name);
  assert.equal(again.identity.metadata.email, undefined);
});

test("a session that can't be stored leaves no pairing to make a second one", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  await approve(kilo, await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env));
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/INSERT INTO oidc_server_sessions/.test(sql)) throw new Error("storage is down");
    return prepare(sql);
  };
  await assert.rejects(poll(env, started.cookie), /storage is down/);
  env.DB.prepare = prepare;
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM kilo_pairings").get().n, 0);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM oidc_server_sessions").get().n, 0);
  assert.deepEqual((await poll(env, started.cookie)).body, { status: "expired" });
});

test("a pairing a request is working on outlives its deadline and another sign-in's cleanup", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const owned = await begin(env);
  const far = Math.floor(Date.now() / 1000) + 3600;
  env.DB.sqlite.prepare("UPDATE kilo_pairings SET expires_at = 1, busy_until = ?").run(far);
  await begin(env);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM kilo_pairings").get().n, 2);
  assert.deepEqual((await poll(env, owned.cookie)).body, { status: "pending" });
  // Once nothing is working on it, the same row is expired and cleaned up.
  env.DB.sqlite.prepare("UPDATE kilo_pairings SET busy_until = 0 WHERE expires_at = 1").run();
  await begin(env);
  assert.equal(
    env.DB.sqlite.prepare("SELECT count(*) AS n FROM kilo_pairings WHERE expires_at = 1").get().n,
    0,
  );
});

test("a late answer from a finished pairing leaves a newer pairing's cookie alone", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  for (const ending of ["signed_in", "denied"]) {
    const first = await begin(env);
    const page = await handleKiloSignIn(request("/sign-in", { cookie: first.cookie }), env);
    if (ending === "signed_in") await approve(kilo, page);
    else await kilo.deny((await page.text()).match(/class="pairing-code"><strong>([^<]+)/)[1]);
    const answer = await poll(env, first.cookie);
    assert.equal(answer.body.status, ending);
    assert.equal(pairingCookie(answer.response), undefined, ending);
    // The finished pairing's cookie names nothing afterwards.
    assert.deepEqual((await poll(env, first.cookie)).body, { status: "expired" });
  }
});

test("a profile whose body breaks off keeps the approved grant for the next poll", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  await approve(kilo, await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env));
  const original = globalThis.fetch;
  let broke = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (broke || new URL(input).pathname !== "/api/profile") return original(input, init);
    broke = true;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"user":'));
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  assert.deepEqual((await poll(env, started.cookie)).body, { status: "pending" });
  assert.equal(env.DB.sqlite.prepare("SELECT state FROM kilo_pairings").get().state, "approved");
  assert.equal((await poll(env, started.cookie)).body.status, "signed_in");
  assert.equal(kilo.requests().filter((item) => item.path === "/api/device-auth/token").length, 1);
});

test("a renewal whose profile Kilo refuses ends the session, whatever the refusal's body", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const client = await import("./kilo-pairing-client.mjs");
  const provider = kiloSessionProvider(env, request("/api/auth/session"));
  const broken = () =>
    new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
  const original = globalThis.fetch;
  for (const refusal of [
    () => new Response("Unauthorized", { status: 401 }),
    () =>
      new Response("{not json", { status: 403, headers: { "content-type": "application/json" } }),
    () => new Response(broken(), { status: 401 }),
    () => new Response(null, { status: 403 }),
  ]) {
    const started = await client.startKiloPairing(fetch, {
      appUrl: kilo.origin,
      client: { id: "pages", name: "Pages", redirectOrigin: origin },
    });
    await kilo.approve(started.userCode, user);
    const exchange = await client.exchangeKiloDeviceCode(fetch, {
      appUrl: kilo.origin,
      deviceCode: started.deviceCode,
    });
    const mock = t.mock.method(globalThis, "fetch", async (input, init) =>
      new URL(input).pathname === "/api/profile" ? refusal() : original(input, init),
    );
    await assert.rejects(
      provider.refresh({
        kind: "kilo",
        appUrl: kilo.origin,
        userId: user.id,
        name: "Stored Name",
        refreshToken: exchange.refreshToken,
      }),
      ServerSessionGrantRejected,
    );
    mock.mock.restore();
  }
});

test("time spent reaching a pairing doesn't come out of the claim that protects its exchange", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  const realNow = Date.now;
  let skew = 0;
  t.mock.method(Date, "now", () => realNow() + skew);
  // Finding the row takes 25 seconds.
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.startsWith("SELECT * FROM kilo_pairings")) skew = 25_000;
    return prepare(sql);
  };
  const original = globalThis.fetch;
  let remaining;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (new URL(input).pathname === "/api/device-auth/token") {
      const { busy_until } = env.DB.sqlite.prepare("SELECT busy_until FROM kilo_pairings").get();
      remaining = busy_until - Math.floor(Date.now() / 1000);
    }
    return original(input, init);
  });
  assert.deepEqual((await poll(env, started.cookie)).body, { status: "pending" });
  assert.equal(remaining, 30, "the whole claim is ahead of the exchange");
});
