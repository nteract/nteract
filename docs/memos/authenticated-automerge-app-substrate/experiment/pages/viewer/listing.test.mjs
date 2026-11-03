// The listing table through the pure machine, Listing's interpretation of it,
// and the row projections behind /pages and /projects.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { listingMachine } from "./listing-machine.mjs";
import {
  Listing,
  SEARCH_DEBOUNCE_MS,
  deviceRows,
  activityAt,
  appendRows,
  listingView,
  pageRow,
  pagesRequest,
  projectRow,
  projectTitles,
  projectsRequest,
} from "./listing.mjs";
import { SERVER_UNREACHABLE_ACTION } from "./alerts.mjs";
import { ListingCache } from "./listing-cache.mjs";

const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";
const TABLE = new URL("../test/fixtures/machines/listing.json", import.meta.url);

test("the listing table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(listingMachine, loadTable(TABLE)), {
    rows: 44,
    pairs: 33,
    unreachable: 2,
    cases: 15,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ cache = null } = {}) {
  const requests = [];
  const reports = [];
  let n = 0;
  const scheduler = new VirtualTimeScheduler();
  const listing = new Listing(
    {
      fetch: (request) => {
        const reply = deferred();
        requests.push({ ...request, query: request.params.query, ...reply });
        return reply.promise;
      },
      report: (message) => reports.push(message),
      idOf: (item) => item.id,
      cache,
    },
    { newKey: () => `k${++n}`, scheduler },
  );
  const disconnect = listing.connect();
  return {
    disconnect,
    listing,
    requests,
    reports,
    scheduler,
    view: () => listingView(listing.snapshot()),
    ids: () => listing.snapshot().items.map((item) => item.id),
  };
}

