import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PAGE_QUOTA as WORKER_MAX_PAGE_QUOTA } from "../worker/page-quota.mjs";
import {
  MAX_PAGE_QUOTA,
  TRASH_REQUESTS,
  confirmPurge,
  listTrash,
  previewPurge,
  purgeSummary,
  restorePage,
} from "./trash.mjs";

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

/** A list_pages stub over `total` trashed Pages, `perPage` at a time. */
function trashOf(total, perPage = 100) {
  const requests = [];
  const tool = async (operation, args = {}) => {
    assert.equal(operation, "list_pages");
    assert.equal(args.in_trash, true);
    requests.push(args.cursor ?? null);
    const start = args.cursor ? Number(args.cursor.slice("cursor-".length)) : 0;
    const end = Math.min(total, start + perPage);
    return {
      pages: Array.from({ length: end - start }, (_, index) => ({
        page_id: `page-${start + index}`,
        state: "trashed",
      })),
      next_cursor: end < total ? `cursor-${end}` : null,
    };
  };
  return { tool, requests };
}

test("Trash lists every Page past 10,000, following cursors to the end", async () => {
  // A paused account at the largest limit can hold twice that in Trash.
  const total = 2 * MAX_PAGE_QUOTA;
  const { tool, requests } = trashOf(total);
  const pages = await listTrash(tool);
  assert.equal(pages.length, total);
  assert.equal(new Set(pages.map((page) => page.page_id)).size, total);
  assert.equal(requests.length, total / 100);
  // Short pages, as a scan stopped by its bound returns, still reach the end.
  const short = trashOf(12_345, 37);
  assert.equal((await listTrash(short.tool)).length, 12_345);
});

test("a Trash listing that never ends throws instead of showing part of it", async () => {
  const tool = async () => ({ pages: [{ page_id: "again" }], next_cursor: "more" });
  await assert.rejects(listTrash(tool), /more Pages than this view can list/);
});

test("the viewer's largest limit matches the Worker's", () => {
  assert.equal(MAX_PAGE_QUOTA, WORKER_MAX_PAGE_QUOTA);
  assert.ok(TRASH_REQUESTS * 100 >= 4 * MAX_PAGE_QUOTA);
});
