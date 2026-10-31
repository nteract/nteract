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
  appendRows,
  listingView,
  pageRow,
  pagesRequest,
  projectRow,
  projectTitles,
  projectsRequest,
} from "./listing.mjs";
import { SERVER_UNREACHABLE_ACTION } from "./alerts.mjs";

const TABLE = new URL("../test/fixtures/machines/listing.json", import.meta.url);

test("the listing table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(listingMachine, loadTable(TABLE)), {
    rows: 27,
    pairs: 22,
    unreachable: 2,
    cases: 10,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const requests = [];
  const reports = [];
  let n = 0;
  const scheduler = new VirtualTimeScheduler();
  const listing = new Listing(
    {
      fetch: (request) => {
        const reply = deferred();
        requests.push({ ...request, ...reply });
        return reply.promise;
      },
      report: (message) => reports.push(message),
      idOf: (item) => item.id,
    },
    { newKey: () => `k${++n}`, scheduler },
  );
  return {
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
  listing.load("road");
  assert.equal(view().searching, true, "earlier rows stay while the search runs");
  requests[1].resolve({ items: [{ id: "late" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["all"]);
  requests[2].resolve({ items: [{ id: "roadmap" }], cursor: null });
  await settle();
  assert.deepEqual(ids(), ["roadmap"]);
  assert.equal(view().query, "road");
  assert.equal(view().empty, false);
  listing.load("nothing");
  requests[3].resolve({ items: [], cursor: null });
  await settle();
  assert.equal(view().empty, true);
});

test("typing searches once it pauses, and only when the query changed", async () => {
  const { listing, requests, scheduler } = harness();
  const disconnect = listing.connect();
  listing.load("");
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
  listing.load("road");
  requests[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(view().failed, true);
  assert.equal(view().loading, false);
  assert.deepEqual(reports, [SERVER_UNREACHABLE_ACTION]);
  assert.equal(listing.more(), false);
  listing.load("road");
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

test("a fetch adapter that throws reports like one that rejects", async () => {
  const reports = [];
  const listing = new Listing({
    fetch: () => {
      throw new Error("No tools");
    },
    report: (message) => reports.push(message),
    idOf: (item) => item.id,
  });
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
  assert.deepEqual(await pagesRequest(call)({ query: "", cursor: null }), {
    items: [{ page_id: "p" }],
    cursor: "next",
  });
  await pagesRequest(call)({ query: "road", cursor: "next" });
  assert.deepEqual(await projectsRequest(call)({ query: "ignored", cursor: "c" }), {
    items: [{ project_id: "prj" }],
    cursor: null,
  });
  assert.deepEqual(calls, [
    ["list_pages", { limit: 50 }],
    ["list_pages", { limit: 50, query: "road", cursor: "next" }],
    ["list_projects", { limit: 100, cursor: "c" }],
  ]);
});

const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";

test("a /pages row links its Page and labels its Project; shared Pages show no Project", () => {
  const titles = projectTitles([{ project_id: projectId, title: "Launch" }]);
  assert.deepEqual(pageRow({ page_id: pageId, title: "", project_id: projectId }, titles), {
    id: pageId,
    title: "Untitled",
    href: `/p/${pageId}`,
    project: { id: projectId, title: "Launch", href: `/project/${projectId}` },
    shared: false,
    home: false,
  });
  assert.deepEqual(pageRow({ page_id: pageId, title: "Notes" }).project, null);
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
