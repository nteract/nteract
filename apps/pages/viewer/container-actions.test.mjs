import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProject,
  loadParentChoices,
  moveArguments,
  moveDestinations,
  movePage,
  parentChoices,
} from "./container-actions.mjs";

/** A fake tool caller that records calls and answers from `answers`. */
function caller(answers) {
  const calls = [];
  const call = async (operation, args) => {
    calls.push([operation, args]);
    const answer = answers[operation];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { call, calls };
}

test("createProject calls create_project with a new nonce and no listing first", async () => {
  const { call, calls } = caller({
    create_project: { project_id: "prj_new" },
  });
  const receipt = await createProject(call, { title: "  Conference  ", description: " " });
  assert.deepEqual(receipt, { project_id: "prj_new" });
  const [, args] = calls.at(-1);
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["create_project"],
  );
  assert.equal(args.title, "Conference");
  assert.equal(args.description, undefined, "a blank description is omitted");
  assert.equal(args.retry_token, undefined);
  assert.match(args.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("a failed write carries its attempt, and a retry replays it under the same nonce", async () => {
  const failing = caller({
    create_project: new Error("offline"),
  });
  const error = await createProject(failing.call, { title: "A", description: "B" }).catch(
    (cause) => cause,
  );
  assert.equal(error.message, "offline");
  assert.deepEqual(error.attempt, { nonce: failing.calls[0][1].nonce });
  const retry = caller({ create_project: { project_id: "prj_new" } });
  await createProject(retry.call, { title: "A", description: "B" }, error.attempt);
  assert.deepEqual(retry.calls, [
    ["create_project", { title: "A", description: "B", ...error.attempt }],
  ]);
});

test("moveArguments names a parent, a Project's top level, or Your items", () => {
  assert.deepEqual(moveArguments("p", { target: "prj_a", parent_id: "q" }), {
    page_id: "p",
    parent_id: "q",
  });
  assert.deepEqual(moveArguments("p", { target: "prj_a", parent_id: null }), {
    page_id: "p",
    project_id: "prj_a",
  });
  assert.deepEqual(moveArguments("p", { target: null, parent_id: null }), {
    page_id: "p",
    project_id: null,
  });
});

test("movePage sends move_page with a new nonce and no listing first", async () => {
  const { call, calls } = caller({
    move_page: (args) => ({ page_id: args.page_id, project_id: null }),
  });
  const receipt = await movePage(call, "p", { target: null, parent_id: null });
  assert.deepEqual(receipt, { page_id: "p", project_id: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "move_page");
  assert.match(calls[0][1].nonce, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0][1].project_id, null);
});

test("destinations list Your items first, then each Project", () => {
  assert.deepEqual(moveDestinations([{ project_id: "prj_a", title: "" }]), [
    { target: null, title: "Your items" },
    { target: "prj_a", title: "Untitled" },
  ]);
  // The Page's own Project joins the list until list_projects has it.
  assert.deepEqual(moveDestinations([], { project_id: "prj_b", title: "Launch" }), [
    { target: null, title: "Your items" },
    { target: "prj_b", title: "Launch" },
  ]);
  assert.deepEqual(
    moveDestinations([{ project_id: "prj_b", title: "Launch" }], { project_id: "prj_b" }),
    [
      { target: null, title: "Your items" },
      { target: "prj_b", title: "Launch" },
    ],
  );
  assert.equal(moveDestinations([], { project_id: null }).length, 1);
});

test("parent choices skip shared Pages and the moved Page's subtree", () => {
  const pages = [
    { page_id: "b", title: "B", parent_id: null, position: "a1" },
    { page_id: "a", title: "A", parent_id: null, position: "a0" },
    { page_id: "moving", title: "Moving", parent_id: "a", position: "a0" },
    { page_id: "under", title: "Under", parent_id: "moving", position: "a0" },
    { page_id: "c", title: "", parent_id: "a", position: "a1" },
    { page_id: "theirs", title: "Theirs", shared: true },
  ];
  assert.deepEqual(parentChoices(pages, "moving"), [
    { page_id: "a", title: "A", depth: 0 },
    { page_id: "c", title: "Untitled", depth: 1 },
    { page_id: "b", title: "B", depth: 0 },
  ]);
});

test("loadParentChoices lists a Project's Pages, or the Pages outside any Project", async () => {
  const { call, calls } = caller({
    list_pages: (args) => ({
      pages: args.project_id
        ? [{ page_id: "in", title: "In", parent_id: null, project_id: args.project_id }]
        : [
            { page_id: "loose", title: "Loose" },
            { page_id: "in", title: "In", project_id: "prj_a" },
          ],
    }),
  });
  assert.deepEqual(await loadParentChoices(call, "prj_a", "x"), [
    { page_id: "in", title: "In", depth: 0 },
  ]);
  assert.equal(calls[0][1].project_id, "prj_a");
  assert.deepEqual(await loadParentChoices(call, null, "x"), [
    { page_id: "loose", title: "Loose", depth: 0 },
  ]);
});
