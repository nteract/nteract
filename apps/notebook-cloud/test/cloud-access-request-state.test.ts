import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudPrototypeAuthCarriesRequestedScope,
  projectCloudAccessRequestNotice,
  projectCloudAccessRequestTransition,
  shouldFallbackCloudEditUrlToView,
  shouldLoadOwnCloudAccessRequest,
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
        selectedMode: "edit",
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
        selectedMode: "edit",
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
        selectedMode: "edit",
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
        selectedMode: "edit",
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
        selectedMode: "edit",
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

  it("does not let a stored edit request override explicit view mode", () => {
    assert.deepEqual(
      projectCloudAccessRequestTransition({
        authState: authState({ mode: "anonymous", requestedScope: null }),
        connectionScope: "viewer",
        hasAppSession: true,
        request: { status: "pending" },
        selectedMode: "view",
      }),
      {
        requestedScope: null,
        selectedMode: null,
        refreshPrototypeAuth: false,
        retryLiveConnection: false,
      },
    );
  });

  it("keeps stored edit-request notices passive in explicit view mode", () => {
    assert.equal(
      projectCloudAccessRequestNotice({
        error: null,
        request: { status: "pending" },
        selectedMode: "view",
      }),
      null,
    );
    assert.equal(
      projectCloudAccessRequestNotice({
        error: null,
        request: { status: "denied" },
        selectedMode: "view",
      }),
      null,
    );
  });

  it("projects user-facing edit-request notices for explicit edit mode", () => {
    assert.deepEqual(
      projectCloudAccessRequestNotice({
        error: null,
        request: { status: "pending" },
        selectedMode: "edit",
      }),
      {
        kind: "pending",
        tone: "info",
        title: "Edit access requested.",
        message: "The owner can review this request from the sharing panel.",
      },
    );
    assert.deepEqual(
      projectCloudAccessRequestNotice({
        error: "network failed",
        request: null,
        selectedMode: "view",
      }),
      {
        kind: "error",
        tone: "error",
        title: "Edit request failed.",
        message: "network failed",
      },
    );
  });

  it("loads own edit-request state only for explicit editable viewer intent", () => {
    assert.equal(
      shouldLoadOwnCloudAccessRequest({
        canUseAuthenticatedCloudApi: true,
        catalogGrantsDocumentEdit: false,
        connectionScope: "viewer",
        editAccessRequested: true,
        hasBrowserAppIdentity: true,
        selectedMode: "edit",
      }),
      true,
    );
    assert.equal(
      shouldLoadOwnCloudAccessRequest({
        canUseAuthenticatedCloudApi: true,
        catalogGrantsDocumentEdit: false,
        connectionScope: "viewer",
        editAccessRequested: false,
        hasBrowserAppIdentity: true,
        selectedMode: "edit",
      }),
      false,
    );
    assert.equal(
      shouldLoadOwnCloudAccessRequest({
        canUseAuthenticatedCloudApi: true,
        catalogGrantsDocumentEdit: false,
        connectionScope: "viewer",
        editAccessRequested: true,
        hasBrowserAppIdentity: true,
        selectedMode: "view",
      }),
      false,
    );
    assert.equal(
      shouldLoadOwnCloudAccessRequest({
        canUseAuthenticatedCloudApi: true,
        catalogGrantsDocumentEdit: true,
        connectionScope: "viewer",
        editAccessRequested: true,
        hasBrowserAppIdentity: true,
        selectedMode: "edit",
      }),
      false,
    );
    assert.equal(
      shouldLoadOwnCloudAccessRequest({
        canUseAuthenticatedCloudApi: true,
        catalogGrantsDocumentEdit: false,
        connectionScope: "editor",
        editAccessRequested: true,
        hasBrowserAppIdentity: true,
        selectedMode: "edit",
      }),
      false,
    );
  });

  it("falls owner-style edit URLs back to view mode for view-only access", () => {
    assert.equal(
      shouldFallbackCloudEditUrlToView({
        catalogGrantsDocumentEdit: false,
        catalogResolved: true,
        editAccessRequested: false,
        selectedMode: "edit",
      }),
      true,
    );
    assert.equal(
      shouldFallbackCloudEditUrlToView({
        catalogGrantsDocumentEdit: false,
        catalogResolved: true,
        editAccessRequested: true,
        selectedMode: "edit",
      }),
      false,
    );
    assert.equal(
      shouldFallbackCloudEditUrlToView({
        catalogGrantsDocumentEdit: true,
        catalogResolved: true,
        editAccessRequested: false,
        selectedMode: "edit",
      }),
      false,
    );
    assert.equal(
      shouldFallbackCloudEditUrlToView({
        catalogGrantsDocumentEdit: false,
        catalogResolved: false,
        editAccessRequested: false,
        selectedMode: "edit",
      }),
      false,
    );
    assert.equal(
      shouldFallbackCloudEditUrlToView({
        catalogGrantsDocumentEdit: false,
        catalogResolved: true,
        editAccessRequested: false,
        selectedMode: "view",
      }),
      false,
    );
  });
});
