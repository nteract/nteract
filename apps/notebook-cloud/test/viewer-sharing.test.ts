import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCloudShareAccessProjection,
  buildCloudShareAccessRows,
  clearCloudShareAccessRowsCachesForTests,
  cloudShareAccessSummary,
  hasPublicViewerAccess,
  normalizeShareInviteEmail,
  scopeLabel,
  type CloudNotebookAclRow,
  type CloudNotebookAccessRequest,
  type CloudNotebookInvite,
} from "../viewer/sharing-client.ts";

describe("cloud viewer sharing client", () => {
  it("orders current access like the sharing dialog expects", () => {
    const acl: CloudNotebookAclRow[] = [
      aclRow({
        subject_kind: "public",
        subject: "anonymous",
        scope: "viewer",
        display: { kind: "public_viewer", label: "Anyone with the link" },
      }),
      aclRow({
        subject: "user:anaconda:bob",
        scope: "editor",
        display: {
          kind: "principal",
          label: "Bob Example",
          principal: "user:anaconda:bob",
          email: "bob@example.com",
        },
      }),
      aclRow({
        subject: "user:anaconda:alice",
        scope: "owner",
        display: {
          kind: "principal",
          label: "Alice Owner",
          principal: "user:anaconda:alice",
          email: "alice@example.com",
        },
      }),
    ];
    const invites: CloudNotebookInvite[] = [
      inviteRow({ id: "invite-1", email: "carol@example.com", scope: "viewer" }),
      inviteRow({ id: "invite-2", email: "done@example.com", status: "accepted" }),
    ];
    const accessRequests: CloudNotebookAccessRequest[] = [
      accessRequestRow({
        id: "request-1",
        requester_principal: "user:anaconda:dana",
        display: {
          kind: "principal",
          label: "Dana Requester",
          principal: "user:anaconda:dana",
          email: "dana@example.com",
        },
      }),
      accessRequestRow({ id: "request-2", status: "denied" }),
    ];

    const rows = buildCloudShareAccessRows({ acl, invites, accessRequests });

    assert.deepEqual(
      rows.map((row) => [row.kind, row.label, row.badge, row.stateLabel, row.removable]),
      [
        ["acl", "Alice Owner", "Owner", null, false],
        ["acl", "Bob Example", "Can edit", null, true],
        ["acl", "Public link", "Can view", "Enabled", true],
        ["invite", "c...l@example.com", "Can view", "Pending", true],
        ["access_request", "Dana Requester", "Can edit", "Requested", false],
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.title),
      [
        "alice@example.com",
        "bob@example.com",
        "Anyone with the link",
        "carol@example.com",
        "dana@example.com",
      ],
    );
    assert.equal(cloudShareAccessSummary(rows), "2 people, public link, 1 invite, 1 request");
  });

  it("projects runtime peer access separately from notebook collaborators", () => {
    const acl: CloudNotebookAclRow[] = [
      aclRow({
        subject: "user:anaconda:owner",
        scope: "owner",
        display: {
          kind: "principal",
          label: "Owner User",
          principal: "user:anaconda:owner",
          email: "owner@example.com",
        },
      }),
      aclRow({
        subject: "user:anaconda:runtime",
        scope: "runtime_peer",
        display: {
          kind: "principal",
          label: "Lab Runtime",
          principal: "user:anaconda:runtime",
          email: "runtime@example.com",
        },
      }),
    ];
    const invites = [inviteRow({ id: "invite-runtime-split", email: "bob@example.com" })];
    const projection = buildCloudShareAccessProjection({ acl, invites });

    assert.deepEqual(
      projection.notebookAccessRows.map((row) => [row.label, row.badge, row.removable]),
      [
        ["Owner User", "Owner", false],
        ["b...b@example.com", "Can edit", true],
      ],
    );
    assert.deepEqual(
      projection.runtimeAccessRows.map((row) => [row.label, row.detail, row.badge, row.removable]),
      [["Lab Runtime", "Compute access for runtime peers", "Runtime", false]],
    );
    assert.equal(projection.notebookAccessSummary, "1 person, 1 invite");
    assert.equal(projection.runtimeAccessSummary, "1 runtime peer");
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.notebookAccessRows), true);
    assert.equal(Object.isFrozen(projection.runtimeAccessRows), true);
  });

  it("detects public viewer access from explicit public ACL rows", () => {
    assert.equal(
      hasPublicViewerAccess([
        aclRow({ subject_kind: "public", subject: "anonymous", scope: "viewer" }),
      ]),
      true,
    );
    assert.equal(hasPublicViewerAccess([aclRow({ subject: "user:anaconda:alice" })]), false);
  });

  it("keeps raw principals out of rows when profile display data is not available", () => {
    const rows = buildCloudShareAccessRows({
      acl: [
        aclRow({
          subject: "user:dev:fixture",
          scope: "owner",
          display: {
            kind: "principal",
            label: "user:dev:fixture",
            principal: "user:dev:fixture",
            email: null,
          },
        }),
        aclRow({ subject: "user:anaconda:alice%40example.com", scope: "editor" }),
      ],
      invites: [],
    });

    assert.deepEqual(
      rows.map((row) => [row.label, row.detail]),
      [
        ["fixture", "Dev identity"],
        ["a...e@example.com", "Anaconda identity"],
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.title),
      ["user:dev:fixture", "user:anaconda:alice%40example.com"],
    );
  });

  it("returns stable frozen rows for equivalent sharing payloads", () => {
    clearCloudShareAccessRowsCachesForTests();
    const acl = [
      aclRow({
        subject: "user:anaconda:alice",
        scope: "owner",
        display: {
          kind: "principal",
          label: "Alice Owner",
          principal: "user:anaconda:alice",
          email: "alice@example.com",
        },
      }),
    ];
    const invites = [inviteRow({ id: "invite-stable", email: "bob@example.com" })];
    const accessRequests = [accessRequestRow({ id: "request-stable" })];

    const first = buildCloudShareAccessRows({ acl, invites, accessRequests });
    const second = buildCloudShareAccessRows({
      acl: [{ ...acl[0], display: acl[0].display ? { ...acl[0].display } : undefined }],
      invites: [{ ...invites[0] }],
      accessRequests: [{ ...accessRequests[0] }],
    });
    const changed = buildCloudShareAccessRows({
      acl: [{ ...acl[0], updated_at: "2026-05-29T00:00:00.000Z" }],
      invites,
      accessRequests,
    });

    assert.equal(first, second);
    assert.equal(first[0], second[0]);
    assert.equal(first[1], second[1]);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first[0]), true);
    if (first[0]?.kind !== "acl") {
      throw new Error("expected first sharing row to be an ACL row");
    }
    assert.equal(Object.isFrozen(first[0].acl), true);
    assert.equal(Object.isFrozen(first[0].acl.display), true);
    acl[0].updated_at = "2026-06-01T00:00:00.000Z";
    assert.equal(first[0].acl.updated_at, "2026-05-28T00:00:00.000Z");
    assert.notEqual(first, changed);
    assert.notEqual(first[0], changed[0]);
  });

  it("keeps share invite email validation in the viewer before owner mutations", () => {
    assert.equal(normalizeShareInviteEmail(" Bob@Example.COM "), "bob@example.com");
    assert.equal(normalizeShareInviteEmail("not an email"), null);
    assert.equal(normalizeShareInviteEmail("bad/provider@example.com"), null);
  });

  it("labels supported cloud share scopes", () => {
    assert.equal(scopeLabel("owner"), "Owner");
    assert.equal(scopeLabel("editor"), "Can edit");
    assert.equal(scopeLabel("runtime_peer"), "Runtime");
    assert.equal(scopeLabel("viewer"), "Can view");
  });
});

function aclRow(overrides: Partial<CloudNotebookAclRow> = {}): CloudNotebookAclRow {
  return {
    notebook_id: "topic-viz",
    subject_kind: "principal",
    subject: "user:anaconda:alice",
    scope: "viewer",
    created_at: "2026-05-28T00:00:00.000Z",
    updated_at: "2026-05-28T00:00:00.000Z",
    created_by_actor_label: "user:anaconda:alice/browser:viewer",
    ...overrides,
  };
}

function inviteRow(overrides: Partial<CloudNotebookInvite> = {}): CloudNotebookInvite {
  return {
    id: "invite-1",
    notebook_id: "topic-viz",
    email: "bob@example.com",
    provider_hint: null,
    scope: "editor",
    status: "pending",
    invited_by_actor_label: "user:anaconda:alice/browser:viewer",
    accepted_by_principal: null,
    created_at: "2026-05-28T00:00:00.000Z",
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
    notebook_id: "topic-viz",
    requester_principal: "user:anaconda:bob",
    scope: "editor",
    status: "pending",
    requested_by_actor_label: "user:anaconda:bob/browser:viewer",
    resolved_by_actor_label: null,
    created_at: "2026-05-28T00:00:00.000Z",
    updated_at: "2026-05-28T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}
