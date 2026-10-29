import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmPurge, listTrash, previewPurge, purgeSummary, restorePage } from "./trash.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
function recorder() {
  const calls = [];
  const tool = async (operation, args = {}) => {
    calls.push({ operation, args });
    if (operation === "list_pages" && !args.in_trash)
      return { pages: [], retry_token: "fixture-retry-token" };
    if (operation === "list_pages") return { pages: [{ page_id: pageId, state: "trashed" }] };
    return { page_id: pageId };
  };
  return { calls, tool };
}

test("Trash operations send owner-guarded requests with fresh catalog retry authority", async () => {
  const { calls, tool } = recorder();
  assert.deepEqual(await listTrash(tool), [{ page_id: pageId, state: "trashed" }]);
  await restorePage(tool, pageId, "user:owner");
  await previewPurge(tool, pageId, "user:owner");
  await confirmPurge(tool, { page_id: pageId, preview_token: "pp1.token" }, "user:owner");
  const restore = calls.find((call) => call.operation === "restore_page").args;
  assert.equal(restore.page_id, pageId);
  assert.equal(restore.expected_principal, "user:owner");
  assert.equal(restore.retry_token, "fixture-retry-token");
  assert.match(restore.idempotency_key, /^v1_[a-f0-9]{64}_/);
  const [preview, confirm] = calls.filter((call) => call.operation === "purge_page");
  assert.deepEqual(preview.args, {
    page_id: pageId,
    action: "preview",
    expected_principal: "user:owner",
  });
  assert.equal(confirm.args.action, "confirm");
  assert.equal(confirm.args.preview_token, "pp1.token");
  assert.notEqual(confirm.args.idempotency_key, restore.idempotency_key);
});

test("permanent deletion summary names comments, collaborators and invitations", () => {
  assert.deepEqual(
    purgeSummary({
      comment_count: 1,
      collaborators: [
        { principal: "user:a", role: "editor", display_name: "Ada" },
        { principal: "user:b", role: "viewer", email: "b@example.com" },
        { principal: "user:c", role: "viewer" },
      ],
      pending_invitations: 2,
    }),
    [
      "1 comment will be deleted.",
      "3 collaborators will lose access: Ada, b@example.com, user:c.",
      "2 pending invitations will be cancelled.",
    ],
  );
  assert.deepEqual(purgeSummary({ comment_count: 0, collaborators: [] }), [
    "0 comments will be deleted.",
    "No collaborators will lose access.",
  ]);
});

test("a superseded restore or purge is reported as not applied", async () => {
  const tool = async (operation) =>
    operation === "list_pages"
      ? { pages: [], retry_token: "fixture-retry-token" }
      : { page_id: pageId, superseded: true, applied: false, state: "active" };
  await assert.rejects(restorePage(tool, pageId, "user:owner"), /changed/);
  await assert.rejects(
    confirmPurge(tool, { page_id: pageId, preview_token: "pp1.token" }, "user:owner"),
    /changed/,
  );
});
