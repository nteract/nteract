import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLOUD_CONNECTION_EDIT_ACCESS_APPROVED_DIAGNOSTIC,
  CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC,
  CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
  cloudConnectionErrorWithAccessDiagnostic,
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

describe("late access diagnostics never displace a terminal WASM-failure notice", () => {
  const ASSET_FAILURE =
    "runtimed WASM asset failed: Failed to fetch runtimed WASM (404): https://wasm.example/runtimed_wasm_bg.wasm";

  it("keeps the WASM failure when the diagnostic resolves after it surfaced", () => {
    assert.equal(
      cloudConnectionErrorWithAccessDiagnostic(ASSET_FAILURE, CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC),
      ASSET_FAILURE,
    );
  });

  it("applies the diagnostic over ordinary or absent connection errors", () => {
    assert.equal(
      cloudConnectionErrorWithAccessDiagnostic(null, CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC),
      CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
    );
    assert.equal(
      cloudConnectionErrorWithAccessDiagnostic(
        "cloud sync socket closed (1006)",
        CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
      ),
      CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
    );
  });

  // Session wiring pins (the hook cannot run under node): the kick-time
  // guard on the connect-failure path, and BOTH late-resolution sites
  // merging through the resolution-time guard.
  it("the session guards at kick time and at every resolution site", () => {
    const sessionSource = readFileSync(
      new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
      "utf8",
    );
    assert.match(sessionSource, /if \(cloudConnectionErrorAcceptsAccessDiagnostic\(message\)\) \{/);
    assert.equal(
      (
        sessionSource.match(
          /setConnectionError\(\(current\) =>\s*cloudConnectionErrorWithAccessDiagnostic\(current, diagnostic\),\s*\)/g,
        ) ?? []
      ).length,
      2,
      "both diagnostic resolution sites must merge through the resolution-time guard",
    );
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
