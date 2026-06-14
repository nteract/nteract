import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CloudSharingFactsStore,
  projectCloudSharingFacts,
  type CloudSharingSourceFacts,
} from "../viewer/cloud-sharing-facts";
import type {
  CloudNotebookAccessRequest,
  CloudNotebookAclRow,
  CloudNotebookInvite,
} from "../viewer/sharing-client";

describe("cloud sharing facts projection", () => {
  it("projects loading, invite, copy, and public-link facts for the share panel", () => {
    const loading = projectCloudSharingFacts({
      accessRequests: [],
      acl: [],
      copyState: "idle",
      inviteEmail: "bad input",
      invites: [],
      loadState: "loading",
    });

    assert.equal(loading.showInitialAccessLoading, true);
    assert.equal(loading.publicEnabled, false);
    assert.equal(loading.inviteReady, false);
    assert.equal(loading.copyLinkLabel, "Copy link");
    assert.equal(loading.compactCopyLinkLabel, "Copy");

    const ready = projectCloudSharingFacts({
      accessRequests: [],
      acl: [aclRow({ subject_kind: "public", subject: "anonymous", scope: "viewer" })],
      copyState: "copied",
      inviteEmail: "Quill@Example.COM ",
      invites: [],
      loadState: "ready",
    });

    assert.equal(ready.showInitialAccessLoading, false);
    assert.equal(ready.publicEnabled, true);
    assert.equal(ready.inviteReady, true);
    assert.equal(ready.copyLinkLabel, "Copied link");
    assert.equal(ready.compactCopyLinkLabel, "Copied");
  });

  it("keeps owner access, invites, runtime peers, and edit requests in one ledger projection", () => {
    const projection = projectCloudSharingFacts({
      accessRequests: [accessRequestRow({ id: "request-bob" })],
      acl: [
        aclRow({ subject: "user:anaconda:owner", scope: "owner" }),
        aclRow({ subject: "runtime:agent", scope: "runtime_peer" }),
      ],
      copyState: "failed",
      inviteEmail: "friend@example.com",
      invites: [inviteRow({ email: "friend@example.com", scope: "editor" })],
      loadState: "ready",
    });

    assert.equal(projection.copyLinkLabel, "Copy failed");
    assert.equal(projection.compactCopyLinkLabel, "Failed");
    assert.equal(projection.inviteReady, true);
    assert.deepEqual(
      projection.access.notebookAccessRows.map((row) => [row.kind, row.label, row.badge]),
      [
        ["acl", "owner", "Owner"],
        ["invite", "f...d@example.com", "Can edit"],
      ],
    );
    assert.deepEqual(
      projection.access.runtimeAccessRows.map((row) => [row.kind, row.label, row.badge]),
      [["acl", "agent", "Runtime"]],
    );
    assert.deepEqual(
      projection.access.accessRequestRows.map((row) => [row.kind, row.label, row.badge]),
      [["access_request", "bob", "Can edit"]],
    );
    assert.equal(projection.access.accessRequestSummary, "1 request");
  });

  it("reuses stable access projections for equivalent source facts", () => {
    const acl = [aclRow({ subject: "user:anaconda:owner", scope: "owner" })];
    const invites = [inviteRow({ email: "friend@example.com", scope: "viewer" })];
    const accessRequests = [accessRequestRow({ id: "request-bob" })];

    const first = projectCloudSharingFacts({
      accessRequests,
      acl,
      copyState: "idle",
      inviteEmail: "friend@example.com",
      invites,
      loadState: "ready",
    });
    const second = projectCloudSharingFacts({
      accessRequests: [{ ...accessRequests[0] }],
      acl: [{ ...acl[0] }],
      copyState: "idle",
      inviteEmail: "friend@example.com",
      invites: [{ ...invites[0] }],
      loadState: "ready",
    });
    const changed = projectCloudSharingFacts({
      accessRequests,
      acl,
      copyState: "idle",
      inviteEmail: "friend@example.com",
      invites,
      loadState: "ready",
    });

    assert.equal(first.access, second.access);
    assert.equal(first.access.notebookAccessRows, second.access.notebookAccessRows);
    assert.equal(first.access.accessRequestRows, second.access.accessRequestRows);
    assert.equal(changed.access, first.access);
    assert.equal(Object.isFrozen(first), true);
  });

  it("deduplicates equivalent share source updates through RxJS selectors", () => {
    const store = new CloudSharingFactsStore(sourceFacts());
    const initialSnapshot = store.snapshot;
    assert.equal(store.snapshot, initialSnapshot);
    store.set({
      ...sourceFacts(),
      acl: [aclRow({ subject: "user:anaconda:owner", scope: "owner" })],
    });
    assert.equal(store.snapshot, initialSnapshot);

    const copyLabels: string[] = [];
    const projectionKeys: string[] = [];
    const copySub = store
      .select((projection) => projection.copyLinkLabel)
      .subscribe((label) => copyLabels.push(label));
    const projectionSub = store.projection$.subscribe((projection) => {
      projectionKeys.push(
        [
          projection.copyLinkLabel,
          projection.publicEnabled ? "public" : "private",
          projection.inviteReady ? "invite-ready" : "invite-not-ready",
          projection.access.notebookAccessSummary ?? "",
          projection.access.accessRequestSummary ?? "",
        ].join(":"),
      );
    });

    store.update((current) => ({
      ...current,
      copyState: "copied",
    }));
    store.update((current) => ({
      ...current,
      accessRequests: [accessRequestRow({ id: "request-bob" })],
    }));
    store.update((current) => ({
      ...current,
      accessRequests: [{ ...accessRequestRow({ id: "request-bob" }) }],
    }));

    copySub.unsubscribe();
    projectionSub.unsubscribe();

    assert.deepEqual(copyLabels, ["Copy link", "Copied link"]);
    assert.deepEqual(projectionKeys, [
      "Copy link:private:invite-ready:1 person:",
      "Copied link:private:invite-ready:1 person:",
      "Copied link:private:invite-ready:1 person:1 request",
    ]);
  });

  it("updates snapshots before flushing render-phase subscriber notifications", () => {
    const store = new CloudSharingFactsStore(sourceFacts());
    const copyLabels: string[] = [];
    const sub = store
      .select((projection) => projection.copyLinkLabel)
      .subscribe((label) => copyLabels.push(label));

    store.set({ ...sourceFacts(), copyState: "copied" }, { notify: false });

    assert.equal(store.snapshot.copyLinkLabel, "Copied link");
    assert.deepEqual(copyLabels, ["Copy link"]);

    store.flush();
    store.flush();
    sub.unsubscribe();

    assert.deepEqual(copyLabels, ["Copy link", "Copied link"]);
  });
});

