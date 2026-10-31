import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, moveDialogMachine } from "./move-dialog-machine.mjs";
import { moveDestinations, movePage, pagePlacement } from "./projects.mjs";

const pageId = "00000001-0000-4000-8000-000000000000";
const page = { page_id: pageId, title: "Draft" };
const projectId = "prj_1a160b47-6df1-4983-81eb-489ca5a26812";
const destinations = [
  {
    key: "your-items",
    label: "Your items",
    depth: 0,
    project_id: null,
    parent_id: null,
    disabled: true,
    reason: "Current location",
  },
  {
    key: `project:${projectId}`,
    label: "Launch",
    depth: 0,
    project_id: projectId,
    parent_id: null,
    disabled: false,
  },
];
const closed = { name: "closed" };
const loading = { name: "loading", attempt: 1, page };
const choosing = { name: "choosing", attempt: 1, page, destinations, selected: null };
const chosen = { ...choosing, selected: 1 };
const moving = { name: "moving", attempt: 1, page, destinations, selected: 1 };
const failed = { name: "failed", attempt: 1, page, error: "Offline" };
const receipt = { page_id: pageId, moved: true, project_id: projectId };

const ev = {
  open: { type: "open", attempt: 2, page },
  loaded: { type: "loaded", attempt: 1, destinations },
  loadFailed: { type: "loadFailed", attempt: 1, error: "Offline" },
  select: { type: "select", index: 1 },
  submit: { type: "submit" },
  moved: { type: "moved", attempt: 1, receipt },
  moveFailed: { type: "moveFailed", attempt: 1, error: "Project not found" },
  close: { type: "close" },
};
const reopened = {
  state: { name: "loading", attempt: 2, page },
  effects: [{ type: "load", attempt: 2, page_id: pageId }],
};
const stays = (state, reason) => ({ state, effects: [], rejected: reason });

const rows = [
  { label: "open from closed", state: closed, event: ev.open, expect: reopened },
  { state: closed, event: ev.loaded, expect: stays(closed, REJECT.stale) },
  { state: closed, event: ev.loadFailed, expect: stays(closed, REJECT.stale) },
  { state: closed, event: ev.moved, expect: stays(closed, REJECT.stale) },
  { state: closed, event: ev.moveFailed, expect: stays(closed, REJECT.stale) },
  { state: closed, event: ev.close, expect: stays(closed, REJECT.closed) },

  { label: "reopen while loading", state: loading, event: ev.open, expect: reopened },
  {
    state: loading,
    event: ev.loaded,
    expect: { state: choosing, effects: [] },
  },
  {
    label: "a late load for an earlier opening",
    state: { ...loading, attempt: 2 },
    event: ev.loaded,
    expect: stays({ ...loading, attempt: 2 }, REJECT.stale),
  },
  { state: loading, event: ev.loadFailed, expect: { state: failed, effects: [] } },
  { state: loading, event: ev.moved, expect: stays(loading, REJECT.stale) },
  { state: loading, event: ev.moveFailed, expect: stays(loading, REJECT.stale) },
  { state: loading, event: ev.close, expect: { state: closed, effects: [] } },

  { state: choosing, event: ev.open, expect: reopened },
  { state: choosing, event: ev.loaded, expect: stays(choosing, REJECT.stale) },
  { state: choosing, event: ev.loadFailed, expect: stays(choosing, REJECT.stale) },
  { state: choosing, event: ev.select, expect: { state: chosen, effects: [] } },
  {
    label: "a disabled row can't be chosen",
    state: choosing,
    event: { type: "select", index: 0 },
    expect: stays(choosing, REJECT.unavailable),
  },
  {
    label: "choosing again clears the last error",
    state: { ...chosen, error: "Project not found" },
    event: ev.select,
    expect: { state: chosen, effects: [] },
  },
  {
    state: chosen,
    event: ev.submit,
    expect: {
      state: moving,
      effects: [
        {
          type: "move",
          attempt: 1,
          page_id: pageId,
          destination: { project_id: projectId, parent_id: null },
        },
      ],
    },
  },
  {
    label: "submit needs a destination",
    state: choosing,
    event: ev.submit,
    expect: stays(choosing, REJECT.unselected),
  },
  { state: choosing, event: ev.moved, expect: stays(choosing, REJECT.stale) },
  { state: choosing, event: ev.moveFailed, expect: stays(choosing, REJECT.stale) },
  { state: chosen, event: ev.close, expect: { state: closed, effects: [] } },

  { state: moving, event: ev.open, expect: stays(moving, REJECT.running) },
  { state: moving, event: ev.loaded, expect: stays(moving, REJECT.stale) },
  { state: moving, event: ev.loadFailed, expect: stays(moving, REJECT.stale) },
  {
    state: moving,
    event: ev.moved,
    expect: { state: closed, effects: [{ type: "notify", receipt }] },
  },
  {
    label: "a late move reply for an earlier opening",
    state: { ...moving, attempt: 3 },
    event: ev.moved,
    expect: stays({ ...moving, attempt: 3 }, REJECT.stale),
  },
  {
    state: moving,
    event: ev.moveFailed,
    expect: { state: { ...chosen, error: "Project not found" }, effects: [] },
  },
  { state: moving, event: ev.close, expect: stays(moving, REJECT.running) },

  { state: failed, event: ev.open, expect: reopened },
  { state: failed, event: ev.loaded, expect: stays(failed, REJECT.stale) },
  { state: failed, event: ev.loadFailed, expect: stays(failed, REJECT.stale) },
  { state: failed, event: ev.moved, expect: stays(failed, REJECT.stale) },
  { state: failed, event: ev.moveFailed, expect: stays(failed, REJECT.stale) },
  { state: failed, event: ev.close, expect: { state: closed, effects: [] } },
];

