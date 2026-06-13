import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudNotebookInteractionModeForAccess } from "../viewer/cloud-notebook-mode";

test("cloud notebook edit links stay view-only for viewers without an access request", () => {
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: null,
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "view",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "rejected",
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "view",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "pending",
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "edit",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "approved",
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "edit",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: null,
      connectionScope: "editor",
      selectedMode: "edit",
    }),
    "edit",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: null,
      connectionScope: "owner",
      selectedMode: "edit",
    }),
    "edit",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "pending",
      connectionScope: "viewer",
      selectedMode: "view",
    }),
    "view",
  );
});
