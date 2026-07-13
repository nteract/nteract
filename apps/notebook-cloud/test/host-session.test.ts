import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1,
  HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1,
  authenticateHostSessionRequest,
  hostSessionHealth,
  parseHostSessionIdentity,
} from "../src/host-session.ts";
import { authenticateOidcRequest } from "../src/identity.ts";
import { oidcTokenFixture } from "./oidc-jwt-fixture.ts";

describe("host session identities", () => {
  it("parses standard OIDC UserInfo without deployment-specific fields", () => {
    assert.deepEqual(
      parseHostSessionIdentity(
        {
          sub: "subject-a",
          email: "user@example.test",
          email_verified: true,
          given_name: "Hosted",
          family_name: "User",
          picture: "https://images.example.test/avatar.png",
        },
        HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1,
      ),
      {
        subject: "subject-a",
        displayName: "Hosted User",
        avatarUrl: "https://images.example.test/avatar.png",
        email: { value: "user@example.test", verified: true },
      },
    );
  });

  it("isolates the Anaconda whoami wire shape behind its versioned adapter", () => {
    assert.deepEqual(
      parseHostSessionIdentity(
        {
          identity: { id: "subject-a", traits: { email: "user@example.test" } },
          passport: {
            user_id: "subject-a",
            profile: {
              email: "user@example.test",
              first_name: "Hosted",
              is_confirmed: true,
              last_name: "User",
            },
          },
          tokenized: "not-part-of-the-normalized-identity",
        },
        HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1,
      ),
      {
        subject: "subject-a",
        displayName: "Hosted User",
        email: { value: "user@example.test", verified: true },
      },
    );
  });

  it("rejects conflicting Anaconda subject and email candidates", () => {
    assert.equal(
      parseHostSessionIdentity(
        {
          identity: { id: "identity-subject", traits: { email: "identity@example.test" } },
          passport: {
            user_id: "passport-subject",
            profile: { email: "profile@example.test", is_confirmed: true },
          },
        },
        HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1,
      ),
      null,
    );
    assert.equal(
      parseHostSessionIdentity(
        {
          identity: { id: "subject-a", traits: { email: "identity@example.test" } },
          passport: {
            user_id: "subject-a",
            profile: { email: "profile@example.test", is_confirmed: true },
          },
        },
        HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1,
      ),
      null,
    );
  });

  it("does not transfer profile verification onto an unbound identity email", () => {
    assert.deepEqual(
      parseHostSessionIdentity(
        {
          identity: { id: "subject-a", traits: { email: "user@example.test" } },
          passport: { user_id: "subject-a", profile: { is_confirmed: true } },
        },
        HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1,
      )?.email,
      { value: "user@example.test", verified: false },
    );
    assert.deepEqual(
      parseHostSessionIdentity(
        {
          identity: { id: "subject-a", traits: { email: "user@example.test" } },
          passport: {
            user_id: "subject-a",
            profile: {
              email: "user@example.test",
              is_confirmed: true,
              email_verified: false,
            },
          },
        },
        HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1,
      )?.email,
      { value: "user@example.test", verified: false },
    );
  });

  it("maps host and OIDC credentials for the same subject to one principal", async (t) => {
    const subject = "subject/with space";
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject });
    const oidcIdentity = await authenticateOidcRequest(
      new Request("https://cloud.test/api/n", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      oidcEnv,
    );
    let forwardedCookie = "";
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedCookie = new Headers(init?.headers).get("Cookie") ?? "";
      assert.equal(init?.redirect, "error");
      return Response.json({ sub: subject });
    });

    const hostIdentity = await authenticateHostSessionRequest(
      new Request("https://cloud.test/api/auth/session", {
        headers: { Cookie: "ignored=value; platform_session=opaque; second_session=other" },
      }),
      {
        NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES: "platform_session, second_session",
        NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL: "https://identity.example.test/userinfo",
        NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE:
          oidcEnv.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
      },
    );

    assert.equal(hostIdentity?.principal, oidcIdentity.principal);
    assert.equal(hostIdentity?.metadata.provider, "oidc");
    assert.equal(hostIdentity?.metadata.transport, "host-session-cookie");
    assert.equal(forwardedCookie, "platform_session=opaque; second_session=other");
  });

  it("fails closed for incomplete, non-HTTPS, and unknown-adapter configuration", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("invalid host-session configuration must not fetch");
    });
    const request = new Request("https://cloud.test/api/auth/session", {
      headers: { Cookie: "platform_session=opaque" },
    });

    assert.equal(
      await authenticateHostSessionRequest(request, {
        NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES: "platform_session",
      }),
      null,
    );
    assert.equal(
      await authenticateHostSessionRequest(request, {
        NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES: "platform_session",
        NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL: "http://identity.example.test/userinfo",
        NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE: "user:example",
      }),
      null,
    );
    assert.equal(
      await authenticateHostSessionRequest(request, {
        NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES: "platform_session",
        NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_ADAPTER: "unknown-v1",
        NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL: "https://identity.example.test/userinfo",
        NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE: "user:example",
      }),
      null,
    );
    assert.equal(
      await authenticateHostSessionRequest(
        new Request("https://cloud.test/api/auth/session", {
          headers: { Cookie: "platform_session=first; platform_session=second" },
        }),
        {
          NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES: "platform_session",
          NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL: "https://identity.example.test/userinfo",
          NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE: "user:example",
        },
      ),
      null,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual(hostSessionHealth({}), { status: "disabled" });
  });
});
