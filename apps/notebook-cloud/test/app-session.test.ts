import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME,
  NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH,
  NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
  appSessionRenewalCookie,
  appSessionHasFreshVerifiedEmail,
  clearCloudAppSessionCookie,
  createCloudAppSessionCookie,
  readCloudAppSession,
  type CloudAppSession,
} from "../src/app-session";
import type { AuthenticatedConnection } from "../src/identity";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

describe("cloud app session cookies", () => {
  it("signs OIDC principals into secure HttpOnly host cookies", async () => {
    const cookie = await createCloudAppSessionCookie(
      { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET },
      oidcIdentity(),
      1_000,
    );

    assert.match(cookie, new RegExp(`^${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`));
    assert.match(cookie, new RegExp("Path=/"));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, new RegExp(`Max-Age=${NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS}`));
    assert.doesNotMatch(cookie, /access-token|refresh-token|user@example\\.test/);
  });

  it("round-trips signed sessions without raw identity claims", async () => {
    const cookie = await createCloudAppSessionCookie(
      { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET },
      oidcIdentity(),
      2_000,
    );
    const request = new Request("https://cloud.test/n", {
      headers: { Cookie: cookie },
    });

    const session = await readCloudAppSession(
      { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET },
      request,
      2_100,
    );

    assert.equal(session?.provider, "oidc");
    assert.equal(session?.principal, "user:anaconda:subject-a");
    assert.equal(session?.principalNamespace, "user:anaconda");
    assert.equal(session?.issuedAt, 2_000);
    assert.equal(session?.expiresAt, 2_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS);
    assert.equal(session?.displayName, "OIDC User");
    assert.match(session?.cacheKey ?? "", /^[A-Za-z0-9_-]+$/);
  });

  it("caps the display name signed into the cookie", async () => {
    const displayName = "A".repeat(NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH + 50);
    const cookie = await createCloudAppSessionCookie(
      { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET },
      oidcIdentity({ displayName }),
      2_500,
    );
    const request = new Request("https://cloud.test/n", {
      headers: { Cookie: cookie },
    });

    const session = await readCloudAppSession(
      { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET },
      request,
      2_600,
    );

    assert.equal(
      session?.displayName,
      displayName.slice(0, NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH),
    );
    assert.notEqual(session?.displayName, displayName);
    assert.equal(session?.displayName.length, NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH);
  });

  it("rejects expired and tampered sessions", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const cookie = await createCloudAppSessionCookie(env, oidcIdentity(), 3_000);
    const expiredRequest = new Request("https://cloud.test/n", {
      headers: { Cookie: cookie },
    });
    assert.equal(
      await readCloudAppSession(
        env,
        expiredRequest,
        3_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS + 1,
      ),
      null,
    );

    const tampered = cookie.replace(
      `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`,
      `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=x`,
    );
    const tamperedRequest = new Request("https://cloud.test/n", {
      headers: { Cookie: tampered },
    });
    assert.equal(await readCloudAppSession(env, tamperedRequest, 3_100), null);
  });

  it("renews a valid session past half its max age", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const issuedAt = 4_000;
    const renewalAt = issuedAt + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2 + 1;
    const cookie = await createCloudAppSessionCookie(env, oidcIdentity(), issuedAt);
    const request = new Request("https://cloud.test/n", {
      headers: { Cookie: cookie },
    });
    const session = await readCloudAppSession(env, request, renewalAt);

    const renewedCookie = await appSessionRenewalCookie(env, session, renewalAt);

    assert.match(renewedCookie ?? "", new RegExp(`^${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`));
    assert.match(
      renewedCookie ?? "",
      new RegExp(`Max-Age=${NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS}`),
    );
    const renewed = await readCloudAppSession(
      env,
      new Request("https://cloud.test/n", {
        headers: { Cookie: renewedCookie ?? "" },
      }),
      renewalAt,
    );
    assert.equal(renewed?.principal, session?.principal);
    assert.equal(renewed?.principalNamespace, session?.principalNamespace);
    assert.equal(renewed?.displayName, session?.displayName);
    assert.equal(renewed?.issuedAt, renewalAt);
    assert.equal(renewed?.expiresAt, renewalAt + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS);
  });

  it("does not renew before half its max age", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const issuedAt = 5_000;
    const beforeHalfLife = issuedAt + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2;
    const cookie = await createCloudAppSessionCookie(env, oidcIdentity(), issuedAt);
    const request = new Request("https://cloud.test/n", {
      headers: { Cookie: cookie },
    });
    const session = await readCloudAppSession(env, request, beforeHalfLife);

    assert.equal(await appSessionRenewalCookie(env, session, beforeHalfLife), null);
  });

  it("preserves verified-email proof through repeated renewal without refreshing its age", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const issuedAt = 10_000;
    let now = issuedAt;
    let cookie = await createCloudAppSessionCookie(env, oidcIdentity(), now);
    const first = await readCloudAppSession(
      env,
      new Request("https://cloud.test/n", { headers: { Cookie: cookie } }),
      now,
    );
    assert.ok(first);
    assert.equal(first.identityVerifiedAt, issuedAt);
    assert.match(first.verifiedEmailBinding ?? "", /^[A-Za-z0-9_-]{43}$/);
    const payload = JSON.parse(
      Buffer.from(cookie.split("=")[1]!.split(".")[0]!, "base64url").toString(),
    );
    assert.doesNotMatch(JSON.stringify(payload), /user@example\.test/);
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        sessionIdentity(first),
        " USER@example.test ",
        now,
      ),
      true,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        sessionIdentity(first),
        "changed@example.test",
        now,
      ),
      false,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        { ...sessionIdentity(first), principal: "other:person" },
        "user@example.test",
        now,
      ),
      false,
    );
    for (let renewal = 0; renewal < 3; renewal++) {
      now += NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2 + 1;
      const session = await readCloudAppSession(
        env,
        new Request("https://cloud.test/n", { headers: { Cookie: cookie } }),
        now,
      );
      assert.ok(session);
      cookie = (await appSessionRenewalCookie(env, session, now))!;
      const renewed = await readCloudAppSession(
        env,
        new Request("https://cloud.test/n", { headers: { Cookie: cookie } }),
        now,
      );
      assert.ok(renewed, "notebook session still renews");
      assert.equal(renewed.issuedAt, now);
      assert.equal(renewed.identityVerifiedAt, issuedAt);
      assert.equal(renewed.verifiedEmailBinding, first.verifiedEmailBinding);
    }
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        sessionIdentity(first),
        "user@example.test",
        issuedAt + 21_599,
      ),
      true,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        sessionIdentity(first),
        "user@example.test",
        issuedAt + 21_600,
      ),
      false,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        sessionIdentity(first),
        "user@example.test",
        issuedAt - 1,
      ),
      false,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        {
          ...sessionIdentity(first),
          metadata: {
            ...sessionIdentity(first).metadata,
            verifiedEmailBinding: "tampered",
          },
        },
        "user@example.test",
        issuedAt,
      ),
      false,
    );
  });

  it("keeps legacy or unverified sessions usable without creating verified-email proof on renewal", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    for (const email of [undefined, "user@example.test"]) {
      const identity = oidcIdentity();
      identity.metadata.email = email;
      identity.metadata.emailVerified = false;
      const cookie = await createCloudAppSessionCookie(env, identity, 20_000);
      const now = 20_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2 + 1;
      const session = await readCloudAppSession(
        env,
        new Request("https://cloud.test/n", { headers: { Cookie: cookie } }),
        now,
      );
      assert.ok(session);
      assert.equal(session.identityVerifiedAt, undefined);
      assert.equal(session.verifiedEmailBinding, undefined);
      const renewedCookie = await appSessionRenewalCookie(env, session, now);
      const renewed = await readCloudAppSession(
        env,
        new Request("https://cloud.test/n", { headers: { Cookie: renewedCookie! } }),
        now,
      );
      assert.ok(renewed);
      assert.equal(renewed.identityVerifiedAt, undefined);
      assert.equal(
        await appSessionHasFreshVerifiedEmail(
          env,
          sessionIdentity(renewed),
          "user@example.test",
          now,
        ),
        false,
      );
    }
  });

  it("does not renew expired or invalid sessions", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const issuedAt = 6_000;
    const cookie = await createCloudAppSessionCookie(env, oidcIdentity(), issuedAt);
    const expiredAt = issuedAt + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS + 1;
    const expiredSession = await readCloudAppSession(
      env,
      new Request("https://cloud.test/n", {
        headers: { Cookie: cookie },
      }),
      expiredAt,
    );

    const tampered = cookie.replace(
      `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`,
      `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=x`,
    );
    const invalidSession = await readCloudAppSession(
      env,
      new Request("https://cloud.test/n", {
        headers: { Cookie: tampered },
      }),
      issuedAt + 1,
    );

    assert.equal(expiredSession, null);
    assert.equal(invalidSession, null);
    assert.equal(await appSessionRenewalCookie(env, expiredSession, expiredAt), null);
    assert.equal(await appSessionRenewalCookie(env, invalidSession, issuedAt + 1), null);
  });

  it("requires a configured signing secret and OIDC identity", async () => {
    await assert.rejects(
      () => createCloudAppSessionCookie({}, oidcIdentity(), 1_000),
      /app session signing is not configured/,
    );
    await assert.rejects(
      () =>
        createCloudAppSessionCookie(
          { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET },
          devIdentity(),
          1_000,
        ),
      /app sessions require OIDC identity/,
    );
  });

  it("clears the session with the same secure cookie attributes", () => {
    const cookie = clearCloudAppSessionCookie();

    assert.match(cookie, new RegExp(`^${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`));
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, new RegExp("Path=/"));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
  });
});

