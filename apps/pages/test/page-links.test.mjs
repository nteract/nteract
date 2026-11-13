import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorFromHash,
  appRoute,
  linkTarget,
  linkedPage,
  linkedTarget,
  pageLink,
} from "../shared/page-links.mjs";
import { inAppLink } from "../viewer/heading-links.mjs";

const here = "1a160b47-6df1-4983-81eb-489ca5a26812";
const id = "2b160b47-6df1-4983-81eb-489ca5a26812";
const project = `prj_${id}`;
const base = `https://pages.runtimed.run/p/${here}`;
const page = (pageId, anchor = null) => ({ pageId, anchor });

// [href, pageLink's answer against `base`]. Every link that isn't exactly one
// of this deployment's Page routes is null.
const ROWS = [
  [`https://pages.runtimed.run/p/${id}`, page(id)],
  [`https://pages.runtimed.run/p/${id}#follow-ups`, page(id, "follow-ups")],
  [`https://pages.runtimed.run/p/${id}#caf%C3%A9`, page(id, "café")],
  [`https://pages.runtimed.run/p/${id}/`, page(id)],
  [`https://pages.runtimed.run/p/${id}?from=index`, page(id)],
  // Relative and protocol-relative links resolve against the address.
  [`/p/${id}`, page(id)],
  [`/p/${id}#plan`, page(id, "plan")],
  [`//pages.runtimed.run/p/${id}`, page(id)],
  // URL parsing lowercases the scheme and host and drops a default port.
  [`HTTPS://Pages.Runtimed.Run:443/p/${id}`, page(id)],
  [`https://PAGES.RUNTIMED.RUN/p/${id}`, page(id)],
  // Backslashes are slashes in an http(s) URL: the browser follows this one
  // to the same Page.
  [`https:\\\\pages.runtimed.run\\p\\${id}`, page(id)],
  // A slug names the same Page: a pasted link with one is a chip for it.
  [`/p/${id}/My-Dashboard`, page(id)],
  [`/p/${id}/My-Dashboard#goals`, page(id, "goals")],
  [`/p/${id}/My-Dashboard/`, page(id)],
  [`/p/${id}/view`, null],
  [`/p/${id}/My.Dashboard`, null],
  [`/p/${id}/My-Dashboard/more`, null],
  [`/p/${id}/%3Cscript%3E`, null],
  // readPageRoute still reads the legacy address.
  [`https://pages.runtimed.run/?page=${id}`, page(id)],
  // Look-alike hosts, user info and a trailing dot are other origins.
  [`https://pages.runtimed.run.evil.example/p/${id}`, null],
  [`https://pages.runtimed.run@evil.example/p/${id}`, null],
  [`https://evil.example/pages.runtimed.run/p/${id}`, null],
  [`https://pages.runtimed.run./p/${id}`, null],
  // User info on this host: same origin, but nothing in Pages writes it.
  [`https://someone@pages.runtimed.run/p/${id}`, null],
  [`https://someone:secret@pages.runtimed.run/p/${id}`, null],
  // Other deployments, schemes and ports.
  [`https://page2.runtimed.run/p/${id}`, null],
  [`https://page10.runtimed.run/p/${id}`, null],
  [`http://localhost:9894/p/${id}`, null],
  [`http://pages.runtimed.run/p/${id}`, null],
  [`https://pages.runtimed.run:8443/p/${id}`, null],
  // Only the Page route itself: longer paths and malformed IDs are missing.
  [`/p/${id}/meta.json`, null],
  [`/p/${id}/card.json`, null],
  [`https://pages.runtimed.run/p/${id}/meta.json`, null],
  [`/p/${id.toUpperCase()}`, null],
  [`/p/${id}0`, null],
  ["/p/1a160b47-6df1-1983-81eb-489ca5a26812", null],
  ["/p/not-a-page", null],
  [`/p/%32b160b47-6df1-4983-81eb-489ca5a26812`, null],
  [`/api/pages/${id}/assets`, null],
  // Projects and index routes are app routes, but not Pages.
  [`/project/${project}`, null],
  ["/projects", null],
  ["/pages", null],
  ["/", null],
  // Unsafe schemes and malformed text never count (model/marks.mjs safeUrl).
  ["javascript:alert(1)", null],
  ["JaVaScRiPt:alert(1)", null],
  [`javascript:location='/p/${id}'`, null],
  ["data:text/html,<p>hi</p>", null],
  ["vbscript:msgbox(1)", null],
  ["file:///etc/passwd", null],
  ["mailto:someone@example.com", null],
  ["tel:+15555550100", null],
  [` /p/${id}`, null],
  [`/p/${id}\n`, null],
  [`/p/\u0000${id}`, null],
  ["", null],
  [null, null],
  [undefined, null],
  [42, null],
];

