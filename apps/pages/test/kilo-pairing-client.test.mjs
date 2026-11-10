import assert from "node:assert/strict";
import { test } from "node:test";
import { startLocalKilo } from "../scripts/fixtures/local-kilo.mjs";
import {
  exchangeKiloDeviceCode,
  KiloProtocolError,
  KiloUnavailable,
  readKiloProfile,
  refreshKiloTokens,
  startKiloPairing,
} from "../worker/kilo-pairing-client.mjs";

const user = {
  id: "user-1",
  email: "person@example.test",
  name: "Person",
  organizations: [{ id: "org-1", name: "Org", role: "member" }],
};
async function fixture(t, options) {
  const kilo = await startLocalKilo(options);
  t.after(() => kilo.close());
  return kilo;
}
const start = (kilo, extra = {}) =>
  startKiloPairing(fetch, {
    appUrl: kilo.origin,
    client: { id: "pages", name: "Pages", redirectOrigin: "https://pages.example" },
    ...extra,
  });

test("starts pairing with the expected body and forwards only supplied headers", async (t) => {
  const kilo = await fixture(t);
  const result = await start(kilo, { forwardedFor: "192.0.2.10", userAgent: "Pages test" });
  assert.match(result.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(result.expiresInSeconds, 600);
  const request = kilo.requests()[0];
  assert.deepEqual(request, {
    method: "POST",
    path: "/api/device-auth/codes",
    forwardedFor: "192.0.2.10",
  });
  const observed = await fetch(kilo.origin + "/missing");
  assert.equal(observed.status, 404);
  assert.equal(result.verificationUrl, `${kilo.origin}/device-auth?code=${result.userCode}`);
  const noForward = await start(kilo);
  assert.ok(noForward.deviceCode);
});

test("exchanges pending approval and supports profile refresh rotation", async (t) => {
  const kilo = await fixture(t);
  const pair = await start(kilo);
  assert.deepEqual(
    await exchangeKiloDeviceCode(fetch, { appUrl: kilo.origin, deviceCode: pair.deviceCode }),
    { status: "pending" },
  );
  assert.equal(await kilo.approve(pair.userCode, user), true);
  const approved = await exchangeKiloDeviceCode(fetch, {
    appUrl: kilo.origin,
    deviceCode: pair.deviceCode,
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.expiresInSeconds, 3600);
  assert.deepEqual(await readKiloProfile(fetch, { appUrl: kilo.origin, token: approved.token }), {
    id: user.id,
    email: user.email,
    name: user.name,
    organizations: user.organizations,
  });
  assert.deepEqual(
    await exchangeKiloDeviceCode(fetch, { appUrl: kilo.origin, deviceCode: pair.deviceCode }),
    { status: "expired" },
  );
  const rotated = await refreshKiloTokens(fetch, {
    appUrl: kilo.origin,
    refreshToken: approved.refreshToken,
  });
  assert.equal(rotated.expiresInSeconds, 3600);
  assert.equal(
    (await readKiloProfile(fetch, { appUrl: kilo.origin, token: rotated.token })).id,
    user.id,
  );
  assert.deepEqual(
    await refreshKiloTokens(fetch, { appUrl: kilo.origin, refreshToken: approved.refreshToken }),
    { refused: "SESSION_REVOKED" },
  );
  assert.deepEqual(await readKiloProfile(fetch, { appUrl: kilo.origin, token: rotated.token }), {
    refused: true,
  });
});

test("returns denied and expired states and enforces the pending IP limit", async (t) => {
  let clock = 1_000_000;
  const kilo = await fixture(t, { now: () => clock });
  const denied = await start(kilo);
  await kilo.deny(denied.userCode);
  assert.deepEqual(
    await exchangeKiloDeviceCode(fetch, { appUrl: kilo.origin, deviceCode: denied.deviceCode }),
    { status: "denied" },
  );
  const expiring = await start(kilo);
  clock += 600_001;
  assert.deepEqual(
    await exchangeKiloDeviceCode(fetch, { appUrl: kilo.origin, deviceCode: expiring.deviceCode }),
    { status: "expired" },
  );
  clock += 1;
  for (let i = 0; i < 5; i++) await start(kilo, { forwardedFor: "198.51.100.4" });
  await assert.rejects(start(kilo, { forwardedFor: "198.51.100.4" }), KiloUnavailable);
  assert.equal((await start(kilo, { forwardedFor: "198.51.100.5" })).deviceCode.length > 0, true);
});

test("rejects unsafe origins before making a request", async () => {
  let called = false;
  await assert.rejects(
    startKiloPairing(
      () => {
        called = true;
      },
      {
        appUrl: "http://example.com",
        client: { id: "p", name: "P", redirectOrigin: "https://pages.example" },
      },
    ),
    TypeError,
  );
  assert.equal(called, false);
});

function response(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
const args = {
  appUrl: "https://app.kilo.ai",
  client: { id: "pages", name: "Pages", redirectOrigin: "https://pages.example" },
};
const validStart = {
  device_code: "device-secret",
  user_code: "ABCD-2345",
  verificationUrl: "https://app.kilo.ai/device-auth?code=ABCD-2345",
  expiresIn: 1200,
  requestingClient: {
    clientId: "pages",
    clientName: "Pages",
    redirectOrigin: "https://pages.example",
  },
  code: "legacy-secret",
};

for (const [label, alter] of [
  [
    "missing fields",
    (body) => {
      delete body.device_code;
    },
  ],
  [
    "wrong echoed client",
    (body) => {
      body.requestingClient.clientId = "other";
    },
  ],
  [
    "foreign verification origin",
    (body) => {
      body.verificationUrl = "https://attacker.example/device-auth?code=ABCD-2345";
    },
  ],
  [
    "different verification code",
    (body) => {
      body.verificationUrl = "https://app.kilo.ai/device-auth?code=WXYZ-2345";
    },
  ],
]) {
  test(`rejects start response with ${label} without exposing secrets`, async () => {
    const body = structuredClone(validStart);
    alter(body);
    await assert.rejects(
      startKiloPairing(async () => response(200, body), args),
      (error) => {
        assert.ok(error instanceof KiloProtocolError);
        for (const secret of ["legacy-secret", "device-secret", "ABCD-2345"])
          assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });
}

test("rejects approved responses that omit refresh tokens", async () => {
  await assert.rejects(
    exchangeKiloDeviceCode(
      async () =>
        response(200, {
          status: "approved",
          token: "access-secret",
          expiresIn: 3600,
          userId: "u",
          userEmail: "e",
        }),
      { appUrl: args.appUrl, deviceCode: "device-secret" },
    ),
    (error) => error instanceof KiloProtocolError && !error.message.includes("access-secret"),
  );
});

test("rejects redirects and oversized response bodies", async () => {
  await assert.rejects(
    startKiloPairing(async () => response(302, null, { location: "https://secret.example" }), args),
    KiloProtocolError,
  );
  await assert.rejects(
    startKiloPairing(async () => new Response("x".repeat(65 * 1024), { status: 200 }), args),
    KiloProtocolError,
  );
});

test("classifies timeout and server failures without exposing response details", async () => {
  await assert.rejects(
    startKiloPairing(async () => {
      throw new Error("device-secret response-body-secret");
    }, args),
    (error) => error instanceof KiloUnavailable && !error.message.includes("device-secret"),
  );
  for (const headers of [{}, { "retry-after": "7" }]) {
    await assert.rejects(
      startKiloPairing(async () => response(500, { error: "device-secret" }, headers), args),
      (error) => {
        assert.ok(error instanceof KiloUnavailable);
        assert.equal(error.retryAfterSeconds, headers["retry-after"] ? 7 : undefined);
        assert.equal(error.message.includes("device-secret"), false);
        return true;
      },
    );
  }
});

test("sends refresh support and never sends cookies", async () => {
  let captured;
  const fetcher = async (url, options) => {
    captured = { url: String(url), options };
    return response(202, { status: "pending" });
  };
  await exchangeKiloDeviceCode(fetcher, { appUrl: args.appUrl, deviceCode: "device-secret" });
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.url, "https://app.kilo.ai/api/device-auth/token");
  assert.deepEqual(JSON.parse(captured.options.body), {
    deviceCode: "device-secret",
    supportsRefresh: true,
  });
  assert.equal(new Headers(captured.options.headers).has("cookie"), false);
  assert.equal(captured.options.redirect, "manual");
  // Workers' fetch has no cookie jar, and an unsupported `credentials` option
  // can be refused there, so the request leaves it unset.
  assert.equal("credentials" in captured.options, false);
});

test("a session refreshes again and again with each new refresh token", async (t) => {
  const kilo = await fixture(t);
  const pair = await start(kilo);
  await kilo.approve(pair.userCode, user);
  let grant = await exchangeKiloDeviceCode(fetch, {
    appUrl: kilo.origin,
    deviceCode: pair.deviceCode,
  });
  for (let round = 0; round < 3; round++) {
    const next = await refreshKiloTokens(fetch, {
      appUrl: kilo.origin,
      refreshToken: grant.refreshToken,
    });
    assert.notEqual(next.refreshToken, grant.refreshToken);
    // The token a refresh replaces stops working; the new one names the same person.
    assert.deepEqual(await readKiloProfile(fetch, { appUrl: kilo.origin, token: grant.token }), {
      refused: true,
    });
    assert.equal(
      (await readKiloProfile(fetch, { appUrl: kilo.origin, token: next.token })).id,
      user.id,
    );
    grant = next;
  }
});

test("a profile without a name reads as null, and extra organization fields are dropped", async () => {
  const fetcher = async () =>
    response(200, {
      user: { id: "user-2", email: "quiet@example.test", name: null, image: null },
      organizations: [{ id: "org-2", name: "Org", role: "owner", seats: 40 }],
      hasPersonalAccount: true,
    });
  assert.deepEqual(await readKiloProfile(fetcher, { appUrl: args.appUrl, token: "t" }), {
    id: "user-2",
    email: "quiet@example.test",
    name: null,
    organizations: [{ id: "org-2", name: "Org", role: "owner" }],
  });
});

test("a refreshed token that outlives Kilo's refreshable lifetime is refused", async () => {
  const fetcher = async () =>
    response(200, { token: "t", refreshToken: "r", expiresIn: 5 * 365 * 24 * 60 * 60 });
  await assert.rejects(
    refreshKiloTokens(fetcher, { appUrl: args.appUrl, refreshToken: "old" }),
    KiloProtocolError,
  );
});

test("an approval waits for its exchange while other pairings start", async (t) => {
  const kilo = await fixture(t);
  const first = await start(kilo);
  await kilo.approve(first.userCode, user);
  await start(kilo);
  const answer = await exchangeKiloDeviceCode(fetch, {
    appUrl: kilo.origin,
    deviceCode: first.deviceCode,
  });
  assert.equal(answer.status, "approved");
});

test("a refusal is its status, whatever its body holds", async () => {
  const broken = () =>
    new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
  const bodies = [() => "Unauthorized", () => "{not json", broken, () => null];
  for (const body of bodies) {
    for (const status of [401, 403])
      assert.deepEqual(
        await readKiloProfile(async () => new Response(body(), { status }), {
          appUrl: args.appUrl,
          token: "t",
        }),
        { refused: true },
      );
    assert.deepEqual(
      await refreshKiloTokens(async () => new Response(body(), { status: 401 }), {
        appUrl: args.appUrl,
        refreshToken: "r",
      }),
      { refused: "REFUSED" },
    );
  }
  assert.deepEqual(
    await refreshKiloTokens(async () => response(401, { error: "USER_BLOCKED" }), {
      appUrl: args.appUrl,
      refreshToken: "r",
    }),
    { refused: "USER_BLOCKED" },
  );
});

test("a body that breaks off is an outage, and one over the limit is a protocol error", async () => {
  const cutShort = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"user":'));
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    readKiloProfile(cutShort, { appUrl: args.appUrl, token: "t" }),
    KiloUnavailable,
  );
  const tooLarge = async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 });
  await assert.rejects(
    readKiloProfile(tooLarge, { appUrl: args.appUrl, token: "t" }),
    KiloProtocolError,
  );
});

test("a body over the limit is a protocol error even when the stream won't cancel", async () => {
  const stubborn = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(32 * 1024));
        },
        cancel() {
          throw new Error("can't cancel");
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    readKiloProfile(stubborn, { appUrl: args.appUrl, token: "t" }),
    KiloProtocolError,
  );
});
