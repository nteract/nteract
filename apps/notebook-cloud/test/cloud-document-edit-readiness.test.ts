import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectCloudNotebookDocumentEditReadiness } from "../viewer/edit-access";

describe("cloud notebook document edit readiness projection", () => {
  it("waits for the writable live room when catalog says the user owns the notebook", () => {
    assert.deepEqual(
      projectCloudNotebookDocumentEditReadiness({
        accessScope: "owner",
        connectionError: null,
        connectionPeerId: null,
        connectionScope: "viewer",
        selectedMode: "edit",
        statusKind: "loading",
      }),
      {
        canAcceptCellMutations: false,
        selectedEditModeWaitingForRoom: true,
        editAccessRequestPending: true,
      },
    );
  });

  it("allows document edits only after the live room grants editor or owner scope", () => {
    assert.deepEqual(
      projectCloudNotebookDocumentEditReadiness({
        accessScope: "editor",
        connectionError: null,
        connectionPeerId: "peer-1",
        connectionScope: "editor",
        selectedMode: "edit",
        statusKind: "ready",
      }),
      {
        canAcceptCellMutations: true,
        selectedEditModeWaitingForRoom: false,
        editAccessRequestPending: false,
      },
    );
  });

  it("does not treat viewer room access as editable even with a connected peer", () => {
    assert.deepEqual(
      projectCloudNotebookDocumentEditReadiness({
        accessScope: "viewer",
        connectionError: null,
        connectionPeerId: "peer-1",
        connectionScope: "viewer",
        selectedMode: "edit",
        statusKind: "ready",
      }),
      {
        canAcceptCellMutations: false,
        selectedEditModeWaitingForRoom: false,
        editAccessRequestPending: false,
      },
    );
  });

  it("keeps edit mode pending when catalog grants edit access but the live room is still viewer", () => {
    assert.deepEqual(
      projectCloudNotebookDocumentEditReadiness({
        accessScope: "owner",
        connectionError: null,
        connectionPeerId: "peer-1",
        connectionScope: "viewer",
        selectedMode: "edit",
        statusKind: "ready",
      }),
      {
        canAcceptCellMutations: false,
        selectedEditModeWaitingForRoom: true,
        editAccessRequestPending: true,
      },
    );
  });

  it("shows connection errors as errors instead of pending edit access", () => {
    assert.deepEqual(
      projectCloudNotebookDocumentEditReadiness({
        accessScope: "owner",
        connectionError: "socket closed",
        connectionPeerId: null,
        connectionScope: null,
        selectedMode: "edit",
        statusKind: "loading",
      }),
      {
        canAcceptCellMutations: false,
        selectedEditModeWaitingForRoom: false,
        editAccessRequestPending: false,
      },
    );
  });
});
