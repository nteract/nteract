import assert from "node:assert/strict";
import { test } from "node:test";
import { readPageRoute, projectPath, writePageRoute } from "../shared/routes.mjs";
import { createPageInProject, listProjectPages, projectTree } from "./projects.mjs";

const projectId = "prj_1a160b47-6df1-4983-81eb-489ca5a26812";
const page = (n) => `0000000${n}-0000-4000-8000-000000000000`;

test("Project links resolve and stay distinct from Page links", () => {
  assert.deepEqual(readPageRoute(`/project/${projectId}`), {
    kind: "project",
    projectId,
    path: `/project/${projectId}`,
  });
  assert.equal(readPageRoute(`/project/${page(1)}`).kind, "missing");
  assert.equal(readPageRoute(`/p/${projectId}`).kind, "missing");
  assert.throws(() => projectPath(page(1)), /Invalid Project/);
  const calls = [];
  writePageRoute(projectId, {
    history: { pushState: (_, __, path) => calls.push(path) },
    location: { pathname: "/", search: "", hash: "" },
  });
  assert.deepEqual(calls, [`/project/${projectId}`]);
});

test("Project IDs from before the rename and /s/ links still open the Project", () => {
  const legacyId = "sp_1a160b47-6df1-4983-81eb-489ca5a26812";
  const expected = { kind: "project", projectId: legacyId, path: `/project/${legacyId}` };
  assert.deepEqual(readPageRoute(`/project/${legacyId}`), expected);
  assert.deepEqual(readPageRoute(`/s/${legacyId}`), expected);
  assert.deepEqual(readPageRoute(`/s/${projectId}`).path, `/project/${projectId}`);
  assert.equal(readPageRoute(`/s/${page(1)}`).kind, "missing");
  const calls = [];
  writePageRoute(legacyId, {
    history: { replaceState: (_, __, path) => calls.push(path) },
    location: { pathname: `/s/${legacyId}`, search: "", hash: "" },
    replace: true,
  });
  assert.deepEqual(calls, [`/project/${legacyId}`]);
});

test("a Project tree puts the home Page first with its descendants, then nests by position", () => {
  const rows = projectTree([
    { page_id: page(5), title: "Orphan", parent_id: page(9), position: "a0" },
    { page_id: page(3), title: "Child", parent_id: page(2), position: "a0" },
    { page_id: page(2), title: "Second", parent_id: null, position: "a2" },
    { page_id: page(1), title: "Home", parent_id: null, position: "a0", home: true },
    { page_id: page(4), title: "First", parent_id: null, position: "a1" },
    { page_id: page(6), title: "Under home", parent_id: page(1), position: "a0" },
    { page_id: page(7), title: "Grandchild", parent_id: page(6), position: "a0" },
  ]);
  assert.deepEqual(
    rows.map(({ page, depth }) => [page.title, depth]),
    [
      ["Home", 0],
      ["Under home", 1],
      ["Grandchild", 2],
      ["Orphan", 0],
      ["First", 0],
      ["Second", 0],
      ["Child", 1],
    ],
  );
});

test("Project listings follow cursors and new Pages reuse the listing's retry token", async () => {
  const calls = [];
  const call = async (operation, args) => {
    calls.push([operation, args]);
    if (operation === "list_pages")
      return args.cursor
        ? { pages: [{ page_id: page(2) }], next_cursor: null }
        : { pages: [{ page_id: page(1) }], next_cursor: "next" };
    if (operation === "list_projects") return { projects: [], retry_token: "token" };
    return { page_id: page(3) };
  };
  assert.deepEqual(
    (await listProjectPages(call, projectId)).map((entry) => entry.page_id),
    [page(1), page(2)],
  );
  assert.ok(calls.every(([, args]) => args.project_id === projectId));
  const created = await createPageInProject(call, projectId);
  assert.equal(created.page_id, page(3));
  const [, args] = calls.at(-1);
  assert.equal(args.project_id, projectId);
  assert.equal(args.retry_token, "token");
  assert.match(args.idempotency_key, /^v1_[0-9a-f]{64}_/);
});
