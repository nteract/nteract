import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CloudAccessFactsStore,
  cloudCatalogAccessFacts,
  projectCloudAccessFacts,
  projectCloudAccessLiveRoomPolicy,
  type CloudAccessSourceFacts,
} from "../viewer/cloud-access-facts";
import { CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC } from "../viewer/connection-diagnostics";
import type { CloudNotebookAccessRequest } from "../viewer/sharing-client";

describe("cloud access facts projection", () => {
  it("models catalog fetch lifecycle as host-owned source facts", () => {
    assert.deepEqual(
      cloudCatalogAccessFacts({
        canUseAuthenticatedCloudApi: false,
        loadFailed: false,
        resolved: false,
        scope: "owner",
      }),
      { status: "idle", scope: null },
    );
    assert.deepEqual(
      cloudCatalogAccessFacts({
        canUseAuthenticatedCloudApi: true,
        loadFailed: false,
        resolved: false,
        scope: null,
      }),
      { status: "loading", scope: null },
    );
    assert.deepEqual(
      cloudCatalogAccessFacts({
        canUseAuthenticatedCloudApi: true,
        loadFailed: false,
        resolved: true,
        scope: "editor",
      }),
      { status: "ready", scope: "editor" },
    );
    assert.deepEqual(
      cloudCatalogAccessFacts({
        canUseAuthenticatedCloudApi: true,
        loadFailed: true,
        resolved: true,
        scope: "owner",
      }),
      { status: "error", scope: null },
    );
  });

  it("projects live-room connection policy from catalog freshness", () => {
    assert.deepEqual(
      projectCloudAccessLiveRoomPolicy({
        canUseAuthenticatedCloudApi: true,
        catalog: { status: "loading", scope: null },
      }),
      {
        shouldConnectLiveRoom: false,
        disabledStatus: { kind: "loading", message: "Checking notebook access..." },
      },
    );
    assert.deepEqual(
      projectCloudAccessLiveRoomPolicy({
        canUseAuthenticatedCloudApi: true,
        catalog: { status: "ready", scope: null },
      }),
      {
        shouldConnectLiveRoom: false,
        disabledStatus: {
          kind: "error",
          message: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
        },
      },
    );
    assert.deepEqual(
      projectCloudAccessLiveRoomPolicy({
        canUseAuthenticatedCloudApi: true,
        catalog: { status: "error", scope: null },
      }),
      { shouldConnectLiveRoom: true, disabledStatus: null },
    );
  });

  it("centralizes selected mode, request loading, notice, and shell access facts", () => {
    const projection = projectCloudAccessFacts({
      ...sourceFacts(),
      catalog: { status: "ready", scope: null },
      connection: {
        error: null,
        peerId: "peer-viewer",
        scope: "viewer",
        statusKind: "ready",
      },
      request: {
        error: null,
        latest: accessRequest({ status: "pending" }),
        requestedByUser: true,
      },
      selectedMode: "edit",
    });

    assert.equal(projection.accessConnectionScope, "viewer");
    assert.equal(projection.catalogGrantsDocumentEdit, false);
    assert.equal(projection.effectiveAccessRequest?.status, "pending");
    assert.equal(projection.selectedInteractionModeForAccess, "edit");
    assert.equal(projection.selectedModeCorrection, null);
    assert.equal(projection.shouldFallbackEditUrlToView, false);
    assert.equal(projection.shouldLoadOwnEditAccessRequest, true);
    assert.deepEqual(projection.accessRequestNotice, {
      kind: "pending",
      tone: "info",
      title: "Edit access requested.",
      message: "The owner can review this request from the sharing panel.",
    });
  });

  it("uses catalog edit grants as facts without making catalog the write authority", () => {
    const projection = projectCloudAccessFacts({
      ...sourceFacts(),
      catalog: { status: "ready", scope: "owner" },
      connection: {
        error: null,
        peerId: null,
        scope: "viewer",
        statusKind: "loading",
      },
      request: {
        error: null,
        latest: accessRequest({ status: "pending" }),
        requestedByUser: true,
      },
      selectedMode: "edit",
    });

    assert.equal(projection.catalogGrantsDocumentEdit, true);
    assert.equal(projection.accessConnectionScope, "owner");
    assert.equal(projection.effectiveAccessRequest, null);
    assert.equal(projection.shouldLoadOwnEditAccessRequest, false);
    assert.equal(projection.selectedInteractionModeForAccess, "edit");
  });

  it("keeps copied edit links view-only when fresh catalog facts deny access", () => {
    const projection = projectCloudAccessFacts({
      ...sourceFacts(),
      catalog: { status: "ready", scope: null },
      connection: {
        error: null,
        peerId: "peer-viewer",
        scope: "viewer",
        statusKind: "ready",
      },
      request: {
        error: null,
        latest: null,
        requestedByUser: false,
      },
      selectedMode: "edit",
    });

    assert.equal(projection.selectedInteractionModeForAccess, "view");
    assert.equal(projection.selectedModeCorrection, "view");
    assert.equal(projection.shouldFallbackEditUrlToView, true);
    assert.equal(projection.shouldLoadOwnEditAccessRequest, false);
  });

  it("deduplicates equivalent realtime source updates through RxJS selectors", () => {
    const store = new CloudAccessFactsStore(sourceFacts());
    const initialSnapshot = store.snapshot;
    assert.equal(store.snapshot, initialSnapshot);
    store.set({ ...sourceFacts(), connection: { ...sourceFacts().connection } });
    assert.equal(store.snapshot, initialSnapshot);

    const projectedModes: string[] = [];
    const fullProjectionKeys: string[] = [];
    const sub = store
      .select((projection) => projection.selectedInteractionModeForAccess)
      .subscribe((mode) => projectedModes.push(mode));
    const fullSub = store.projection$.subscribe((projection) => {
      fullProjectionKeys.push(
        [
          projection.accessConnectionScope,
          projection.shouldLoadOwnEditAccessRequest,
          projection.selectedInteractionModeForAccess,
        ].join(":"),
      );
    });

    store.update((current) => ({
      ...current,
      request: {
        ...current.request,
        latest: accessRequest({ status: "pending", updated_at: "2026-06-14T00:01:00.000Z" }),
        requestedByUser: true,
      },
      selectedMode: "edit",
    }));
    store.update((current) => ({
      ...current,
      connection: {
        ...current.connection,
        scope: "editor",
      },
    }));

    sub.unsubscribe();
    fullSub.unsubscribe();

    assert.deepEqual(projectedModes, ["view", "edit"]);
    assert.deepEqual(fullProjectionKeys, [
      "viewer:false:view",
      "viewer:true:edit",
      "editor:false:edit",
    ]);
  });
});

function sourceFacts(): CloudAccessSourceFacts {
  return {
    canUseAuthenticatedCloudApi: true,
    catalog: { status: "ready", scope: null },
    connection: {
      error: null,
      peerId: "peer-viewer",
      scope: "viewer",
      statusKind: "ready",
    },
    hasBrowserAppIdentity: true,
    request: {
      error: null,
      latest: null,
      requestedByUser: false,
    },
    selectedMode: "view",
  };
}

function accessRequest(
  overrides: Partial<CloudNotebookAccessRequest> = {},
): CloudNotebookAccessRequest {
  return {
    id: "request-1",
    notebook_id: "notebook-1",
    requester_principal: "user:anaconda:quill",
    scope: "editor",
    status: "pending",
    requested_by_actor_label: "user:anaconda:quill/browser:preview",
    resolved_by_actor_label: null,
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}
