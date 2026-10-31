import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pagePath,
  readPageRoute,
  writePageRoute,
  writeRoute,
  pagesPath,
  isIndexRoute,
  clampPagesQuery,
  normalizePagesQuery,
  PAGES_QUERY_MAX,
  PROJECTS_PATH,
  isPlainNavigation,
  mergePageListings,
  pageListing,
} from "../shared/routes.mjs";
const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
test("canonical and existing shared Page links resolve to the same document", () => {
  const expected = { kind: "page", pageId: id, path: `/p/${id}` };
  assert.deepEqual(readPageRoute(`/p/${id}`), expected);
  assert.deepEqual(readPageRoute(`/?page=${id}`), expected);
  assert.deepEqual(readPageRoute(`/p/${id}/`), expected);
  assert.deepEqual(readPageRoute("/"), { kind: "home", path: "/" });
  for (const path of ["/p/nope", "/p/", "/p/" + id + "/other", "/missing", "/?page=bad"])
    assert.equal(readPageRoute(path).kind, "missing");
  assert.throws(() => pagePath("../api/auth/logout"), /Invalid Page/);
});
test("page and home navigation push history; canonicalization replaces without duplicating", () => {
  const calls = [];
  const location = { pathname: "/", search: "", hash: "" };
  const history = Object.fromEntries(
    ["pushState", "replaceState"].map((method) => [
      method,
      (state, _, path) => {
        calls.push({ method, path });
        const url = new URL(path, "https://pages.invalid");
        Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
      },
    ]),
  );
  writePageRoute(id, { history, location });
  writePageRoute(id, { history, location });
  writePageRoute(null, { history, location });
  Object.assign(location, { pathname: "/", search: `?page=${id}` });
  writePageRoute(id, { history, location, replace: true });
  assert.deepEqual(calls, [
    { method: "pushState", path: `/p/${id}` },
    { method: "pushState", path: "/" },
    { method: "replaceState", path: `/p/${id}` },
  ]);
});
test("/projects and /pages are exact index routes with an optional trailing slash", () => {
  for (const path of ["/projects", "/projects/", "/projects?from=home"])
    assert.deepEqual(readPageRoute(path), { kind: "projects", path: PROJECTS_PATH });
  for (const path of ["/pages", "/pages/", "/pages?q=", "/pages?q=%20%20"])
    assert.deepEqual(readPageRoute(path), { kind: "pages", query: "", path: "/pages" });
  assert.deepEqual(readPageRoute("/pages?q=%20road%20map%20"), {
    kind: "pages",
    query: "road map",
    path: "/pages?q=road+map",
  });
  assert.equal(readPageRoute(`/pages?q=${"x".repeat(300)}`).query.length, 200);
  for (const path of [
    "/projects/x",
    "/projects//",
    "/pages/x",
    "/pages//",
    "/page",
    "/project",
    "/projectsx",
    "/Pages",
    `/projects/prj_${id}`,
    `/pages/${id}`,
  ])
    assert.equal(readPageRoute(path).kind, "missing", path);
  assert.equal(isIndexRoute(readPageRoute("/projects")), true);
  assert.equal(isIndexRoute(readPageRoute("/pages?q=a")), true);
  for (const path of ["/", `/p/${id}`, `/project/prj_${id}`, "/missing"])
    assert.equal(isIndexRoute(readPageRoute(path)), false, path);
  assert.equal(pagesPath(), "/pages");
  assert.equal(pagesPath("  "), "/pages");
  assert.equal(pagesPath("a&b"), "/pages?q=a%26b");
  assert.equal(readPageRoute(pagesPath("a&b=c")).query, "a&b=c");
});
test("a /pages query has one rule for the box, the request and the address", () => {
  assert.equal(PAGES_QUERY_MAX, 200);
  assert.equal(normalizePagesQuery(undefined), "");
  assert.equal(normalizePagesQuery(null), "");
  assert.equal(normalizePagesQuery("  road  "), "road");
  assert.equal(normalizePagesQuery("x".repeat(250)), "x".repeat(200));
  // A cut that would end inside a word with spaces before it drops the spaces.
  assert.equal(normalizePagesQuery("x".repeat(199) + " yz"), "x".repeat(199));
  // A cut never leaves half a surrogate pair, which list_pages would count
  // and the address would mangle.
  const emoji = "x".repeat(199) + "😀";
  assert.equal(normalizePagesQuery(emoji), "x".repeat(199));
  for (const raw of ["  road map ", "x".repeat(300), emoji, "a&b=c"]) {
    const query = normalizePagesQuery(raw);
    assert.ok(query.length <= PAGES_QUERY_MAX);
    assert.equal(normalizePagesQuery(query), query, "normalizing twice changes nothing");
    assert.equal(readPageRoute(pagesPath(raw)).query, query, "a reload lists the same search");
    assert.equal(pagesPath(query), pagesPath(raw));
  }
});
test("the search box clamps by code point, so it holds exactly what a search sends", () => {
  const ascii = "x".repeat(199);
  // 199 ASCII units and one emoji is 201 units: the emoji doesn't fit.
  assert.equal(clampPagesQuery(ascii + "😀"), ascii);
  assert.equal(clampPagesQuery(ascii + "😀 more"), ascii);
  // A maxLength-style cut that already split the pair loses the stray half.
  assert.equal(clampPagesQuery(ascii + "\uD83D"), ascii);
  // An emoji that fits stays whole; spaces are the caller's to trim.
  assert.equal(clampPagesQuery("x".repeat(198) + "😀"), "x".repeat(198) + "😀");
  assert.equal(clampPagesQuery("  road  "), "  road  ");
  assert.equal(clampPagesQuery(undefined), "");
  for (const raw of [ascii + "😀", ascii + "\uD83D", "x".repeat(198) + "😀", " " + ascii + "😀"]) {
    const stored = clampPagesQuery(raw);
    const query = normalizePagesQuery(stored);
    assert.equal(normalizePagesQuery(raw), query, "the box and a direct request agree");
    assert.equal(readPageRoute(pagesPath(stored)).query, query, "and so does the address");
    assert.equal(query.isWellFormed(), true);
  }
});
test("index routes push once and search edits replace the entry", () => {
  const calls = [];
  const location = { pathname: "/", search: "", hash: "" };
  const history = Object.fromEntries(
    ["pushState", "replaceState"].map((method) => [
      method,
      (state, _, path) => {
        calls.push({ method, path, state });
        const url = new URL(path, "https://pages.invalid");
        Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
      },
    ]),
  );
  writeRoute("/pages", { history, location });
  writeRoute("/pages", { history, location });
  writeRoute(pagesPath("road"), { history, location, replace: true });
  writeRoute(PROJECTS_PATH, { history, location, state: { index: "projects" } });
  assert.deepEqual(calls, [
    { method: "pushState", path: "/pages", state: null },
    { method: "replaceState", path: "/pages?q=road", state: null },
    { method: "pushState", path: "/projects", state: { index: "projects" } },
  ]);
});
test("modified clicks preserve open-in-new-tab behavior", () => {
  assert.equal(isPlainNavigation({ button: 0 }), true);
  for (const extra of [
    { button: 1 },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { defaultPrevented: true },
  ])
    assert.equal(isPlainNavigation({ button: 0, ...extra }), false);
});
test("local pending pages survive catalog refresh without resurrecting removed remote pages", () => {
  const remote = [{ page_id: "one", title: "Remote" }],
    local = [
      { page_id: "one", title: "Old" },
      { page_id: "pending", pending: true },
      { page_id: "deleted", pending: false },
    ];
  assert.deepEqual(mergePageListings(remote, local), [remote[0], local[1]]);
  assert.deepEqual(mergePageListings(null, local), local);
});
test("a refresh recomputes from the latest remote result and local snapshot in either order", () => {
  const kept = { page_id: "kept", title: "Kept" },
    trashed = { page_id: "trashed", title: "Trashed" },
    stale = { page_id: "draft", title: "Untitled", pending: true },
    renamed = { page_id: "draft", title: "Local creation", pending: true },
    leaving = { page_id: "leaving", title: "Leaving", pending: true };
  // Before either arrives, the last remote listing and the first snapshot show.
  const start = () => pageListing([kept, trashed], [stale, leaving]);
  assert.deepEqual(start().pages, [kept, trashed, stale, leaving]);

  // Remote first, then the closing Page's checkpoint: the remote drops the
  // trashed Page, the snapshot retitles the draft and no longer holds `leaving`.
  let listing = start();
  assert.deepEqual(listing.remote([kept]), [kept, stale, leaving]);
  assert.deepEqual(listing.local([renamed]), [kept, renamed]);

  // Checkpoint first, then remote: same result.
  listing = start();
  assert.deepEqual(listing.local([renamed]), [kept, trashed, renamed]);
  assert.deepEqual(listing.remote([kept]), [kept, renamed]);

  // A failed remote listing shows every local copy; a later snapshot still wins.
  listing = start();
  assert.deepEqual(listing.remote(null), [stale, leaving]);
  assert.deepEqual(listing.local([renamed]), [renamed]);
});
