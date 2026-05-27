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
});

function aclRow(scope: NotebookAclRow["scope"]): NotebookAclRow {
  return {
    notebook_id: "demo",
    subject: "user:dev:alice",
    scope,
    created_at: "2026-05-27T00:00:00.000Z",
  };
}
