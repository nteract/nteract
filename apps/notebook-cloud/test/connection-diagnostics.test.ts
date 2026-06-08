import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC,
  CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC,
  diagnoseCloudConnectionAccess,
} from "../viewer/connection-diagnostics.ts";
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
      authState: authState("dev"),
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(input, "/api/n/private/access-requests");
        assert.equal(headers.get("x-notebook-cloud-dev-token"), "token");
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

  it("reports the viewer's pending edit request when editor scope was requested", async () => {
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/shared/access-requests",
      authState: authState("oidc", { requestedScope: "editor" }),
      fetchImpl: async () =>
        Response.json({
          access_requests: [
            {
              scope: "editor",
              status: "pending",
            },
          ],
        }),
    });

    assert.equal(diagnostic, CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC);
  });

  it("reports the viewer's approved edit request when editor scope was requested", async () => {
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/shared/access-requests",
      authState: authState("anonymous", { requestedScope: "editor" }),
      hasAppSession: true,
      fetchImpl: async () =>
        Response.json({
          access_requests: [
            {
              scope: "editor",
              status: "approved",
            },
          ],
        }),
    });

    assert.equal(diagnostic, CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC);
  });

  it("does not treat owner access-request lists as the viewer's own request state", async () => {
    const diagnostic = await diagnoseCloudConnectionAccess({
      accessRequestsEndpoint: "/api/n/shared/access-requests",
      authState: authState("oidc", { requestedScope: "editor" }),
      fetchImpl: async () =>
        Response.json({
          access_requests: [
            {
              scope: "editor",
              status: "pending",
            },
            {
              scope: "editor",
              status: "approved",
            },
          ],
        }),
    });

    assert.equal(diagnostic, null);
  });
});

function authState(
  mode: CloudPrototypeAuthState["mode"],
  options: { requestedScope?: CloudPrototypeAuthState["requestedScope"] } = {},
): CloudPrototypeAuthState {
  return {
    mode,
    token: mode === "anonymous" ? null : "token",
    user: mode === "anonymous" ? null : "user@example.test",
    oidcClaims: null,
    requestedScope: options.requestedScope ?? "viewer",
    problem: null,
  };
}
