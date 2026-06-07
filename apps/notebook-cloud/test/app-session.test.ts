import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME,
  NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
  clearCloudAppSessionCookie,
  createCloudAppSessionCookie,
  readCloudAppSession,
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

    assert.deepEqual(session, {
      provider: "oidc",
      principal: "user:anaconda:subject-a",
      principalNamespace: "user:anaconda",
      issuedAt: 2_000,
      expiresAt: 2_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
      displayName: "OIDC User",
    });
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

function oidcIdentity(): AuthenticatedConnection {
  return {
    principal: "user:anaconda:subject-a",
    operator: "browser:tab",
    actorLabel: "user:anaconda:subject-a/browser:tab",
    scope: "viewer",
    metadata: {
      provider: "oidc",
      transport: "oidc-bearer",
      principalNamespace: "user:anaconda",
      displayName: "OIDC User",
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
