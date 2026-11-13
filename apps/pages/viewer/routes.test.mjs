import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPageSlug,
  pagePath,
  pageSlugWords,
  readPageRoute,
  writePageRoute,
  writeRoute,
  rememberScroll,
  savedScroll,
  SCROLL_STATE_KEY,
  pagesPath,
  isIndexRoute,
  clampPagesQuery,
  normalizePagesQuery,
  PAGES_QUERY_MAX,
  PROJECTS_PATH,
  isPlainNavigation,
  mergePageListings,
  LIBRARY_DEFAULTS,
  LIBRARY_SORTS,
  groupApplies,
  isLibraryRoute,
  libraryBase,
  libraryPath,
  libraryRequest,
  normalizeLibraryView,
  sameLibraryRequest,
} from "../shared/routes.mjs";
const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
test("canonical and existing shared Page links resolve to the same document", () => {
  const expected = { kind: "page", pageId: id, path: `/p/${id}`, slug: null };
  assert.deepEqual(readPageRoute(`/p/${id}`), expected);
  assert.deepEqual(readPageRoute(`/?page=${id}`), expected);
  assert.deepEqual(readPageRoute(`/p/${id}/`), expected);
  assert.deepEqual(readPageRoute("/"), { kind: "home", library: LIBRARY_DEFAULTS, path: "/" });
  for (const path of ["/p/nope", "/p/", "/p/" + id + "/other/more", "/missing", "/?page=bad"])
    assert.equal(readPageRoute(path).kind, "missing");
  assert.throws(() => pagePath("../api/auth/logout"), /Invalid Page/);
});
test("a slug after a Page id opens the same Page and stays out of its canonical path", () => {
  const page = (slug) => ({ kind: "page", pageId: id, path: `/p/${id}`, slug });
  for (const [path, slug] of [
    [`/p/${id}/My-Dashboard`, "My-Dashboard"],
    [`/p/${id}/My-Dashboard/`, "My-Dashboard"],
    [`/p/${id}/My-Dashboard#q3-goals`, "My-Dashboard"],
    [`/p/${id}/My-Dashboard?x=1`, "My-Dashboard"],
    [`/p/${id}/q3_plan`, "q3_plan"],
    [`/p/${id}/2026`, "2026"],
    [`/p/${id}/${"a".repeat(80)}`, "a".repeat(80)],
    [`https://pages.example/p/${id}/Notes`, "Notes"],
  ])
    assert.deepEqual(readPageRoute(path), page(slug), path);
  // The old Page forms are unchanged and carry none.
  assert.deepEqual(readPageRoute(`/?page=${id}`), page(null));
  assert.deepEqual(readPageRoute(`/p/${id}`), page(null));
  assert.equal(readPageRoute(`/s/sp_${id}`).kind, "project");
});
test("a slug outside the grammar, or a reserved one, is not a Page route", () => {
  for (const slug of [
    "view",
    "View",
    "VIEW",
    "meta.json",
    "card.json",
    "My.Dashboard",
    "a".repeat(81),
    "-",
    "_-_",
    "My%20Dashboard",
    "%3Cscript%3E",
    "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "caf%C3%A9",
    "a~b",
    "a+b",
    "a'b",
    "a&b",
    "a=b",
    "(x)",
  ]) {
    assert.equal(readPageRoute(`/p/${id}/${slug}`).kind, "missing", slug);
    assert.equal(isPageSlug(slug), false, slug);
  }
  // A literal space, quote or angle bracket arrives percent-encoded.
  for (const raw of ["<script>", "a b", 'a"b', "x<y"])
    assert.equal(readPageRoute(`/p/${id}/${raw}`).kind, "missing", raw);
  for (const slug of [null, undefined, "", 5, {}]) assert.equal(isPageSlug(slug), false);
});
test("a slug reads as words: separators become one space, nothing else changes", () => {
  assert.equal(pageSlugWords("My-Dashboard"), "My Dashboard");
  assert.equal(pageSlugWords("q3_plan--v2"), "q3 plan v2");
  assert.equal(pageSlugWords("-_Lead-and-trail_-"), "Lead and trail");
  assert.equal(pageSlugWords("ALLCAPS"), "ALLCAPS");
  assert.equal(pageSlugWords("2026"), "2026");
});
test("pagePath builds a slugged link that reads back as the same Page", () => {
  assert.equal(pagePath(id, "My-Dashboard"), `/p/${id}/My-Dashboard`);
  assert.equal(pagePath(id, null), `/p/${id}`);
  assert.equal(pagePath(id), `/p/${id}`);
  for (const slug of ["My-Dashboard", "q3_plan", "x"]) {
    const route = readPageRoute(pagePath(id, slug));
    assert.deepEqual(route, { kind: "page", pageId: id, path: `/p/${id}`, slug });
    assert.equal(pagePath(route.pageId, route.slug), pagePath(id, slug));
  }
  for (const slug of ["view", "a.b", "", "a/b"])
    assert.throws(() => pagePath(id, slug), /Invalid Page slug/, slug);
});
test("a replace keeps the slug the address shows for the same Page; a push or another Page drops it", () => {
  const calls = [];
  const location = {};
  const at = (path) => {
    const url = new URL(path, "https://pages.example");
    Object.assign(location, {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    });
  };
  const history = Object.fromEntries(
    ["pushState", "replaceState"].map((method) => [
      method,
      (state, _, path) => {
        calls.push({ method, path });
        at(path);
      },
    ]),
  );
  const other = "2b160b47-6df1-4983-81eb-489ca5a26812";
  at(`/p/${id}/My-Dashboard#goals`);
  // Opening the Page the address names rewrites nothing: slug and fragment stay.
  writePageRoute(id, { history, location, replace: true });
  at(`/p/${id}/My-Dashboard/`);
  writePageRoute(id, { history, location, replace: true });
  // An anchor written in place keeps the slug.
  writePageRoute(id, { history, location, replace: true, anchor: "risks" });
  // Another Page, and a new visit, start without it. A replace keeps the
  // visit's fragment as it always does.
  writePageRoute(other, { history, location, replace: true });
  at(`/p/${id}/My-Dashboard`);
  writePageRoute(id, { history, location });
  assert.deepEqual(calls, [
    { method: "replaceState", path: `/p/${id}/My-Dashboard` },
    { method: "replaceState", path: `/p/${id}/My-Dashboard#risks` },
    { method: "replaceState", path: `/p/${other}#risks` },
    { method: "pushState", path: `/p/${id}` },
  ]);
});
test("a Page's JSON routes are the Worker's, never a Page the app opens", () => {
  // The gateway answers /p/<id>/meta.json and /card.json; if one ever
  // reaches the app shell, the router shows it as missing, not as the Page.
  for (const file of ["meta.json", "card.json"])
    for (const path of [`/p/${id}/${file}`, `/p/${id}/${file}/`, `/p/${id}/${file}?v=1`])
      assert.equal(readPageRoute(path).kind, "missing", path);
});
test("a Project's JSON routes are the Worker's, never a Project the app opens", () => {
  // The gateway answers /project/<id>/meta.json and /card.json; the older
  // /s/ form has no JSON routes and stays the app's, read as missing too.
  for (const projectId of [`prj_${id}`, `sp_${id}`])
    for (const file of ["meta.json", "card.json"])
      for (const path of [
        `/project/${projectId}/${file}`,
        `/project/${projectId}/${file}/`,
        `/project/${projectId}/${file}?v=1`,
        `/s/${projectId}/${file}`,
      ])
        assert.equal(readPageRoute(path).kind, "missing", path);
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
test("heading fragments: an anchor is written encoded, a replace keeps the visit's fragment", () => {
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
  writePageRoute(id, { history, location, anchor: "café-notes" });
  // The same address again writes nothing.
  writePageRoute(id, { history, location, anchor: "café-notes" });
  // Canonicalizing the visit (a legacy link, a Project's document) keeps it.
  Object.assign(location, { pathname: "/", search: `?page=${id}` });
  writePageRoute(id, { history, location, replace: true });
  const project = `prj_${id}`;
  writePageRoute(project, { history, location, replace: true });
  // A new visit and the library start without one.
  writePageRoute(id, { history, location });
  location.hash = "#kept";
  writePageRoute(null, { history, location, replace: true });
  assert.deepEqual(calls, [
    { method: "pushState", path: `/p/${id}#caf%C3%A9-notes` },
    { method: "replaceState", path: `/p/${id}#caf%C3%A9-notes` },
    { method: "replaceState", path: `/project/${project}#caf%C3%A9-notes` },
    { method: "pushState", path: `/p/${id}` },
    { method: "replaceState", path: "/" },
  ]);
});
test("/projects and /pages are exact index routes with an optional trailing slash", () => {
  for (const path of ["/projects", "/projects/", "/projects?from=home"])
    assert.deepEqual(readPageRoute(path), { kind: "projects", path: PROJECTS_PATH });
  for (const path of ["/pages", "/pages/", "/pages?q=", "/pages?q=%20%20"])
    assert.deepEqual(readPageRoute(path), {
      kind: "pages",
      library: LIBRARY_DEFAULTS,
      path: "/pages",
    });
  assert.deepEqual(readPageRoute("/pages?q=%20road%20map%20"), {
    kind: "pages",
    library: { ...LIBRARY_DEFAULTS, query: "road map" },
    path: "/pages?q=road+map",
  });
  assert.equal(readPageRoute(`/pages?q=${"x".repeat(300)}`).library.query.length, 200);
  for (const path of [
    "/projects/x",
    "/projects//",
    "/pages/x",
    "/pages//",
    "/page",
    "/project",
    "/projectsx",
    "/Pages",
    `/projects/prj_${id}`,
    `/pages/${id}`,
  ])
    assert.equal(readPageRoute(path).kind, "missing", path);
  assert.equal(isIndexRoute(readPageRoute("/projects")), true);
  assert.equal(isIndexRoute(readPageRoute("/pages?q=a")), true);
  for (const path of ["/", `/p/${id}`, `/project/prj_${id}`, "/missing"])
    assert.equal(isIndexRoute(readPageRoute(path)), false, path);
  assert.equal(pagesPath(), "/pages");
  assert.equal(pagesPath("  "), "/pages");
  assert.equal(pagesPath("a&b"), "/pages?q=a%26b");
  assert.equal(readPageRoute(pagesPath("a&b=c")).library.query, "a&b=c");
});
test("a /pages query has one rule for the box, the request and the address", () => {
  assert.equal(PAGES_QUERY_MAX, 200);
  assert.equal(normalizePagesQuery(undefined), "");
  assert.equal(normalizePagesQuery(null), "");
  assert.equal(normalizePagesQuery("  road  "), "road");
  assert.equal(normalizePagesQuery("x".repeat(250)), "x".repeat(200));
  // A cut that would end inside a word with spaces before it drops the spaces.
  assert.equal(normalizePagesQuery("x".repeat(199) + " yz"), "x".repeat(199));
  // A cut never leaves half a surrogate pair, which list_pages would count
  // and the address would mangle.
  const emoji = "x".repeat(199) + "😀";
  assert.equal(normalizePagesQuery(emoji), "x".repeat(199));
  for (const raw of ["  road map ", "x".repeat(300), emoji, "a&b=c"]) {
    const query = normalizePagesQuery(raw);
    assert.ok(query.length <= PAGES_QUERY_MAX);
    assert.equal(normalizePagesQuery(query), query, "normalizing twice changes nothing");
    assert.equal(
      readPageRoute(pagesPath(raw)).library.query,
      query,
      "a reload lists the same search",
    );
    assert.equal(pagesPath(query), pagesPath(raw));
  }
});
test("the search box clamps by code point, so it holds exactly what a search sends", () => {
  const ascii = "x".repeat(199);
  // 199 ASCII units and one emoji is 201 units: the emoji doesn't fit.
  assert.equal(clampPagesQuery(ascii + "😀"), ascii);
  assert.equal(clampPagesQuery(ascii + "😀 more"), ascii);
  // A maxLength-style cut that already split the pair loses the stray half.
  assert.equal(clampPagesQuery(ascii + "\uD83D"), ascii);
  // An emoji that fits stays whole; spaces are the caller's to trim.
  assert.equal(clampPagesQuery("x".repeat(198) + "😀"), "x".repeat(198) + "😀");
  assert.equal(clampPagesQuery("  road  "), "  road  ");
  assert.equal(clampPagesQuery(undefined), "");
  for (const raw of [ascii + "😀", ascii + "\uD83D", "x".repeat(198) + "😀", " " + ascii + "😀"]) {
    const stored = clampPagesQuery(raw);
    const query = normalizePagesQuery(stored);
    assert.equal(normalizePagesQuery(raw), query, "the box and a direct request agree");
    assert.equal(readPageRoute(pagesPath(stored)).library.query, query, "and so does the address");
    assert.equal(query.isWellFormed(), true);
  }
});
test("index routes push once and search edits replace the entry", () => {
  const calls = [];
  const location = { pathname: "/", search: "", hash: "" };
  const history = Object.fromEntries(
    ["pushState", "replaceState"].map((method) => [
      method,
      (state, _, path) => {
        calls.push({ method, path, state });
        const url = new URL(path, "https://pages.invalid");
        Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
      },
    ]),
  );
  writeRoute("/pages", { history, location });
  writeRoute("/pages", { history, location });
  writeRoute(pagesPath("road"), { history, location, replace: true });
  writeRoute(PROJECTS_PATH, { history, location, state: { index: "projects" } });
  assert.deepEqual(calls, [
    { method: "pushState", path: "/pages", state: null },
    { method: "replaceState", path: "/pages?q=road", state: null },
    { method: "pushState", path: "/projects", state: { index: "projects" } },
  ]);
});
test("a push records the scroll position in the entry it leaves; a replace keeps it", () => {
  const location = { pathname: "/", search: "", hash: "" };
  const entries = [{ state: null, path: "/" }];
  let index = 0;
  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(state, _, path) {
      entries.splice(index + 1, Infinity, { state, path });
      index++;
      const url = new URL(path, "https://pages.invalid");
      Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
    },
    replaceState(state, _, path) {
      entries[index] = { state, path: path ?? entries[index].path };
      if (path === undefined) return;
      const url = new URL(path, "https://pages.invalid");
      Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
    },
  };
  const at = (y) => ({ history, location, scrollY: y });
  writePageRoute(id, at(120));
  assert.deepEqual(entries[0].state, { [SCROLL_STATE_KEY]: { path: "/", y: 120 } });
  assert.deepEqual(entries[1].state, { pageId: id });
  rememberScroll(480, { history, location });
  assert.equal(savedScroll({ history, location }), 480);
  // A heading link on the same Page: a new entry, without the old position.
  writeRoute(`/p/${id}#plan`, { ...at(500), state: history.state });
  assert.deepEqual(entries[1].state, {
    pageId: id,
    [SCROLL_STATE_KEY]: { path: `/p/${id}`, y: 500 },
  });
  assert.deepEqual(entries[2].state, { pageId: id });
  assert.equal(savedScroll({ history, location }), null);
  // Canonicalizing the same address keeps the entry's position; moving it
  // elsewhere drops it.
  rememberScroll(64, { history, location });
  writePageRoute(id, { ...at(64), replace: true, anchor: "notes" });
  assert.deepEqual(entries[2].state, {
    pageId: id,
    [SCROLL_STATE_KEY]: { path: `/p/${id}`, y: 64 },
  });
  writePageRoute(`prj_${id}`, { ...at(64), replace: true });
  assert.deepEqual(entries[2].state, { pageId: `prj_${id}` });
  // A position measured at another address isn't this entry's.
  entries[2].state = { [SCROLL_STATE_KEY]: { path: "/pages", y: 10 } };
  assert.equal(savedScroll({ history, location }), null);
  // No scroll position to read (outside a browser): nothing is recorded.
  rememberScroll(undefined, { history, location });
  assert.deepEqual(entries[2].state, { [SCROLL_STATE_KEY]: { path: "/pages", y: 10 } });
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
const prj = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";
test("the library keeps its view in the address at / and /pages, defaults left out", () => {
  const view = {
    query: " road ",
    access: "owned",
    sort: "title",
    group: "project",
    projectId: prj,
  };
  for (const base of ["/", "/pages"]) {
    const path = libraryPath(base, view);
    assert.equal(path, `${base}?q=road&show=owned&sort=title&group=project&project=${prj}`);
    const route = readPageRoute(path);
    assert.equal(route.kind, base === "/" ? "home" : "pages");
    assert.deepEqual(route.library, { ...view, query: "road" });
    assert.equal(route.path, path, "a route's path is its canonical address");
    assert.equal(isLibraryRoute(route), true);
    assert.equal(libraryBase(route), base);
    assert.equal(libraryPath(base), base);
    assert.equal(libraryPath(base, LIBRARY_DEFAULTS), base);
  }
  assert.equal(libraryPath("/", { access: "shared" }), "/?show=shared");
  assert.equal(libraryPath("/", { group: "date" }), "/?group=date");
  assert.equal(isIndexRoute(readPageRoute("/?show=shared")), false, "Home starts the editor");
  assert.equal(isLibraryRoute(readPageRoute("/projects")), false);
  assert.equal(readPageRoute(`/?page=${id}&show=shared`).kind, "page", "legacy links still open");
});

test("one rule normalizes the library view: unknown values, Projects and date groups", () => {
  assert.deepEqual(normalizeLibraryView(), LIBRARY_DEFAULTS);
  assert.deepEqual(normalizeLibraryView(null), LIBRARY_DEFAULTS);
  assert.deepEqual(
    normalizeLibraryView({ access: "everyone", sort: "created", group: "author", projectId: "x" }),
    LIBRARY_DEFAULTS,
    "values this build doesn't know fall back to the defaults",
  );
  assert.deepEqual(normalizeLibraryView({ projectId: prj }), {
    ...LIBRARY_DEFAULTS,
    access: "owned",
    projectId: prj,
  });
  assert.deepEqual(
    normalizeLibraryView({ access: "shared", projectId: prj }),
    { ...LIBRARY_DEFAULTS, access: "shared" },
    "list_pages refuses shared with project_id, so the shared tab drops the Project",
  );
  assert.equal(normalizeLibraryView({ sort: "title", group: "date" }).group, null);
  assert.equal(normalizeLibraryView({ sort: "title", group: "project" }).group, "project");
  assert.equal(normalizeLibraryView({ group: "date" }).group, "date");
  assert.equal(groupApplies("date", "activity"), true);
  assert.equal(groupApplies("date", "title"), false);
  assert.equal(groupApplies(null, "title"), true);
  assert.deepEqual(
    LIBRARY_SORTS.map((entry) => entry.value),
    ["activity", "title"],
  );
  assert.equal(
    readPageRoute("/?show=shared&project=" + prj).path,
    "/?show=shared",
    "an address list_pages would refuse is rewritten",
  );
  assert.equal(readPageRoute("/pages?sort=title&group=date").path, "/pages?sort=title");
  for (const view of [
    {},
    { query: "x".repeat(300), access: "shared", group: "date" },
    { projectId: prj, sort: "title", group: "project" },
  ]) {
    const once = normalizeLibraryView(view);
    assert.deepEqual(normalizeLibraryView(once), once, "normalizing twice changes nothing");
    assert.deepEqual(readPageRoute(libraryPath("/", once)).library, once, "a reload agrees");
  }
});

test("a library request is the view without its grouping", () => {
  const request = libraryRequest({ query: "a", group: "date", projectId: prj });
  assert.deepEqual(request, { query: "a", access: "owned", sort: "activity", projectId: prj });
  assert.equal(sameLibraryRequest(request, { ...request }), true);
  assert.equal(sameLibraryRequest(request, libraryRequest({ query: "a", projectId: prj })), true);
  for (const change of [{ query: "b" }, { access: null }, { sort: "title" }, { projectId: null }])
    assert.equal(sameLibraryRequest(request, { ...request, ...change }), false);
  assert.equal(sameLibraryRequest(undefined, request), false);
});
