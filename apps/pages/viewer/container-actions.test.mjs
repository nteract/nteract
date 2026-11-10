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

test("createProject calls create_project with a v1_ key from list_projects' token", async () => {
  const { call, calls } = caller({
    list_projects: { retry_token: "token-1" },
    create_project: { project_id: "prj_new" },
  });
  const receipt = await createProject(call, { title: "  Conference  ", description: " " });
  assert.deepEqual(receipt, { project_id: "prj_new" });
  const [, args] = calls.at(-1);
  assert.equal(calls.at(-1)[0], "create_project");
  assert.equal(args.title, "Conference");
  assert.equal(args.description, undefined, "a blank description is omitted");
  assert.equal(args.retry_token, "token-1");
  assert.match(args.idempotency_key, /^v1_[0-9a-f]{64}_/);
});

test("a failed write carries its attempt, and a retry replays it without a new token", async () => {
  const failing = caller({
    list_projects: { retry_token: "token-1" },
    create_project: new Error("offline"),
  });
  const error = await createProject(failing.call, { title: "A", description: "B" }).catch(
    (cause) => cause,
  );
  assert.equal(error.message, "offline");
  assert.equal(error.attempt.retry_token, "token-1");
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

test("movePage sends move_page with list_pages' retry token", async () => {
  const { call, calls } = caller({
    list_pages: { retry_token: "token-2" },
    move_page: (args) => ({ page_id: args.page_id, project_id: null }),
  });
  const receipt = await movePage(call, "p", { target: null, parent_id: null });
  assert.deepEqual(receipt, { page_id: "p", project_id: null });
  assert.deepEqual(calls[0], ["list_pages", { limit: 1 }]);
  assert.equal(calls[1][1].retry_token, "token-2");
  assert.equal(calls[1][1].project_id, null);
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