test("a link is a Page link only for this deployment's own Page route", () => {
  for (const [href, expected] of ROWS)
    assert.deepEqual(pageLink(href, base), expected, JSON.stringify(href));
});

test("in-place navigation and Page links can never disagree", () => {
  for (const [href] of [...ROWS, [`/project/${project}#intro`], [`/project/${project}`]]) {
    const link = pageLink(href, base);
    const inApp = inAppLink(href, base);
    const route = appRoute(href, base);
    // inAppLink opens exactly the app routes appRoute accepts.
    assert.equal(inApp === null, route === null, JSON.stringify(href));
    if (inApp?.route.kind === "page") {
      assert.deepEqual(link, { pageId: inApp.route.pageId, anchor: inApp.anchor }, String(href));
    } else assert.equal(link, null, JSON.stringify(href));
  }
  assert.equal(inAppLink(`/project/${project}`, base).route.kind, "project");
});

test("each deployment counts only its own origin", () => {
  const local = `http://localhost:9894/p/${here}`;
  assert.deepEqual(pageLink(`http://localhost:9894/p/${id}`, local), page(id));
  assert.deepEqual(pageLink(`/p/${id}`, local), page(id));
  assert.equal(pageLink(`http://127.0.0.1:9894/p/${id}`, local), null);
  assert.equal(pageLink(`https://pages.runtimed.run/p/${id}`, local), null);
  assert.equal(pageLink(`http://localhost:9895/p/${id}`, local), null);
  assert.equal(pageLink(`/p/${id}`, "not a url"), null);
});

test("links to the open Page are section links, not linked Pages", () => {
  assert.deepEqual(linkedPage(`/p/${id}`, base), page(id));
  assert.deepEqual(linkedPage(`/p/${id}#plan`, base), page(id, "plan"));
  assert.equal(linkedPage(`/p/${here}`, base), null);
  assert.equal(linkedPage(`/p/${here}#plan`, base), null);
  // A slug on either side still names the open Page.
  assert.equal(linkedPage(`/p/${here}/Notes`, base), null);
  assert.equal(linkedPage(`/p/${here}`, `${base}/Notes`), null);
  assert.deepEqual(linkedPage(`/p/${id}/Plan#goals`, `${base}/Notes`), page(id, "goals"));
  assert.equal(linkedPage("#plan", base), null);
  assert.equal(linkedPage(`https://pages.runtimed.run/p/${here}`, `${base}#elsewhere`), null);
  // The open Page can be named: a Project's content shows at its Project's
  // route, whose address names no Page.
  const projectBase = `https://pages.runtimed.run/project/${project}`;
  assert.deepEqual(linkedPage(`/p/${here}`, projectBase), page(here));
  assert.equal(linkedPage(`/p/${here}`, projectBase, { currentPageId: here }), null);
  assert.deepEqual(linkedPage(`/p/${id}`, projectBase, { currentPageId: here }), page(id));
  // A Project link is not a Page link.
  assert.equal(linkedPage(`/project/${project}`, base), null);
  // Everything pageLink refuses, linkedPage refuses.
  for (const [href, expected] of ROWS)
    if (expected === null) assert.equal(linkedPage(href, base), null, JSON.stringify(href));
});

const legacy = `sp_${id}`;
const projectAt = (projectId, anchor = null) => ({ kind: "project", projectId, anchor });

