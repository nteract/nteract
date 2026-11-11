import assert from "node:assert/strict";
import { test } from "node:test";
import { readPageRoute, projectPath, writePageRoute } from "../shared/routes.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualTimeScheduler } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  LOCATION_REJECT,
  LOCATION_RETRIES,
  LOCATION_RETRY_MS,
  pageLocationMachine,
  pageLocationSpec,
  listProjectPages,
  pageLocation,
  projectTree,
  watchPageLocation,
} from "./projects.mjs";
import { runPageCreation } from "./page-create-machine.mjs";
import { Breadcrumbs, ProjectChip, ProjectPages } from "./ProjectView.jsx";
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

test("a Project tree nests Pages by position, with missing parents at the top level", () => {
  const rows = projectTree([
    { page_id: page(5), title: "Orphan", parent_id: page(9), position: "a0" },
    { page_id: page(3), title: "Child", parent_id: page(2), position: "a0" },
    { page_id: page(2), title: "Second", parent_id: null, position: "a2" },
    { page_id: page(1), title: "Guide", parent_id: null, position: "a0" },
    { page_id: page(4), title: "First", parent_id: null, position: "a1" },
    { page_id: page(6), title: "Under guide", parent_id: page(1), position: "a0" },
    { page_id: page(7), title: "Grandchild", parent_id: page(6), position: "a0" },
  ]);
  assert.deepEqual(
    rows.map(({ page, depth }) => [page.title, depth]),
    [
      ["Guide", 0],
      ["Under guide", 1],
      ["Grandchild", 2],
      ["Orphan", 0],
      ["First", 0],
      ["Second", 0],
      ["Child", 1],
    ],
  );
});