function sessionIdentity(session: CloudAppSession): AuthenticatedConnection {
  return {
    principal: session.principal,
    operator: "browser:test",
    actorLabel: `${session.principal}/browser:test`,
    scope: "viewer",
    metadata: {
      provider: "app-session",
      transport: "app-session-cookie",
      principalNamespace: session.principalNamespace,
      identityVerifiedAt: session.identityVerifiedAt,
      verifiedEmailBinding: session.verifiedEmailBinding,
    },
  };
}

function oidcIdentity(overrides: { displayName?: string } = {}): AuthenticatedConnection {
  return {
    principal: "user:anaconda:subject-a",
    operator: "browser:tab",
    actorLabel: "user:anaconda:subject-a/browser:tab",
    scope: "viewer",
    metadata: {
      provider: "oidc",
      transport: "oidc-bearer",
      principalNamespace: "user:anaconda",
      displayName: overrides.displayName ?? "OIDC User",
      email: "user@example.test",
      emailVerified: true,
    },
  };
}

function devIdentity(): AuthenticatedConnection {
  return {
    principal: "user:dev:alice",
    operator: "browser:tab",
    actorLabel: "user:dev:alice/browser:tab",
    scope: "viewer",
    metadata: {
      provider: "dev",
      transport: "loopback-dev",
      principalNamespace: "user:dev",
      displayName: "Alice",
    },
  };
}
