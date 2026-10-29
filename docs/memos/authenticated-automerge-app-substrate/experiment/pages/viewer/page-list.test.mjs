import test from "node:test";
import assert from "node:assert/strict";
import { listAllPages, matchingPages } from "./page-list.mjs";

test("search matches visible titles case-insensitively without changing catalog identity or order", () => {
  const pages = [
    { page_id: "local", title: "Field notes", pending: true },
    { page_id: "remote", title: "Field guide" },
    { page_id: "other", title: "Planning" },
  ];
  const result = matchingPages(pages, "  FIELD  ");
  assert.deepEqual(result, pages.slice(0, 2));
  assert.equal(result[0], pages[0]);
  assert.equal(pages.length, 3);
  assert.deepEqual(matchingPages(pages, "missing"), []);
});

test("search uses the same Untitled fallback shown in the list and handles a cleared query", () => {
  const pages = [{ page_id: "a", title: "" }, { page_id: "b" }, { page_id: "c", title: "Named" }];
  assert.deepEqual(matchingPages(pages, "untitled"), pages.slice(0, 2));
  assert.deepEqual(matchingPages(pages, "   "), pages);
});

test("listing follows next_cursor, drops duplicates, and keeps the first retry authority", async () => {
  const calls = [];
  const responses = [
    { pages: [{ page_id: "a" }, { page_id: "b" }], next_cursor: "c1_one", retry_token: "first" },
    { pages: [{ page_id: "b" }, { page_id: "c" }], next_cursor: null, retry_token: "second" },
  ];
  const result = await listAllPages(async (operation, args) => {
    calls.push([operation, args]);
    return responses.shift();
  });
  assert.deepEqual(calls, [
    ["list_pages", { limit: 100 }],
    ["list_pages", { limit: 100, cursor: "c1_one" }],
  ]);
  assert.deepEqual(
    result.pages.map((page) => page.page_id),
    ["a", "b", "c"],
  );
  assert.equal(result.retry_token, "first");
});

test("listing stops at the request bound even if the server keeps returning cursors", async () => {
  let requests = 0;
  const result = await listAllPages(
    async () => ({ pages: [{ page_id: String(requests) }], next_cursor: `c1_${requests++}` }),
    { maxRequests: 3 },
  );
  assert.equal(requests, 3);
  assert.equal(result.pages.length, 3);
});