test("Project listings follow cursors and a new Page sends only a nonce", async () => {
  const calls = [];
  const call = async (operation, args) => {
    calls.push([operation, args]);
    if (operation === "list_pages")
      return args.cursor
        ? { pages: [{ page_id: page(2) }], next_cursor: null }
        : { pages: [{ page_id: page(1) }], next_cursor: "next" };
    if (operation === "list_projects") return { projects: [] };
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
      operation === "list_pages" ? { pages: [] } : call(operation, args),
    open: async (pageId) => opened.push(pageId),
    refresh: async () => {},
    current: () => true,
  });
  assert.equal(created.receipt.page_id, page(3));
  assert.deepEqual(opened, [page(3)]);
  const [, args] = calls.at(-1);
  assert.equal(args.project_id, projectId);
  assert.equal(args.retry_token, undefined);
  assert.match(args.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

const crumbTitles = (crumbs) =>
  [
    ...renderToStaticMarkup(
      createElement(Breadcrumbs, { crumbs, onOpenProject() {}, onOpenPage() {} }),
    ).matchAll(/<a [^>]*>([^<]*)<\/a>/g),
  ].map((match) => match[1]);

test("breadcrumbs show the Project followed by every disclosed ancestor Page", () => {
  const projectCrumb = { kind: "project", project_id: projectId, title: "Guide" };
  const guideCrumb = { kind: "page", page_id: page(1), title: "Guide" };
  const parentCrumb = { kind: "page", page_id: page(2), title: "Architecture" };
  assert.deepEqual(crumbTitles([projectCrumb]), ["Guide"]);
  assert.deepEqual(crumbTitles([projectCrumb, guideCrumb, parentCrumb]), [
    "Guide",
    "Guide",
    "Architecture",
  ]);
  assert.deepEqual(crumbTitles([projectCrumb, parentCrumb]), ["Guide", "Architecture"]);
  assert.deepEqual(crumbTitles([parentCrumb]), ["Architecture"]);
});

test("Project content lists its Pages from top-level roots, then a New Page row", () => {
  const pages = [
    { page_id: page(2), title: "Plan", parent_id: null, position: "a0" },
    { page_id: page(3), title: "Detail", parent_id: page(2), position: "a0" },
    { page_id: page(4), title: "Budget", parent_id: null, position: "a1" },
  ];
  assert.deepEqual(
    projectTree(pages).map(({ page, depth }) => [page.title, depth]),
    [
      ["Plan", 0],
      ["Detail", 1],
      ["Budget", 0],
    ],
  );
  const html = renderToStaticMarkup(
    createElement(ProjectPages, { title: "Launch", pages, onOpen() {}, onCreate() {} }),
  );
  assert.match(html, /aria-label="Pages in Launch"/);
  assert.doesNotMatch(html, />Launch</, "Project content isn't a row");
  assert.match(html, /Plan.*Detail.*Budget.*New Page/s);
  assert.equal(
    renderToStaticMarkup(
      createElement(ProjectPages, { pages: [], onOpen() {}, onCreate() {} }),
    ).match(/<li/g).length,
    1,
    "an empty Project shows only the New Page row",
  );
});

test("document placement uses host-disclosed kind and leaves direct-only access private", async () => {
  const calls = [];
  const locate = (result) =>
    pageLocation(async (operation, args) => {
      calls.push([operation, args]);
      return result;
    }, page(1));
  const breadcrumbs = [{ kind: "project", project_id: projectId, title: "Launch" }];
  assert.deepEqual(await locate({ kind: "project", project_id: projectId, breadcrumbs }), {
    kind: "project",
    project_id: projectId,
    parent_id: null,
    breadcrumbs,
  });
  assert.deepEqual(await locate({ kind: "page", page_id: page(1) }), {
    kind: "page",
    project_id: null,
    parent_id: null,
    breadcrumbs: [],
  });
  assert.deepEqual(
    await locate({ kind: "page", project_id: projectId, parent_id: null, breadcrumbs }),
    { kind: "page", project_id: projectId, parent_id: null, breadcrumbs },
  );
  assert.ok(
    calls.every(([operation, args]) => operation === "read_page" && args.page_id === page(1)),
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
  asks[2].resolve({ project_id: null, kind: "page", breadcrumbs: [] });
  await settle();
  assert.deepEqual(found, [{ project_id: null, kind: "page", breadcrumbs: [] }]);
  session.connection = null;
  location.changed();
  assert.equal(asks.length, 3, "found is final");

  // A Page the shell left hears nothing.
  const left = watchPageLocation(
    { connection: {} },
    {
      locate: async () => ({ kind: "project" }),
      onFound: (value) => found.push(value),
      current: () => current,
    },
  );
  current = false;
  await settle();
  left.stop();
  assert.equal(found.length, 1);
});

test("a reconnect asks for a Page's location again, and a transient failure retries three times", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Virtual time: timers run only when `advance` passes their time.
  const scheduler = new VirtualTimeScheduler();
  const advance = async (ms) => {
    const until = scheduler.frame + ms;
    // A no-op at the target moves the clock there even when no timer is due.
    scheduler.schedule(() => {}, ms);
    scheduler.maxFrames = until;
    scheduler.flush();
    await settle();
  };
  const session = { connection: {}, connectionGeneration: 1 };
  const asks = [];
  const found = [];
  const location = watchPageLocation(session, {
    locate: () => {
      const answer = {};
      answer.promise = new Promise((resolve, reject) => Object.assign(answer, { resolve, reject }));
      asks.push(answer);
      return answer.promise;
    },
    onFound: (value) => found.push(value),
    current: () => true,
    scheduler,
  });
  const unavailable = () => Object.assign(Error("Service unavailable"), { status: 503 });
  asks[0].reject(unavailable());
  await settle();
  assert.equal(asks.length, 1);
  await advance(LOCATION_RETRY_MS - 1);
  assert.equal(asks.length, 1, "waits 2 s");
  await advance(1);
  assert.equal(asks.length, 2);
  asks[1].reject(unavailable());
  await settle();
  await advance(2 * LOCATION_RETRY_MS);
  assert.equal(asks.length, 3, "then 4 s");
  asks[2].reject(unavailable());
  await settle();
  await advance(4 * LOCATION_RETRY_MS);
  assert.equal(asks.length, 4, "then 8 s");
  asks[3].reject(unavailable());
  await settle();
  await advance(60_000);
  assert.equal(asks.length, 1 + LOCATION_RETRIES, "then it waits for a change");
  // The session reconnects: the same `connection` field, a new generation.
  session.connectionGeneration = 2;
  location.changed();
  assert.equal(asks.length, 5);
  asks[4].reject(unavailable());
  await settle();
  // A reconnect during a backoff asks at once instead of waiting.
  session.connectionGeneration = 3;
  location.changed();
  assert.equal(asks.length, 6);
  await advance(60_000);
  assert.equal(asks.length, 6, "the cancelled retry never fires");
  asks[5].resolve({ kind: "page" });
  await settle();
  assert.deepEqual(found, [{ kind: "page" }]);
});

test("the page-location table runs through the pure machine", async () => {
  const waiting = (asked = "true:1", tries = 0) => ({ name: "waiting", asked, tries });
  const asking = (asked = "true:1", tries = 0) => ({ name: "asking", asked, tries });
  const backoff = (asked = "true:1", tries = 0) => ({ name: "backoff", asked, tries });
  const found = { name: "found" };
  const stopped = { name: "stopped" };
  const changed = (reach = "true:2") => ({ type: "changed", reach });
  const failed = (reach = "true:1", transient = true) => ({ type: "failed", reach, transient });
  const located = { type: "located" };
  const retry = { type: "retry" };
  const stop = { type: "stop" };
  const stays = (state, reason) => ({ state, effects: [], rejected: reason });
  const locate = [{ type: "locate" }];
  const rows = [
    {
      label: "the first ask, or a change, asks",
      case: "new",
      state: waiting(null),
      event: changed("false:0"),
      expect: { state: asking("false:0"), effects: locate },
    },
    {
      case: "same",
      state: waiting(),
      event: changed("true:1"),
      expect: stays(waiting(), LOCATION_REJECT.same),
    },
    { state: waiting(), event: located, expect: stays(waiting(), LOCATION_REJECT.idle) },
    { state: waiting(), event: failed(), expect: stays(waiting(), LOCATION_REJECT.idle) },
    { state: waiting(), event: retry, expect: stays(waiting(), LOCATION_REJECT.idle) },
    { state: waiting(), event: stop, expect: { state: stopped, effects: [] } },
    { state: asking(), event: changed(), expect: stays(asking(), LOCATION_REJECT.asking) },
    {
      label: "an answer is final",
      state: asking(),
      event: located,
      expect: { state: found, effects: [{ type: "found" }] },
    },
    {
      label: "a failure after a change asks again at once",
      case: "moved",
      state: asking("true:1", 2),
      event: failed("true:2", false),
      expect: { state: asking("true:2"), effects: locate },
    },
    {
      label: "a transient failure waits 2 s, then 4, then 8",
      case: "retry",
      state: asking("true:1", 1),
      event: failed(),
      expect: {
        state: backoff("true:1", 1),
        effects: [{ type: "schedule", ms: 2 * LOCATION_RETRY_MS }],
      },
    },
    {
      label: "a lasting failure, or one past the retries, waits for a change",
      case: "wait",
      state: asking("true:1", LOCATION_RETRIES),
      event: failed(),
      expect: { state: waiting("true:1", LOCATION_RETRIES), effects: [] },
    },
    { state: asking(), event: retry, expect: stays(asking(), LOCATION_REJECT.timer) },
    { state: asking(), event: stop, expect: { state: stopped, effects: [] } },
    {
      label: "a change during a backoff asks now and drops the timer",
      case: "new",
      state: backoff("true:1", 2),
      event: changed(),
      expect: { state: asking("true:2"), effects: [{ type: "cancelTimer" }, ...locate] },
    },
    {
      case: "same",
      state: backoff(),
      event: changed("true:1"),
      expect: stays(backoff(), LOCATION_REJECT.same),
    },
    { state: backoff(), event: located, expect: stays(backoff(), LOCATION_REJECT.idle) },
    { state: backoff(), event: failed(), expect: stays(backoff(), LOCATION_REJECT.idle) },
    {
      label: "the retry asks under the same reachability",
      state: backoff("true:1", 1),
      event: retry,
      expect: { state: asking("true:1", 2), effects: locate },
    },
    {
      label: "leaving during a backoff drops the timer",
      state: backoff(),
      event: stop,
      expect: { state: stopped, effects: [{ type: "cancelTimer" }] },
    },
    ...[found, stopped].flatMap((done) =>
      [changed(), located, failed(), retry, stop].map((event) => ({
        state: done,
        event,
        expect: stays(done, LOCATION_REJECT.done),
      })),
    ),
  ];
  assert.deepEqual(await runTable(pageLocationMachine, rows), {
    rows: rows.length,
    pairs: pageLocationSpec.states.length * pageLocationSpec.events.length,
    unreachable: 0,
    cases: 7,
  });
});

test("a watcher stopped during a backoff never asks again", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const scheduler = new VirtualTimeScheduler();
  let asks = 0;
  const watch = watchPageLocation(
    { connection: {}, connectionGeneration: 1 },
    {
      locate: () => {
        asks++;
        return Promise.reject(Object.assign(Error("Unavailable"), { status: 503 }));
      },
      onFound: () => assert.fail("never found"),
      current: () => true,
      scheduler,
    },
  );
  await settle();
  assert.equal(watch.state().name, "backoff");
  assert.equal(scheduler.actions.length, 1, "the retry is scheduled");
  watch.stop();
  assert.equal(watch.state().name, "stopped");
  scheduler.flush();
  await settle();
  assert.equal(asks, 1, "the cancelled retry never fires");
});