test("move dialog: every state and event pair has a row", async () => {
  const result = await runTable(moveDialogMachine, rows);
  assert.equal(result.rows, rows.length);
  assert.equal(result.unreachable, 8);
});

const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;

test("destinations: Your items, each Project and its Pages, with the Page's own subtree disabled", () => {
  const other = "prj_2a160b47-6df1-4983-81eb-489ca5a26812";
  const projects = [
    { project_id: projectId, title: "Launch", home_page_id: id(1) },
    { project_id: other, title: "Archive", home_page_id: id(5) },
  ];
  const pages = [
    { page_id: id(1), title: "Launch", project_id: projectId, parent_id: null, position: "a0", home: true },
    { page_id: id(2), title: "Plan", project_id: projectId, parent_id: null, position: "a1" },
    { page_id: id(3), title: "Risks", project_id: projectId, parent_id: id(2), position: "a0" },
    { page_id: id(4), title: "Loose" },
    { page_id: id(5), title: "Archive", project_id: other, parent_id: null, position: "a0", home: true },
  ];
  const rows = moveDestinations({ pageId: id(2), projects, pages });
  assert.deepEqual(
    rows.map((row) => [row.label, row.depth, row.disabled, row.reason ?? null]),
    [
      ["Your items", 0, false, null],
      ["Archive", 0, false, null],
      ["Archive", 1, false, null],
      ["Launch", 0, true, "Current location"],
      ["Launch", 1, false, null],
      ["Plan", 1, true, "Can't move a Page under itself"],
      ["Risks", 2, true, "Can't move a Page under itself"],
    ],
  );
  const underHome = rows.find((row) => row.key === `page:${id(1)}`);
  assert.deepEqual(
    { project_id: underHome.project_id, parent_id: underHome.parent_id, home: underHome.home },
    { project_id: projectId, parent_id: id(1), home: true },
  );
  const loose = moveDestinations({ pageId: id(4), projects, pages });
  assert.equal(loose[0].disabled, true, "a loose Page is already in Your items");
  assert.equal(loose.find((row) => row.key === `page:${id(3)}`).disabled, false);
});

test("destinations: a subtree that would nest too deep is disabled where it can't fit", () => {
  const pages = [];
  let parent = null;
  for (let depth = 1; depth <= 7; depth++) {
    const pageId = `0000000${depth}-0000-4000-8000-00000000000${depth}`;
    pages.push({ page_id: pageId, title: `D${depth}`, project_id: projectId, parent_id: parent, position: "a0" });
    parent = pageId;
  }
  const mover = "00000009-0000-4000-8000-000000000009";
  const child = "00000009-0000-4000-8000-00000000000a";
  pages.push({ page_id: mover, title: "Mover" }, { page_id: child, title: "Child", parent_id: mover });
  const rows = moveDestinations({ pageId: mover, projects: [{ project_id: projectId, title: "P" }], pages });
  const at = (depth) => rows.find((row) => row.label === `D${depth}`);
  assert.equal(at(6).disabled, false, "Mover at 7 and Child at 8 fit");
  assert.equal(at(7).disabled, true);
  assert.equal(at(7).reason, "Too deeply nested");
});

test("movePage prepares catalog retry authority and sends the destination", async () => {
  const calls = [];
  const call = async (operation, args) => {
    calls.push([operation, args]);
    if (operation === "list_pages")
      return { pages: [], retry_token: "token", retry_key_prefix: "v1_prefix_" };
    return { page_id: args.page_id, moved: true };
  };
  await movePage(call, pageId, { project_id: projectId, parent_id: id(2) });
  await movePage(call, pageId, { project_id: null, parent_id: null });
  assert.deepEqual(calls[0], ["list_pages", { limit: 1 }]);
  const [, into] = calls[1];
  assert.equal(into.project_id, projectId);
  assert.equal(into.parent_id, id(2));
  assert.equal(into.retry_token, "token");
  assert.match(into.idempotency_key, /^v1_/);
  const [, out] = calls[3];
  assert.equal(out.project_id, null);
  assert.equal("parent_id" in out, false);
  await assert.rejects(() => movePage(async () => ({}), pageId, { project_id: null }), /prepare/);
});

test("pagePlacement reads breadcrumbs, Project, parent and home from read_page", async () => {
  const placement = await pagePlacement(
    async () => ({ breadcrumbs: [{ kind: "project", project_id: projectId }], project_id: projectId, home: true }),
    pageId,
  );
  assert.deepEqual(placement, {
    page_id: pageId,
    breadcrumbs: [{ kind: "project", project_id: projectId }],
    project_id: projectId,
    parent_id: null,
    home: true,
  });
});
