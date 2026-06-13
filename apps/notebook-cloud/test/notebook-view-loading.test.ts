import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC,
  CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
} from "../viewer/connection-diagnostics.ts";
import {
  projectCloudNotebookViewLoading,
  projectCloudNotebookViewSurface,
} from "../viewer/notebook-view-loading.ts";

const ready = { kind: "ready" as const, message: "Ready" };
const loading = { kind: "loading" as const, message: "Connecting to live notebook room..." };

function project(overrides: Partial<Parameters<typeof projectCloudNotebookViewLoading>[0]> = {}) {
  return projectCloudNotebookViewLoading({
    bodyAccessBlocked: false,
    cellCount: 0,
    canEditStructure: false,
    connectionError: null,
    editAccessPending: false,
    emptyRoomGraceElapsed: true,
    hasAccessDiagnostic: false,
    hasReadableSnapshot: false,
    liveMaterialized: false,
    status: ready,
    ...overrides,
  });
}

describe("cloud notebook body loading projection", () => {
  it("does not show notebook loading placeholders for resolved no-access pages", () => {
    assert.equal(
      project({
        bodyAccessBlocked: true,
        connectionError: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
        hasAccessDiagnostic: true,
        status: { kind: "error", message: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC },
      }),
      false,
    );
  });

  it("keeps loading placeholders for real connection errors without readable content", () => {
    assert.equal(
      project({
        connectionError: "cloud sync socket closed",
        status: { kind: "error", message: "cloud sync socket closed" },
      }),
      true,
    );
  });

  it("keeps startup, pending edit, empty-room grace, and editable bootstrap states loading", () => {
    assert.equal(project({ status: loading }), true);
    assert.equal(project({ editAccessPending: true }), true);
    assert.equal(
      project({
        emptyRoomGraceElapsed: false,
        status: { kind: "empty", message: "This notebook room has no cells yet." },
      }),
      true,
    );
    assert.equal(project({ canEditStructure: true }), true);
  });

  it("does not show loading placeholders over readable snapshots", () => {
    assert.equal(
      project({
        connectionError: "cloud sync socket closed",
        hasReadableSnapshot: true,
        status: { kind: "error", message: "cloud sync socket closed" },
      }),
      false,
    );
  });

  it("does not render the notebook view when content access is blocked", () => {
    assert.deepEqual(
      projectCloudNotebookViewSurface({
        bodyAccessBlocked: true,
        cellCount: 0,
        canEditStructure: false,
        connectionError: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
        editAccessPending: false,
        emptyRoomGraceElapsed: true,
        hasAccessDiagnostic: true,
        hasReadableSnapshot: false,
        liveMaterialized: false,
        status: { kind: "error", message: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC },
      }),
      {
        isLoading: false,
        shouldRenderNotebookView: false,
      },
    );
  });

  it("keeps non-blocking access diagnostics on the normal notebook surface", () => {
    assert.deepEqual(
      projectCloudNotebookViewSurface({
        bodyAccessBlocked: false,
        cellCount: 1,
        canEditStructure: false,
        connectionError: CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC,
        editAccessPending: false,
        emptyRoomGraceElapsed: true,
        hasAccessDiagnostic: true,
        hasReadableSnapshot: true,
        liveMaterialized: true,
        status: { kind: "error", message: CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC },
      }),
      {
        isLoading: false,
        shouldRenderNotebookView: true,
      },
    );
  });
});
