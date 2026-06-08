import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnoseCloudConnectionAccess } from "../viewer/connection-diagnostics.ts";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth.ts";

describe("cloud connection diagnostics", () => {
  it("does not probe anonymous viewers", async () => {
    let fetchCount = 0;
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/private/access-requests",
      authState: authState("anonymous"),
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response("unexpected", { status: 500 });
      },
    });

    assert.equal(diagnostic, null);
    assert.equal(fetchCount, 0);
  });

  it("reports account access problems from the authenticated access route", async () => {
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/private/access-requests",
      authState: authState("oidc"),
      fetchImpl: async (input, init) => {
        assert.equal(input, "/api/n/private/access-requests");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
        return Response.json({ error: "principal cannot access private" }, { status: 403 });
      },
    });

    assert.match(diagnostic ?? "", /does not have access/);
  });

  it("probes access with same-origin cookies for app-session browsers", async () => {
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/private/access-requests",
      authState: authState("anonymous"),
      hasAppSession: true,
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(input, "/api/n/private/access-requests");
        assert.equal(headers.get("Authorization"), null);
        assert.equal(init?.credentials, "same-origin");
        return Response.json({ error: "principal cannot access private" }, { status: 403 });
      },
    });

    assert.match(diagnostic ?? "", /does not have access/);
  });

  it("keeps successful authenticated access silent", async () => {
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/shared/access-requests",
      authState: authState("oidc"),
      fetchImpl: async () => Response.json({ access_requests: [] }),
    });

    assert.equal(diagnostic, null);
  });
});

function authState(mode: CloudPrototypeAuthState["mode"]): CloudPrototypeAuthState {
  return {
    mode,
    token: mode === "anonymous" ? null : "token",
    user: mode === "anonymous" ? null : "user@example.test",
    oidcClaims: null,
    requestedScope: "viewer",
    problem: null,
  };
}
