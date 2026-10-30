import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pagePath,
  readPageRoute,
  writePageRoute,
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