test("the first page shows, Load more appends from its cursor, and the end stops", async () => {
  const { listing, requests, view, ids } = harness();
  assert.equal(view().loading, true);
  listing.load();
  assert.deepEqual(
    requests.map(({ query, cursor }) => ({ query, cursor })),
    [{ query: "", cursor: null }],
  );
  requests[0].resolve({ items: [{ id: "a" }, { id: "b" }], cursor: "c1" });
  await settle();
  assert.deepEqual(ids(), ["a", "b"]);
  assert.equal(view().canLoadMore, true);
  assert.equal(listing.more(), true);
  assert.equal(listing.more(), false, "one Load more at a time");
  assert.equal(view().loadingMore, true);
  assert.equal(requests[1].cursor, "c1");
  // A Page edited during pagination moved onto the next page: it shows once.
  requests[1].resolve({ items: [{ id: "b" }, { id: "c" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["a", "b", "c"]);
  assert.equal(view().canLoadMore, false);
  assert.equal(listing.more(), false);
  assert.equal(requests.length, 2);
});

test("a search supersedes the request in flight and its late rows never show", async () => {
  const { listing, requests, view, ids } = harness();
  listing.load();
  requests[0].resolve({ items: [{ id: "all" }], cursor: "c1" });
  await settle();
  listing.more();
  listing.load({ query: "road" });
  assert.equal(view().searching, true, "earlier rows stay while the search runs");
  requests[1].resolve({ items: [{ id: "late" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["all"]);
  requests[2].resolve({ items: [{ id: "roadmap" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["roadmap"]);
  assert.equal(view().query, "road");
  assert.equal(view().empty, false);
  listing.load({ query: "nothing" });
  requests[3].resolve({ items: [], cursor: null });
  await settle();
  assert.equal(view().empty, true);
});

test("typing searches once it pauses, and only when the query changed", async () => {
  const { listing, requests, scheduler, disconnect } = harness();
  listing.load({ query: "" });
  requests[0].resolve({ items: [], cursor: null });
  await settle();
  listing.search("r");
  listing.search("ro");
  scheduler.flush();
  listing.search(" road ");
  scheduler.flush();
  assert.deepEqual(
    requests.map(({ query }) => query),
    ["", "ro", "road"],
  );
  listing.search("road");
  scheduler.flush();
  assert.equal(requests.length, 3, "the same query doesn't list again");
  assert.equal(SEARCH_DEBOUNCE_MS > 0, true);
  disconnect();
  listing.search("after");
  scheduler.flush();
  assert.equal(requests.length, 3, "a disconnected listing stops searching");
  // React's StrictMode connects, disconnects and connects again.
  const again = listing.connect();
  listing.search("again");
  scheduler.flush();
  assert.equal(requests.at(-1).query, "again");
  again();
});

test("a failed first page reports once and Retry lists it again", async () => {
  const { listing, requests, reports, view, ids } = harness();
  listing.load({ query: "road" });
  requests[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(view().failed, true);
  assert.equal(view().loading, false);
  assert.deepEqual(reports, [SERVER_UNREACHABLE_ACTION]);
  assert.equal(listing.more(), false);
  listing.load({ query: "road" });
  requests[1].resolve({ items: [{ id: "a" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["a"]);
  assert.equal(view().failed, false);
});

test("a failed Load more keeps the rows and retries the same cursor", async () => {
  const { listing, requests, reports, view, ids } = harness();
  listing.load();
  requests[0].resolve({ items: [{ id: "a" }], cursor: "c1" });
  await settle();
  listing.more();
  requests[1].reject(Object.assign(Error("Invalid cursor"), { status: 400 }));
  await settle();
  assert.equal(view().stalled, true);
  assert.deepEqual(ids(), ["a"]);
  assert.deepEqual(reports, ["Invalid cursor"]);
  assert.equal(listing.more(), true);
  assert.equal(requests[2].cursor, "c1");
});

test("an expired cursor starts the listing over; a transient failure keeps its cursor", async () => {
  const { listing, requests, reports, view, ids } = harness();
  listing.load({ query: "road" });
  requests[0].resolve({ items: [{ id: "a" }, { id: "b" }], cursor: "c1" });
  await settle();
  listing.more();
  requests[1].reject(
    Object.assign(Error("Pages can't reach the server."), { code: "NETWORK_ERROR" }),
  );
  await settle();
  assert.equal(view().stalled, true);
  listing.more();
  assert.equal(requests[2].cursor, "c1", "a transient failure retries the same cursor");
  // A day later the cursor has expired: the listing restarts, it doesn't stall.
  requests[2].reject(
    Object.assign(Error("Invalid cursor; restart from the first page"), {
      status: 400,
      code: "invalid_cursor",
    }),
  );
  await settle();
  assert.deepEqual(
    requests.slice(3).map(({ query, cursor }) => ({ query, cursor })),
    [{ query: "road", cursor: null }],
  );
  assert.equal(view().stalled, false);
  assert.equal(view().searching, true, "the old rows show while the first page reloads");
  assert.equal(reports.length, 1, "the restart reports nothing");
  requests[3].resolve({ items: [{ id: "new" }, { id: "a" }], cursor: "c2" });
  await settle();
  assert.deepEqual(ids(), ["new", "a"], "the first page replaces the rows");
  assert.equal(view().canLoadMore, true);
  listing.more();
  assert.equal(requests[4].cursor, "c2");
});

test("disconnecting abandons requests in flight: no rows, no banner", async () => {
  const { listing, requests, reports, ids, disconnect } = harness();
  listing.load();
  requests[0].resolve({ items: [{ id: "a" }], cursor: "c1" });
  await settle();
  listing.more();
  disconnect();
  requests[1].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.deepEqual(reports, [], "a screen that is gone reports nothing");
  assert.deepEqual(ids(), ["a"]);
  assert.equal(listing.load(), false, "a disconnected listing requests nothing");
  assert.equal(listing.more(), false);
  assert.equal(requests.length, 2);
  // StrictMode reconnects the same listing; the next load wins.
  listing.connect();
  listing.load();
  requests[2].resolve({ items: [{ id: "b" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["b"]);
});

test("a late first page after disconnecting never reaches the store", async () => {
  const { listing, requests, ids, disconnect } = harness();
  listing.load();
  disconnect();
  requests[0].resolve({ items: [{ id: "late" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), []);
});

test("searches and requests follow one query rule: trimmed, at most 200 units", async () => {
  const { listing, requests, scheduler, view } = harness();
  const long = "  " + "x".repeat(250) + "  ";
  listing.load({ query: long });
  assert.equal(requests[0].query, "x".repeat(200));
  assert.equal(view().query, "x".repeat(200));
  listing.search("  road  ");
  scheduler.flush();
  assert.equal(requests[1].query, "road");
  const calls = [];
  await pagesRequest(async (name, args) => (calls.push(args), { pages: [] }))({
    params: { query: "y".repeat(300) },
    cursor: null,
  });
  assert.equal(calls[0].query.length, 200);
});

test("a fetch adapter that throws reports like one that rejects", async () => {
  const reports = [];
  const listing = new Listing({
    fetch: () => {
      throw new Error("No tools");
    },
    report: (message) => reports.push(message),
    idOf: (item) => item.id,
  });
  listing.connect();
  listing.load();
  await settle();
  assert.equal(listing.snapshot().state.name, "failed");
  assert.deepEqual(reports, ["No tools"]);
});

test("appendRows keeps identity when nothing new arrives", () => {
  const items = [{ id: "a" }];
  assert.equal(
    appendRows(items, [{ id: "a" }], (item) => item.id),
    items,
  );
});

test("the request adapters page with cursors and search only where the API can", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    return name === "list_pages"
      ? { pages: [{ page_id: "p" }], next_cursor: "next" }
      : { projects: [{ project_id: "prj" }], next_cursor: null };
  };
  assert.deepEqual(await pagesRequest(call)({ params: {}, cursor: null }), {
    items: [{ page_id: "p" }],
    cursor: "next",
  });
  await pagesRequest(call)({ params: { query: "road" }, cursor: "next" });
  await pagesRequest(call)({
    params: { query: "", access: "owned", sort: "title", projectId },
    cursor: null,
  });
  await pagesRequest(call)({ params: { access: "shared", sort: "activity" }, cursor: null });
  assert.deepEqual(await projectsRequest(call)({ params: { query: "ignored" }, cursor: "c" }), {
    items: [{ project_id: "prj" }],
    cursor: null,
  });
  assert.deepEqual(calls, [
    ["list_pages", { limit: 50 }],
    ["list_pages", { limit: 50, query: "road", cursor: "next" }],
    ["list_pages", { limit: 50, access: "owned", sort: "title", project_id: projectId }],
    ["list_pages", { limit: 50, access: "shared" }],
    ["list_projects", { limit: 100, cursor: "c" }],
  ]);
});

test("a /pages row links its Page and labels its Project; shared Pages show no Project", () => {
  const titles = projectTitles([{ project_id: projectId, title: "Launch" }]);
  assert.deepEqual(pageRow({ page_id: pageId, title: "", project_id: projectId }, titles), {
    id: pageId,
    title: "Untitled",
    href: `/p/${pageId}`,
    activityAt: null,
    project: { id: projectId, title: "Launch", href: `/project/${projectId}` },
    shared: false,
    home: false,
    local: null,
  });
  assert.deepEqual(pageRow({ page_id: pageId, title: "Notes" }).project, null);
  assert.equal(
    pageRow({ page_id: pageId, updated_at: "2026-11-01T18:00:00.000Z" }).activityAt,
    "2026-11-01T18:00:00.000Z",
    "a Page with no content time is as active as its catalog entry",
  );
  assert.equal(activityAt({ page_id: pageId }), null);
  assert.equal(activityAt(undefined), null);
  assert.equal(
    pageRow({ page_id: pageId, project_id: projectId, home: true }).project.title,
    "Project",
    "a Project that hasn't loaded still links",
  );
  const shared = pageRow({ page_id: pageId, title: "Theirs", shared: true, project_id: projectId });
  assert.equal(shared.shared, true);
  assert.equal(shared.project, null);
});

test("a /projects row carries its description only when there is one", () => {
  assert.deepEqual(projectRow({ project_id: projectId, title: "Launch", description: "  " }), {
    id: projectId,
    title: "Launch",
    description: "",
    href: `/project/${projectId}`,
  });
  assert.equal(
    projectRow({ project_id: projectId, description: "Where it lives." }).description,
    "Where it lives.",
  );
});

test("a change to any param supersedes the request in flight; typing keeps the other params", async () => {
  const { listing, requests, scheduler, ids } = harness();
  listing.load({ query: "road", access: "owned" });
  listing.load({ query: "road", access: "shared" });
  requests[0].resolve({ items: [{ id: "owned" }], cursor: null });
  requests[1].resolve({ items: [{ id: "shared" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["shared"], "the superseded tab's rows never show");
  assert.deepEqual(listing.params(), {
    query: "road",
    access: "shared",
    sort: "activity",
    projectId: null,
  });
  listing.search("plan");
  scheduler.flush();
  assert.deepEqual(requests[2].params, { ...listing.params(), query: "plan" });
  assert.equal(requests[2].params.access, "shared", "a search keeps the tab");
  listing.load({ query: "plan", access: "owned", projectId, sort: "title" });
  assert.deepEqual(requests[3].params, {
    query: "plan",
    access: "owned",
    sort: "title",
    projectId,
  });
  // A Project with the shared tab is a request list_pages refuses; the
  // listing never sends it.
  listing.load({ access: "shared", projectId });
  assert.deepEqual(requests[4].params, {
    query: "",
    access: "shared",
    sort: "activity",
    projectId: null,
  });
});

test("an expired cursor restarts with the same params", async () => {
  const { listing, requests } = harness();
  const params = { query: "", access: "owned", sort: "title", projectId };
  listing.load(params);
  requests[0].resolve({ items: [{ id: "a" }], cursor: "c1" });
  await settle();
  listing.more();
  requests[1].reject(Object.assign(Error("Invalid cursor"), { code: "invalid_cursor" }));
  await settle();
  assert.deepEqual(requests[2].params, params);
  assert.equal(requests[2].cursor, null);
});

test("drafts on this device show on All and Your items until the server lists them", () => {
  const local = [
    { page_id: "draft", title: "Draft", pending: true },
    { page_id: "synced", title: "Synced", pending: false },
    { page_id: "copy", title: "Copy", pending: false },
  ];
  const items = [{ page_id: "synced" }];
  const all = { query: "", access: null, projectId: null };
  const ids = (rows) => rows.map((page) => page.page_id);
  assert.deepEqual(ids(deviceRows(local, items, all)), ["draft"]);
  assert.deepEqual(ids(deviceRows(local, items, { ...all, access: "owned" })), ["draft"]);
  assert.deepEqual(ids(deviceRows(local, [], all, { failed: true })), ["draft", "synced", "copy"]);
  assert.deepEqual(
    ids(deviceRows(local, [], { ...all, access: "owned" }, { failed: true })),
    ["draft"],
    "offline, Your items shows only drafts: a local copy can be someone else's Page",
  );
  for (const view of [
    { ...all, access: "shared" },
    { ...all, access: "owned", projectId },
  ])
    assert.deepEqual(deviceRows(local, items, view), [], JSON.stringify(view));
  // The server's search can't see drafts; their titles are searched here.
  assert.deepEqual(ids(deviceRows(local, items, { ...all, query: "DR" })), ["draft"]);
  assert.deepEqual(ids(deviceRows(local, items, { ...all, query: "road" })), []);
  assert.deepEqual(
    ids(deviceRows([{ page_id: "blank", title: "", pending: true }], [], { ...all, query: "unt" })),
    ["blank"],
    "an untitled draft matches Untitled, as it shows",
  );
  assert.deepEqual(
    ids(deviceRows(local, [], { ...all, query: "co" }, { failed: true })),
    ["copy"],
    "offline, a search keeps the local copies whose title holds it",
  );
  assert.deepEqual(ids(deviceRows(local, [{ page_id: "draft" }], all)), [], "listed once");
  assert.deepEqual(deviceRows(undefined, items, all), []);
  assert.equal(
    pageRow({ ...local[0], page_id: pageId }, new Map(), { local: true }).local,
    "pending",
  );
  assert.equal(pageRow({ ...local[2], page_id: pageId }, new Map(), { local: true }).local, "copy");
});

test("Last activity is the content time when the Page reported one, else the catalog time", () => {
  // A content edit doesn't move updated_at; list_pages orders by
  // content_updated_at || updated_at, and the row shows the same time.
  const edited = {
    page_id: pageId,
    updated_at: "2026-09-02T10:00:00.000Z",
    content_updated_at: "2026-11-03T09:00:00.000Z",
  };
  assert.equal(activityAt(edited), "2026-11-03T09:00:00.000Z");
  assert.equal(pageRow(edited).activityAt, "2026-11-03T09:00:00.000Z");
  assert.equal(activityAt({ ...edited, content_updated_at: null }), "2026-09-02T10:00:00.000Z");
  assert.equal(activityAt({ ...edited, content_updated_at: "" }), "2026-09-02T10:00:00.000Z");
});

test("Load more in flight, then another view: the next page never appends to it", async () => {
  const { listing, requests, ids, view } = harness();
  listing.load();
  requests[0].resolve({ items: [{ id: "a" }, { id: "b" }], cursor: "c1" });
  await settle();
  assert.equal(listing.more(), true);
  listing.load({ access: "shared" });
  // The old view's next page lands first, then the new view's first page.
  requests[1].resolve({ items: [{ id: "old-next" }], cursor: "c2" });
  await settle();
  assert.deepEqual(ids(), ["a", "b"], "the abandoned page appends nothing");
  requests[2].resolve({ items: [{ id: "shared" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["shared"]);
  assert.equal(view().canLoadMore, false, "the old cursor is gone with its view");
  assert.equal(listing.more(), false);
  assert.equal(requests.length, 3);
});

/** A cache scope for one account, as Library passes it. */
const scoped = (cache = new ListingCache(), principal = "alice") => ({
  cache,
  scope: cache.scope(principal),
});

test("a view this tab showed paints from memory, then its first page replaces it", async () => {
  const { cache, scope } = scoped();
  const first = harness({ cache: scope });
  first.listing.load();
  assert.equal(first.view().loading, true, "nothing remembered yet");
  first.requests[0].resolve({ items: [{ id: "a" }, { id: "b" }], cursor: "c1" });
  await settle();
  first.listing.more();
  first.requests[1].resolve({ items: [{ id: "c" }], cursor: null });
  await settle();
  first.disconnect();
  assert.deepEqual(
    cache.read("alice", {}).map((item) => item.id),
    ["a", "b"],
    "only the first page is remembered",
  );

  // A return visit: a new Listing for the same account paints at once.
  const again = harness({ cache: scope });
  again.listing.load();
  assert.deepEqual(again.ids(), ["a", "b"]);
  assert.equal(again.view().refreshing, true);
  assert.equal(again.view().loading, false, "no Loading… over remembered rows");
  assert.equal(again.view().searching, false);
  assert.equal(again.listing.more(), false, "Load more waits for the fresh first page");
  assert.equal(again.requests.length, 1, "and the first page is asked for again");
  again.requests[0].resolve({ items: [{ id: "new" }, { id: "a" }], cursor: null });
  await settle();
  assert.deepEqual(again.ids(), ["new", "a"]);
  assert.equal(again.view().refreshing, false);
  assert.deepEqual(
    cache.read("alice", {}).map((item) => item.id),
    ["new", "a"],
  );
});

test("a remembered view that fails to refresh drops its rows and reports", async () => {
  const { scope } = scoped();
  const first = harness({ cache: scope });
  first.listing.load({ access: "owned" });
  first.requests[0].resolve({ items: [{ id: "mine" }], cursor: null });
  await settle();
  const again = harness({ cache: scope });
  again.listing.load({ access: "owned" });
  assert.deepEqual(again.ids(), ["mine"]);
  again.requests[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(again.view().failed, true);
  assert.deepEqual(again.reports, [SERVER_UNREACHABLE_ACTION]);
});

test("switching back to a tab paints it from memory while it refreshes", async () => {
  const { scope } = scoped();
  const { listing, requests, ids, view } = harness({ cache: scope });
  listing.load();
  requests[0].resolve({ items: [{ id: "all" }], cursor: null });
  await settle();
  listing.load({ access: "shared" });
  assert.equal(view().searching, true, "a tab never shown keeps the old rows and says so");
  requests[1].resolve({ items: [{ id: "theirs" }], cursor: null });
  await settle();
  listing.load();
  assert.deepEqual(ids(), ["all"], "All paints at once");
  assert.equal(view().refreshing, true);
  // A late answer for the superseded request changes nothing.
  listing.load({ access: "shared" });
  assert.deepEqual(ids(), ["theirs"]);
  requests[2].resolve({ items: [{ id: "stale-all" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["theirs"]);
  requests[3].resolve({ items: [{ id: "theirs-2" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["theirs-2"]);
});

test("the listing cache keeps one account's rows to that account", () => {
  const cache = new ListingCache({ limit: 2 });
  const rows = [{ page_id: "p1" }, { page_id: "p2" }];
  cache.write("alice", { access: "owned" }, rows);
  assert.deepEqual(cache.read("alice", { access: "owned" }), rows);
  assert.equal(cache.read("bob", { access: "owned" }), null, "never across accounts");
  assert.equal(cache.read(null, { access: "owned" }), null);
  assert.equal(cache.scope(null), null, "no account, no cache");
  // Params normalize like the request: a Project implies Your items.
  cache.write("alice", { projectId }, rows);
  assert.deepEqual(cache.read("alice", { access: "owned", projectId }), rows);
  // An empty first page forgets the view: nothing to paint.
  cache.write("alice", { projectId }, []);
  assert.equal(cache.read("alice", { projectId }), null);
  // The least recently written view goes first.
  cache.write("alice", { query: "a" }, rows);
  cache.write("alice", { query: "b" }, rows);
  assert.equal(cache.read("alice", { access: "owned" }), null);
  assert.equal(cache.size, 2);
  // A Page moved to Trash leaves every remembered page.
  cache.forget("p1");
  assert.deepEqual(cache.read("alice", { query: "a" }), [{ page_id: "p2" }]);
  cache.forget("p2");
  assert.equal(cache.read("alice", { query: "a" }), null);
  cache.write("alice", {}, rows);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("the request adapters report each answer and can share the first Projects page", async () => {
  const seen = [];
  const call = async (name) =>
    name === "list_pages"
      ? { pages: [], next_cursor: null, quota: { limit: 10, count: 9 } }
      : { projects: [{ project_id: "later" }], next_cursor: null };
  await pagesRequest(call, { onResult: (result) => seen.push(result.quota) })({
    params: {},
    cursor: null,
  });
  assert.deepEqual(seen, [{ limit: 10, count: 9 }]);
  let firsts = 0;
  const first = async () => (firsts++, { projects: [{ project_id: "shared" }], next_cursor: "c" });
  assert.deepEqual(await projectsRequest(call, { first })({ cursor: null }), {
    items: [{ project_id: "shared" }],
    cursor: "c",
  });
  assert.deepEqual(await projectsRequest(call, { first })({ cursor: "c" }), {
    items: [{ project_id: "later" }],
    cursor: null,
  });
  assert.equal(firsts, 1, "only the first page comes from the shared request");
});
