import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudPrototypeAuthCarriesRequestedScope,
  projectCloudAccessRequestTransition,
} from "../viewer/cloud-access-request-state";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";

function authState(
  overrides: Partial<Pick<CloudPrototypeAuthState, "mode" | "requestedScope">> = {},
): Pick<CloudPrototypeAuthState, "mode" | "requestedScope"> {
  return {
    mode: "oidc",
    requestedScope: "viewer",
    ...overrides,
  };
}

describe("cloud access-request state projection", () => {
  it("does not refresh prototype auth scope for cookie-backed pending edit requests", () => {
    assert.deepEqual(
      projectCloudAccessRequestTransition({
        authState: authState({ mode: "anonymous", requestedScope: null }),
        connectionScope: "viewer",
        hasAppSession: true,
        request: { status: "pending" },
      }),
      {
        requestedScope: "editor",
        selectedMode: "edit",
        refreshPrototypeAuth: false,
        retryLiveConnection: false,
      },
    );
  });

  it("refreshes token-backed prototype auth when pending edit scope changes", () => {
    assert.deepEqual(
      projectCloudAccessRequestTransition({
        authState: authState({ mode: "oidc", requestedScope: "viewer" }),
        connectionScope: "viewer",
        hasAppSession: false,
        request: { status: "pending" },
      }),
      {
        requestedScope: "editor",
        selectedMode: "edit",
        refreshPrototypeAuth: true,
        retryLiveConnection: false,
      },
    );
  });

  it("retries the live room once edit access is approved", () => {
    assert.deepEqual(
      projectCloudAccessRequestTransition({
        authState: authState({ mode: "dev", requestedScope: "editor" }),
        connectionScope: "viewer",
        hasAppSession: false,
        request: { status: "approved" },
      }),
      {
        requestedScope: "editor",
        selectedMode: "edit",
        refreshPrototypeAuth: false,
        retryLiveConnection: true,
      },
    );
  });

  it("returns token-backed editors to viewer scope when no edit request is active", () => {
    assert.deepEqual(
      projectCloudAccessRequestTransition({
        authState: authState({ mode: "oidc", requestedScope: "editor" }),
        connectionScope: "viewer",
        hasAppSession: false,
        request: null,
      }),
      {
        requestedScope: "viewer",
        selectedMode: "view",
        refreshPrototypeAuth: true,
        retryLiveConnection: false,
      },
    );
  });

  it("ignores stale request state once the catalog already grants document edit access", () => {
    assert.deepEqual(
      projectCloudAccessRequestTransition({
        accessScope: "owner",
        authState: authState({ mode: "oidc", requestedScope: "viewer" }),
        connectionScope: "viewer",
        hasAppSession: true,
        request: { status: "pending" },
      }),
      {
        requestedScope: null,
        selectedMode: null,
        refreshPrototypeAuth: false,
        retryLiveConnection: false,
      },
    );
  });

  it("treats app-session auth as the access source of truth over local prototype scope", () => {
    assert.equal(cloudPrototypeAuthCarriesRequestedScope("dev", true), true);
    assert.equal(cloudPrototypeAuthCarriesRequestedScope("oidc", false), true);
    assert.equal(cloudPrototypeAuthCarriesRequestedScope("oidc", true), false);
    assert.equal(cloudPrototypeAuthCarriesRequestedScope("anonymous", true), false);
  });
});