// [href, linkTarget's answer against `base`] for Project links. Every link
// that isn't exactly one of this deployment's Project routes is null; a Page
// link is a Page target.
const PROJECT_ROWS = [
  [`/project/${project}`, projectAt(project)],
  [`/project/${project}/`, projectAt(project)],
  [`/project/${project}#guidance`, projectAt(project, "guidance")],
  [`https://pages.runtimed.run/project/${project}`, projectAt(project)],
  [`HTTPS://PAGES.RUNTIMED.RUN:443/project/${project}`, projectAt(project)],
  [`//pages.runtimed.run/project/${project}`, projectAt(project)],
  // Projects minted before the Project name keep their sp_ IDs.
  [`/project/${legacy}`, projectAt(legacy)],
  // The older /s/ route reads as the same Project.
  [`/s/${project}`, projectAt(project)],
  [`/s/${legacy}`, projectAt(legacy)],
  [`https://pages.runtimed.run/s/${legacy}#plan`, projectAt(legacy, "plan")],
  // A Page is a Page.
  [`/p/${id}`, { kind: "page", pageId: id, anchor: null }],
  // Look-alikes and other deployments.
  [`https://pages.runtimed.run.evil.example/project/${project}`, null],
  [`https://pages.runtimed.run@evil.example/project/${project}`, null],
  [`https://pages.runtimed.run./project/${project}`, null],
  [`https://someone@pages.runtimed.run/project/${project}`, null],
  [`https://page2.runtimed.run/project/${project}`, null],
  [`http://localhost:9894/project/${project}`, null],
  [`http://pages.runtimed.run/project/${project}`, null],
  // Only the route itself, with a well-formed ID.
  [`/project/${project}/meta.json`, null],
  [`/project/${project}/card.json`, null],
  [`/s/${project}/meta.json`, null],
  [`/project/${id}`, null],
  [`/project/PRJ_${id}`, null],
  [`/project/prj_${id.toUpperCase()}`, null],
  [`/project/prj_1a160b47-6df1-1983-81eb-489ca5a26812`, null],
  [`/project/xyz_${id}`, null],
  [`/project/prj-${id}`, null],
  [`/project/prj_`, null],
  [`/project/${project}0`, null],
  [`/project/%70rj_${id}`, null],
  [`/projects/${project}`, null],
  ["/projects", null],
  [`javascript:location='/project/${project}'`, null],
  [` /project/${project}`, null],
];

test("a link names a Project only through this deployment's Project route", () => {
  for (const [href, expected] of PROJECT_ROWS)
    assert.deepEqual(linkTarget(href, base), expected, JSON.stringify(href));
  // Every Page row reads the same through linkTarget; the Page table's
  // Project route is a Project target.
  for (const [href, expected] of ROWS) {
    const target = linkTarget(href, base);
    if (target?.kind === "project") assert.equal(href, `/project/${project}`);
    else assert.deepEqual(target, expected && { kind: "page", ...expected }, JSON.stringify(href));
  }
  // pageLink never answers for a Project.
  for (const [href, expected] of PROJECT_ROWS)
    if (expected?.kind === "project") assert.equal(pageLink(href, base), null, href);
});

test("in-place navigation and Project links can never disagree", () => {
  for (const [href] of PROJECT_ROWS) {
    const target = linkTarget(href, base);
    const inApp = inAppLink(href, base);
    assert.equal(inApp === null, target === null, JSON.stringify(href));
    if (inApp?.route.kind === "project")
      assert.deepEqual(target, projectAt(inApp.route.projectId, inApp.anchor), href);
  }
});

test("links to what's open now are dropped: the open Page, and the open Project's own route", () => {
  const pageBase = `https://pages.runtimed.run/p/${here}`;
  const projectBase = `https://pages.runtimed.run/project/${project}`;
  const other = `prj_${here}`;
  // A Project link inside an ordinary Page of that Project still counts:
  // only its content is the Project.
  assert.deepEqual(linkedTarget(`/project/${project}`, pageBase), projectAt(project));
  assert.deepEqual(
    linkedTarget(`/project/${project}`, pageBase, { currentPageId: here }),
    projectAt(project),
  );
  // On the Project's route its content is open: its own links are dropped,
  // by the address or by name, in either route form.
  assert.equal(linkedTarget(`/project/${project}`, projectBase), null);
  assert.equal(linkedTarget(`/s/${project}#plan`, projectBase), null);
  assert.equal(linkedTarget(`/project/${project}`, pageBase, { currentProjectId: project }), null);
  assert.deepEqual(linkedTarget(`/project/${other}`, projectBase), projectAt(other));
  // The open Project names no Page: Pages still need currentPageId.
  assert.deepEqual(linkedTarget(`/p/${here}`, projectBase), {
    kind: "page",
    pageId: here,
    anchor: null,
  });
  assert.equal(linkedTarget(`/p/${here}`, projectBase, { currentPageId: here }), null);
  // A Page ID never matches a Project and the reverse.
  assert.deepEqual(
    linkedTarget(`/project/${project}`, pageBase, { currentPageId: id }),
    projectAt(project),
  );
  assert.deepEqual(linkedTarget(`/p/${id}`, pageBase, { currentProjectId: project }), {
    kind: "page",
    pageId: id,
    anchor: null,
  });
  for (const [href, expected] of PROJECT_ROWS)
    if (expected === null) assert.equal(linkedTarget(href, pageBase), null, JSON.stringify(href));
});

test("a fragment names its anchor, percent-decoded", () => {
  assert.equal(anchorFromHash("#plan"), "plan");
  assert.equal(anchorFromHash("#100%"), "100%");
  assert.equal(anchorFromHash(""), null);
  assert.equal(anchorFromHash(null), null);
});
