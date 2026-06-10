import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aclRowsCoverScope } from "../src/authorization.ts";
import type { NotebookAclRow } from "../src/storage.ts";

describe("notebook cloud authorization", () => {
  it("does not derive runtime_peer authority from human write roles", () => {
    assert.equal(aclRowsCoverScope([aclRow("editor")], "runtime_peer"), false);
    assert.equal(aclRowsCoverScope([aclRow("owner")], "runtime_peer"), false);
    assert.equal(aclRowsCoverScope([aclRow("runtime_peer")], "editor"), false);
    assert.equal(aclRowsCoverScope([aclRow("runtime_peer")], "owner"), false);
    assert.equal(aclRowsCoverScope([aclRow("runtime_peer")], "runtime_peer"), true);
  });

  // Full cover matrix (HCA-2): each granted row covers exactly the scopes it
  // should, with no capability bleeding between human roles and the runtime
  // lane. Rows are granted scopes; columns are requested scopes.
  it("covers the full grant/request matrix", () => {
    const matrix: Array<[NotebookAclRow["scope"], Record<NotebookAclRow["scope"], boolean>]> = [
      ["viewer", { viewer: true, editor: false, runtime_peer: false, owner: false }],
      // An editor row covers exactly {viewer, editor}.
      ["editor", { viewer: true, editor: true, runtime_peer: false, owner: false }],
      // A runtime_peer grant carries read (it must sync the docs), so it
      // covers a viewer request — but never editor/owner.
      ["runtime_peer", { viewer: true, editor: false, runtime_peer: true, owner: false }],
      ["owner", { viewer: true, editor: true, runtime_peer: false, owner: true }],
    ];
    for (const [granted, requests] of matrix) {
      for (const [requested, expected] of Object.entries(requests)) {
        assert.equal(
          aclRowsCoverScope([aclRow(granted)], requested as NotebookAclRow["scope"]),
          expected,
          `granted=${granted} requested=${requested}`,
        );
      }
    }
  });
});

function aclRow(scope: NotebookAclRow["scope"]): NotebookAclRow {
  return {
    notebook_id: "demo",
    subject_kind: "principal",
    subject: "user:dev:alice",
    scope,
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    created_by_actor_label: "system/test",
  };
}
