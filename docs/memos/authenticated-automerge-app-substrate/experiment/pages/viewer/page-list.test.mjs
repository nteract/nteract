import test from "node:test";
import assert from "node:assert/strict";
import { matchingPages } from "./page-list.mjs";

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