function sourceFacts(): CloudSharingSourceFacts {
  return {
    accessRequests: [],
    acl: [aclRow({ subject: "user:anaconda:owner", scope: "owner" })],
    copyState: "idle",
    inviteEmail: "friend@example.com",
    invites: [],
    loadState: "ready",
  };
}

function aclRow(overrides: Partial<CloudNotebookAclRow> = {}): CloudNotebookAclRow {
  return {
    notebook_id: "notebook-1",
    subject_kind: "principal",
    subject: "user:anaconda:alice",
    scope: "viewer",
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    created_by_actor_label: "user:anaconda:owner/browser:preview",
    ...overrides,
  };
}

function inviteRow(overrides: Partial<CloudNotebookInvite> = {}): CloudNotebookInvite {
  return {
    id: "invite-1",
    notebook_id: "notebook-1",
    email: "friend@example.com",
    provider_hint: null,
    scope: "viewer",
    status: "pending",
    invited_by_actor_label: "user:anaconda:owner/browser:preview",
    accepted_by_principal: null,
    created_at: "2026-06-14T00:00:00.000Z",
    expires_at: null,
    accepted_at: null,
    revoked_at: null,
    revoked_by_actor_label: null,
    ...overrides,
  };
}

function accessRequestRow(
  overrides: Partial<CloudNotebookAccessRequest> = {},
): CloudNotebookAccessRequest {
  return {
    id: "request-1",
    notebook_id: "notebook-1",
    requester_principal: "user:anaconda:bob",
    scope: "editor",
    status: "pending",
    requested_by_actor_label: "user:anaconda:bob/browser:preview",
    resolved_by_actor_label: null,
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}
