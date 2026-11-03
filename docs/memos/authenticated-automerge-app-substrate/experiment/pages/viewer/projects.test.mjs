import assert from "node:assert/strict";
import { test } from "node:test";
import { readPageRoute, projectPath, writePageRoute } from "../shared/routes.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { listProjectPages, projectTree, watchPageLocation } from "./projects.mjs";
import { runPageCreation } from "./page-create-machine.mjs";
import {
  Breadcrumbs,
  ProjectChip,
  ProjectPages,
  projectPageCount,
  projectPageRows,
} from "./ProjectView.jsx";
import { PagePicker } from "./PagePicker.jsx";

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

test("Project listings follow cursors and a new Page uses the listing's retry token", async () => {
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
  const opened = [];
  const created = await runPageCreation({
    placement: { project_id: projectId },
    call: async (operation, args) =>
      operation === "list_pages" ? { pages: [], retry_token: "token" } : call(operation, args),
    open: async (pageId) => opened.push(pageId),
    refresh: async () => {},
    current: () => true,
  });
  assert.equal(created.receipt.page_id, page(3));
  assert.deepEqual(opened, [page(3)]);
  const [, args] = calls.at(-1);
  assert.equal(args.project_id, projectId);
  assert.equal(args.retry_token, "token");
  assert.match(args.idempotency_key, /^v1_[0-9a-f]{64}_/);
});

const crumbTitles = (crumbs) =>
  [
    ...renderToStaticMarkup(
      createElement(Breadcrumbs, { crumbs, onOpenProject() {}, onOpenPage() {} }),
    ).matchAll(/<a [^>]*>([^<]*)<\/a>/g),
  ].map((match) => match[1]);

test("a Project's home Page folds into the Project crumb; other parents stay", () => {
  const projectCrumb = { kind: "project", project_id: projectId, title: "Guide" };
  const homeCrumb = { kind: "page", page_id: page(1), title: "Guide", home: true };
  const parentCrumb = { kind: "page", page_id: page(2), title: "Architecture" };
  assert.deepEqual(crumbTitles([projectCrumb, homeCrumb]), ["Guide"]);
  assert.deepEqual(crumbTitles([projectCrumb, homeCrumb, parentCrumb]), ["Guide", "Architecture"]);
  assert.deepEqual(crumbTitles([projectCrumb, parentCrumb]), ["Guide", "Architecture"]);
  // Without its Project crumb, the home crumb is the only way back up.
  assert.deepEqual(crumbTitles([homeCrumb, parentCrumb]), ["Guide", "Architecture"]);
});

test("a home Page lists its Project's Pages without the home row, then a New Page row", () => {
  const pages = [
    { page_id: page(1), title: "Launch", parent_id: null, position: "a0", home: true },
    { page_id: page(2), title: "Plan", parent_id: page(1), position: "a0" },
    { page_id: page(3), title: "Detail", parent_id: page(2), position: "a0" },
    { page_id: page(4), title: "Budget", parent_id: page(1), position: "a1" },
  ];
  assert.deepEqual(
    projectPageRows(pages).map(({ page, depth }) => [page.title, depth]),
    [
      ["Plan", 0],
      ["Detail", 1],
      ["Budget", 0],
    ],
  );
  assert.equal(projectPageCount(pages), 3);
  const html = renderToStaticMarkup(
    createElement(ProjectPages, { title: "Launch", pages, onOpen() {}, onCreate() {} }),
  );
  assert.match(html, /aria-label="Pages in Launch"/);
  assert.doesNotMatch(html, />Launch</, "the home Page isn't a row");
  assert.match(html, /Plan.*Detail.*Budget.*New Page/s);
  assert.equal(
    renderToStaticMarkup(
      createElement(ProjectPages, { pages: pages.slice(0, 1), onOpen() {}, onCreate() {} }),
    ).match(/<li/g).length,
    1,
    "an empty Project shows only the New Page row",
  );
});

test("the Project chip says how many Pages and links to the Project view", () => {
  for (const [count, text] of [
    [0, "Project · 0 Pages"],
    [1, "Project · 1 Page"],
    [3, "Project · 3 Pages"],
  ]) {
    const html = renderToStaticMarkup(
      createElement(ProjectChip, { projectId, count, onOpenProject() {} }),
    );
    assert.match(html, new RegExp(text));
    assert.match(html, new RegExp(`href="/project/${projectId}"`));
  }
});

test("the picker offers New Page in the current Project and in Your items", () => {
  const props = { open: false, pages: [], onClose() {}, onOpen() {}, onCreate() {} };
  const plain = renderToStaticMarkup(createElement(PagePicker, props));
  assert.doesNotMatch(plain, /In Your items/);
  const split = renderToStaticMarkup(
    createElement(PagePicker, {
      ...props,
      createProject: { project_id: projectId, title: "Launch" },
      onCreateInProject() {},
    }),
  );
  assert.match(split, /In Launch/);
  assert.match(split, /In Your items/);
});

test("a Page's location is asked for again as its session registers and connects", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // A draft made in this tab: not registered, not connected.
  const session = { localPage: { registration: {}, registered: false }, connection: null };
  const asks = [];
  const found = [];
  let current = true;
  const location = watchPageLocation(session, {
    locate: () => {
      const answer = {};
      answer.promise = new Promise((resolve, reject) => Object.assign(answer, { resolve, reject }));
      asks.push(answer);
      return answer.promise;
    },
    onFound: (value) => found.push(value),
    current: () => current,
  });
  assert.equal(asks.length, 1, "asked at once");
  asks[0].reject(Object.assign(Error("Page not found"), { status: 404 }));
  await settle();
  location.changed();
  location.changed();
  assert.equal(asks.length, 1, "nothing changed, so nothing is asked again");
  // Registration changes what read_page can find, so it asks again.
  session.localPage.registered = true;
  location.changed();
  assert.equal(asks.length, 2);
  session.connection = {};
  location.changed();
  assert.equal(asks.length, 2, "one ask in flight at a time");
  asks[1].reject(Object.assign(Error("Page not found"), { status: 404 }));
  await settle();
  assert.equal(asks.length, 3, "the connection changed while it was asking");
  asks[2].resolve({ project_id: null, home: false, breadcrumbs: [] });
  await settle();
  assert.deepEqual(found, [{ project_id: null, home: false, breadcrumbs: [] }]);
  session.connection = null;
  location.changed();
  assert.equal(asks.length, 3, "found is final");

  // A Page the shell left hears nothing.
  const left = watchPageLocation(
    { connection: {} },
    {
      locate: async () => ({ home: true }),
      onFound: (value) => found.push(value),
      current: () => current,
    },
  );
  current = false;
  await settle();
  left.stop();
  assert.equal(found.length, 1);
});
