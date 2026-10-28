import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME,
  NOTEBOOK_CLOUD_APP_SESSION_DISPLAY_NAME_MAX_LENGTH,
  NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
  appSessionRenewalCookie,
  appSessionConnectionIdentity,
  createServerAppSession,
  NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS,
  appSessionHasFreshVerifiedEmail,
  appSessionHasFreshVerifiedEmailDomain,
  clearCloudAppSessionCookie,
  createCloudAppSessionCookie,
  readCloudAppSession,
  appSessionAccountKey,
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
    assert.notEqual(renewed?.cacheKey, session?.cacheKey);
    assert.equal(
      await appSessionAccountKey(env, renewed!),
      await appSessionAccountKey(env, session!),
    );
    assert.notEqual(
      await appSessionAccountKey(env, session!, "account:other"),
      await appSessionAccountKey(env, session!),
    );
    assert.notEqual(
      await appSessionAccountKey(env, { ...session!, principal: "user:other" }),
      await appSessionAccountKey(env, session!),
    );
    assert.doesNotMatch(await appSessionAccountKey(env, session!), /anaconda|subject-a/);
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
      assert.equal(renewed.verifiedEmailDomainBinding, first.verifiedEmailDomainBinding);
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
  return appSessionConnectionIdentity(session, "browser:test", "viewer");
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

