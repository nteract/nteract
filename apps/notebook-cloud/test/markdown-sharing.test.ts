import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCloudMarkdownShareProjection,
  type CloudMarkdownDocumentAclRow,
  type CloudMarkdownDocumentInvite,
  type CloudMarkdownAccessRequest,
} from "../viewer/markdown-sharing";

describe("cloud Markdown sharing projection", () => {
  it("keeps owners first and summarizes principal access", () => {
    const projection = buildCloudMarkdownShareProjection({
      acl: [
        aclRow({ subject: "user:dev:bob", scope: "viewer" }),
        aclRow({ subject: "user:dev:alice", scope: "owner" }),
        aclRow({ subject: "user:dev:carol", scope: "editor" }),
      ],
    });

    assert.deepEqual(
      projection.rows.map((row) => [row.label, row.badge, row.removable]),
      [
        ["user:dev:alice", "Owner", false],
        ["user:dev:carol", "Can edit", true],
        ["user:dev:bob", "Can view", true],
      ],
    );
    assert.equal(projection.summary, "3 people");
  });

  it("uses profile display metadata when available", () => {
    const projection = buildCloudMarkdownShareProjection({
      acl: [
        aclRow({
          subject: "user:dev:bob",
          scope: "editor",
          display: {
            kind: "principal",
            label: "Bob Example",
            principal: "user:dev:bob",
            email: "bob@example.com",
          },
        }),
      ],
    });

    assert.deepEqual(
      projection.rows.map((row) => [row.label, row.detail, row.badge]),
      [["Bob Example", "bob@example.com", "Can edit"]],
    );
  });

  it("includes pending invites and edit requests in the access summary", () => {
    const projection = buildCloudMarkdownShareProjection({
      acl: [aclRow({ subject: "user:dev:alice", scope: "owner" })],
      invites: [
        inviteRow({
          id: "invite-bob",
          email: "bob@example.com",
          scope: "editor",
        }),
      ],
      accessRequests: [
        accessRequestRow({
          id: "request-carol",
          requester_principal: "user:dev:carol",
          display: {
            kind: "principal",
            label: "Carol Example",
            principal: "user:dev:carol",
            email: "carol@example.com",
          },
        }),
      ],
    });

    assert.deepEqual(
      projection.rows.map((row) => [row.kind, row.label, row.badge, row.stateLabel]),
      [
        ["acl", "user:dev:alice", "Owner", null],
        ["invite", "b...b@example.com", "Can edit", "Pending"],
        ["access_request", "Carol Example", "Can edit", "Requested"],
      ],
    );
    assert.equal(projection.summary, "1 person, 1 invite, 1 request");
  });
});

function aclRow(overrides: Partial<CloudMarkdownDocumentAclRow>): CloudMarkdownDocumentAclRow {
  return {
    document_id: "doc-1",
    subject_kind: "principal",
    subject: "user:dev:alice",
    scope: "owner",
    created_at: "2026-06-15T00:00:00.000Z",
    updated_at: "2026-06-15T00:00:00.000Z",
    created_by_actor_label: "user:dev:alice/browser:tab",
    ...overrides,
  };
}

function inviteRow(overrides: Partial<CloudMarkdownDocumentInvite>): CloudMarkdownDocumentInvite {
  return {
    id: "invite-1",
    document_id: "doc-1",
    email: "invitee@example.com",
    provider_hint: null,
    scope: "viewer",
    status: "pending",
    invited_by_actor_label: "user:dev:alice/browser:tab",
    accepted_by_principal: null,
    created_at: "2026-06-15T00:00:00.000Z",
    expires_at: null,
    accepted_at: null,
    revoked_at: null,
    revoked_by_actor_label: null,
    ...overrides,
  };
}

function accessRequestRow(
  overrides: Partial<CloudMarkdownAccessRequest>,
): CloudMarkdownAccessRequest {
  return {
    id: "request-1",
    document_id: "doc-1",
    requester_principal: "user:dev:requester",
    scope: "editor",
    status: "pending",
    requested_by_actor_label: "user:dev:requester/browser:tab",
    resolved_by_actor_label: null,
    created_at: "2026-06-15T00:00:00.000Z",
    updated_at: "2026-06-15T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}
