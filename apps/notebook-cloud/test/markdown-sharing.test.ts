import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCloudMarkdownShareProjection,
  type CloudMarkdownDocumentAclRow,
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
