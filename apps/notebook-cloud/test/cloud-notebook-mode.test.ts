import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloudNotebookInteractionModeForAccess,
  cloudNotebookSelectedModeCorrectionForAccess,
} from "../viewer/cloud-notebook-mode";

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
      accessRequestStatus: "denied",
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "view",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "denied",
      catalogResolved: true,
      connectionScope: null,
      selectedMode: "edit",
    }),
    "view",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "dismissed",
      catalogResolved: true,
      connectionScope: null,
      selectedMode: "edit",
    }),
    "view",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "pending",
      catalogResolved: true,
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "edit",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "pending",
      catalogResolved: true,
      connectionScope: null,
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
      accessScope: "owner",
      connectionScope: "viewer",
      selectedMode: "edit",
    }),
    "edit",
  );
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: "pending",
      accessScope: "editor",
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
  assert.equal(
    cloudNotebookInteractionModeForAccess({
      accessRequestStatus: null,
      catalogResolved: false,
      connectionScope: null,
      selectedMode: "edit",
    }),
    "edit",
  );
});

test("cloud notebook mode correction normalizes owner edit links for view-only access", () => {
  assert.equal(
    cloudNotebookSelectedModeCorrectionForAccess({
      accessMode: "view",
      selectedMode: "edit",
    }),
    "view",
  );
  assert.equal(
    cloudNotebookSelectedModeCorrectionForAccess({
      accessMode: "edit",
      selectedMode: "edit",
    }),
    null,
  );
  assert.equal(
    cloudNotebookSelectedModeCorrectionForAccess({
      accessMode: "view",
      selectedMode: "view",
    }),
    null,
  );
});
