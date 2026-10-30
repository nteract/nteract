import assert from "node:assert/strict";
import { test } from "node:test";
import { readPageRoute, spacePath, writePageRoute } from "../shared/routes.mjs";
import { createPageInSpace, listSpacePages, spaceTree } from "./spaces.mjs";

const spaceId = "sp_1a160b47-6df1-4983-81eb-489ca5a26812";
const page = (n) => `0000000${n}-0000-4000-8000-000000000000`;

test("Space links resolve and stay distinct from Page links", () => {
  assert.deepEqual(readPageRoute(`/s/${spaceId}`), {
    kind: "space",
    spaceId,
    path: `/s/${spaceId}`,
  });
  assert.equal(readPageRoute(`/s/${page(1)}`).kind, "missing");
  assert.equal(readPageRoute(`/p/${spaceId}`).kind, "missing");
  assert.throws(() => spacePath(page(1)), /Invalid Space/);
  const calls = [];
  writePageRoute(spaceId, {
    history: { pushState: (_, __, path) => calls.push(path) },
    location: { pathname: "/", search: "", hash: "" },
  });
  assert.deepEqual(calls, [`/s/${spaceId}`]);
});

test("a Space tree puts the home Page first, nests by parent and orders by position", () => {
  const { home, rows } = spaceTree([
    { page_id: page(5), title: "Orphan", parent_id: page(9), position: "a0" },
    { page_id: page(3), title: "Child", parent_id: page(2), position: "a0" },
    { page_id: page(2), title: "Second", parent_id: null, position: "a2" },
    { page_id: page(1), title: "Home", parent_id: null, position: "a0", home: true },
    { page_id: page(4), title: "First", parent_id: null, position: "a1" },
  ]);
  assert.equal(home.title, "Home");
  assert.deepEqual(
    rows.map(({ page, depth }) => [page.title, depth]),
    [
      ["Orphan", 0],
      ["First", 0],
      ["Second", 0],
      ["Child", 1],
    ],
  );
});

test("Space listings follow cursors and new Pages reuse the listing's retry token", async () => {
  const calls = [];
  const call = async (operation, args) => {
    calls.push([operation, args]);
    if (operation === "list_pages")
      return args.cursor
        ? { pages: [{ page_id: page(2) }], next_cursor: null }
        : { pages: [{ page_id: page(1) }], next_cursor: "next" };
    if (operation === "list_spaces") return { spaces: [], retry_token: "token" };
    return { page_id: page(3) };
  };
  assert.deepEqual(
    (await listSpacePages(call, spaceId)).map((entry) => entry.page_id),
    [page(1), page(2)],
  );
  assert.ok(calls.every(([, args]) => args.space_id === spaceId));
  const created = await createPageInSpace(call, spaceId);
  assert.equal(created.page_id, page(3));
  const [, args] = calls.at(-1);
  assert.equal(args.space_id, spaceId);
  assert.equal(args.retry_token, "token");
  assert.match(args.idempotency_key, /^v1_[0-9a-f]{64}_/);
});