describe("verified email domain proof", () => {
  it("binds normalized domain, account, namespace and verification time independently from exact-email proof", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const identity = oidcIdentity();
    identity.metadata.email = " Employee@Anaconda.com ";
    const cookie = await createCloudAppSessionCookie(env, identity, 1_000);
    const session = await readCloudAppSession(
      env,
      new Request("https://cloud.test", { headers: { Cookie: cookie } }),
      1_001,
    );
    assert.ok(session);
    const proof = sessionIdentity(session);
    assert.ok(await appSessionHasFreshVerifiedEmailDomain(env, proof, "anaconda.com", 1_001));
    assert.notEqual(session.verifiedEmailDomainBinding, session.verifiedEmailBinding);
    for (const domain of [
      "gmail.com",
      "sub.anaconda.com",
      "anaconda.com.attacker.test",
      "ANACONDA.COM",
      "anaconda.com\n",
    ]) {
      assert.equal(await appSessionHasFreshVerifiedEmailDomain(env, proof, domain, 1_001), false);
    }
    for (const changed of [
      { ...proof, principal: "user:anaconda:someone-else" },
      { ...proof, metadata: { ...proof.metadata, principalNamespace: "user:other" } },
      { ...proof, metadata: { ...proof.metadata, identityVerifiedAt: 1_001 } },
      {
        ...proof,
        metadata: { ...proof.metadata, verifiedEmailDomainBinding: session.verifiedEmailBinding },
      },
    ])
      assert.equal(
        await appSessionHasFreshVerifiedEmailDomain(env, changed, "anaconda.com", 1_001),
        false,
      );
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(
        { NOTEBOOK_CLOUD_APP_SESSION_SECRET: "different-key".repeat(4) },
        proof,
        "anaconda.com",
        1_001,
      ),
      false,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(env, proof, "anaconda.com", 999),
      false,
    );
    const renewalAt = 1_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2 + 1;
    const renewedCookie = await appSessionRenewalCookie(env, session, renewalAt);
    const renewed = await readCloudAppSession(
      env,
      new Request("https://cloud.test", { headers: { Cookie: renewedCookie! } }),
      renewalAt,
    );
    assert.ok(renewed);
    assert.equal(renewed.verifiedEmailDomainBinding, session.verifiedEmailDomainBinding);
    assert.equal(renewed.identityVerifiedAt, 1_000);
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(
        env,
        sessionIdentity(renewed),
        "anaconda.com",
        1_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS,
      ),
      false,
    );
  });

  it("rejects forged, malformed, stale, future and non-session evidence", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const session = await createServerAppSession(env, oidcIdentity(), "test", 30_000, 1_000);
    const proof = sessionIdentity(session);
    for (const binding of [undefined, "", "tampered", "A".repeat(43), "!".repeat(43)]) {
      assert.equal(
        await appSessionHasFreshVerifiedEmailDomain(
          env,
          {
            ...proof,
            metadata: { ...proof.metadata, verifiedEmailDomainBinding: binding },
          },
          "example.test",
          1_000,
        ),
        false,
      );
    }
    for (const verifiedAt of [undefined, 0, -1, 1_000.5, NaN, Infinity, 1_001]) {
      assert.equal(
        await appSessionHasFreshVerifiedEmailDomain(
          env,
          {
            ...proof,
            metadata: { ...proof.metadata, identityVerifiedAt: verifiedAt },
          },
          "example.test",
          1_000,
        ),
        false,
      );
    }
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(
        env,
        {
          ...proof,
          metadata: { ...proof.metadata, provider: "oidc" },
        },
        "example.test",
        1_000,
      ),
      false,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(
        env,
        proof,
        "example.test",
        1_000 + NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS - 1,
      ),
      true,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(
        env,
        proof,
        "example.test",
        1_000 + NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS,
      ),
      false,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        {
          ...proof,
          metadata: { ...proof.metadata, verifiedEmailBinding: session.verifiedEmailDomainBinding },
        },
        "user@example.test",
        1_000,
      ),
      false,
    );
  });

  it("accepts exact ASCII domains including punycode and never their parent domain", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    for (const domain of ["sub.example.test", "xn--bcher-kva.test", "my--team.example.test"]) {
      const identity = oidcIdentity();
      identity.metadata.email = `user@${domain}`;
      const session = await createServerAppSession(env, identity, "test", 30_000, 1_000);
      const proof = sessionIdentity(session);
      assert.equal(await appSessionHasFreshVerifiedEmailDomain(env, proof, domain, 1_000), true);
      assert.equal(
        await appSessionHasFreshVerifiedEmailDomain(env, proof, "example.test", 1_000),
        false,
      );
    }
    // Even authenticated malformed email domains cannot become usable domain proof.
    for (const domain of [
      "-bad.test",
      "bad-.test",
      "bad..test",
      "bad_test",
      "a".repeat(64) + ".test",
      "example.test.",
      "\u212Aexample.test",
      "bücher.test",
      Array(5).fill("a".repeat(63)).join("."),
    ]) {
      const identity = oidcIdentity();
      identity.metadata.email = `user@${domain}`;
      const session = await createServerAppSession(env, identity, "test", 30_000, 1_000);
      assert.equal(session.verifiedEmailDomainBinding, undefined);
      assert.equal(
        await appSessionHasFreshVerifiedEmailDomain(
          env,
          sessionIdentity(session),
          domain.toLowerCase(),
          1_000,
        ),
        false,
      );
    }
  });

  it("keeps an older exact-email-only cookie usable through renewal without upgrading its proof", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    const cookie = await createCloudAppSessionCookie(env, oidcIdentity(), 1_000);
    const payload = JSON.parse(
      Buffer.from(cookie.split("=")[1]!.split(".")[0]!, "base64url").toString(),
    );
    delete payload.verified_email_domain_binding;
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", SESSION_SECRET).update(encoded).digest("base64url");
    const legacyCookie = `${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=${encoded}.${signature}`;
    const now = 1_000 + NOTEBOOK_CLOUD_APP_SESSION_MAX_AGE_SECONDS / 2 + 1;
    const legacy = await readCloudAppSession(
      env,
      new Request("https://cloud.test", { headers: { Cookie: legacyCookie } }),
      now,
    );
    assert.ok(legacy);
    const renewedCookie = await appSessionRenewalCookie(env, legacy, now);
    assert.ok(renewedCookie);
    const renewed = await readCloudAppSession(
      env,
      new Request("https://cloud.test", { headers: { Cookie: renewedCookie } }),
      now,
    );
    assert.ok(renewed);
    assert.equal(renewed.verifiedEmailDomainBinding, undefined);
    assert.equal(
      await appSessionHasFreshVerifiedEmail(
        env,
        sessionIdentity(renewed),
        "user@example.test",
        now,
      ),
      true,
    );
    assert.equal(
      await appSessionHasFreshVerifiedEmailDomain(
        env,
        sessionIdentity(renewed),
        "example.test",
        now,
      ),
      false,
    );
  });

  it("does not manufacture domain evidence from missing, unverified or invalid emails", async () => {
    const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: SESSION_SECRET };
    for (const [email, emailVerified] of [
      [undefined, true],
      ["employee@anaconda.com", false],
      ["not-an-email", true],
    ] as const) {
      const identity = oidcIdentity();
      identity.metadata.email = email;
      identity.metadata.emailVerified = emailVerified;
      const cookie = await createCloudAppSessionCookie(env, identity, 1_000);
      const session = await readCloudAppSession(
        env,
        new Request("https://cloud.test", { headers: { Cookie: cookie } }),
        1_001,
      );
      assert.ok(session);
      assert.equal(session.verifiedEmailDomainBinding, undefined);
      assert.equal(
        await appSessionHasFreshVerifiedEmailDomain(
          env,
          sessionIdentity(session),
          "anaconda.com",
          1_001,
        ),
        false,
      );
    }
  });
});
