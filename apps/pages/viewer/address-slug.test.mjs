import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import {
  ADDRESS_SLUG_DEBOUNCE_MS,
  addressSlugPath,
  followTitleInAddress,
  sessionTitle,
} from "./address-slug.mjs";

const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
const other = "2b160b47-6df1-4983-81eb-489ca5a26812";
const at = (path) => `https://pages.example${path}`;

test("the address takes the title's slug for the Page it shows, and nothing else", () => {
  assert.equal(addressSlugPath(at(`/p/${id}`), id, "Quarterly plan"), `/p/${id}/Quarterly-plan`);
  // The fragment and search stay.
  assert.equal(
    addressSlugPath(at(`/p/${id}?x=1#goals`), id, "Quarterly plan"),
    `/p/${id}/Quarterly-plan?x=1#goals`,
  );
  // A different slug, from a link or an older title, is replaced.
  assert.equal(
    addressSlugPath(at(`/p/${id}/Old-name#goals`), id, "New name"),
    `/p/${id}/New-name#goals`,
  );
  assert.equal(addressSlugPath(at(`/p/${id}/`), id, "Plan"), `/p/${id}/Plan`);
  // Already right: nothing to write.
  assert.equal(addressSlugPath(at(`/p/${id}/Quarterly-plan#goals`), id, "Quarterly plan"), null);
  // A title with no slug leaves the address, and any slug it came with, alone.
  for (const title of ["", "日本語", "view", "🚀"]) {
    assert.equal(addressSlugPath(at(`/p/${id}`), id, title), null, title);
    assert.equal(addressSlugPath(at(`/p/${id}/From-a-link`), id, title), null, title);
  }
  // Another Page, a Project, the library, a legacy link or a broken route.
  assert.equal(addressSlugPath(at(`/p/${other}`), id, "Plan"), null);
  assert.equal(addressSlugPath(at(`/project/prj_${id}`), id, "Plan"), null);
  assert.equal(addressSlugPath(at("/pages"), id, "Plan"), null);
  assert.equal(addressSlugPath(at(`/?page=${id}`), id, "Plan"), null);
  assert.equal(addressSlugPath(at(`/p/${id}/a.b`), id, "Plan"), null);
  assert.equal(addressSlugPath(at(`/p/${id}`), null, "Plan"), null);
  assert.equal(addressSlugPath(undefined, id, "Plan"), null);
});

test("a session's title is read only while it shows its Page", () => {
  assert.equal(sessionTitle(null), null);
  assert.equal(sessionTitle({ doc: undefined }), null);
  assert.equal(sessionTitle({ doc: { title: "Plan" }, hidden: true }), null);
  assert.equal(sessionTitle({ doc: { title: "Plan" }, hidden: false }), "Plan");
  assert.equal(sessionTitle({ doc: { title: "" }, hidden: false }), "");
});

/** Move `scheduler`'s clock forward `ms`, running what falls due. A no-op at
 * the target time moves the clock there, so timers armed after this start
 * from it. */
function advance(scheduler, ms) {
  scheduler.schedule(() => {}, ms);
  scheduler.maxFrames = scheduler.frame + ms;
  scheduler.flush();
}

/** A browser's address and history, recording each replaceState. */
function browser(path) {
  const writes = [];
  const location = { href: at(path) };
  const history = {
    state: { pageId: id, scroll: { path: `/p/${id}`, y: 120 } },
    replaceState(state, _unused, next) {
      writes.push({ state, path: next });
      this.state = state;
      location.href = new URL(next, location.href).href;
    },
  };
  return { writes, location, history };
}

/** A PageSession's surface: `pageId`, `doc`, `hidden`, `subscribe`. */
function session(title, { pageId = id } = {}) {
  const listeners = new Set();
  return {
    pageId,
    hidden: false,
    doc: title === undefined ? undefined : { title },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    retitle(next) {
      this.doc = { title: next };
      for (const fn of listeners) fn();
    },
    emit() {
      for (const fn of listeners) fn();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

test("the address follows the title once typing pauses, in place", () => {
  const scheduler = new VirtualTimeScheduler();
  const { writes, location, history } = browser(`/p/${id}#goals`);
  const page = session("Plan");
  const stop = followTitleInAddress(page, { history, location, scheduler });
  // Typing: a title change per keystroke, each within the quiet time.
  for (const title of ["Plan ", "Plan A", "Plan AB"]) {
    advance(scheduler, ADDRESS_SLUG_DEBOUNCE_MS / 2);
    page.retitle(title);
  }
  // Other changes to the Page repeat the same title: they restart nothing.
  advance(scheduler, ADDRESS_SLUG_DEBOUNCE_MS / 2);
  page.emit();
  advance(scheduler, ADDRESS_SLUG_DEBOUNCE_MS / 2 - 1);
  assert.deepEqual(writes, []);
  advance(scheduler, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `/p/${id}/Plan-AB#goals`);
  // The entry's state, scroll position included, is kept.
  assert.deepEqual(writes[0].state, { pageId: id, scroll: { path: `/p/${id}`, y: 120 } });
  // A rename from someone else follows the same way.
  page.retitle("Annual review");
  advance(scheduler, ADDRESS_SLUG_DEBOUNCE_MS);
  assert.deepEqual(
    writes.map((write) => write.path),
    [`/p/${id}/Plan-AB#goals`, `/p/${id}/Annual-review#goals`],
  );
  // A title with no slug leaves the address as it is.
  page.retitle("日本語");
  advance(scheduler, ADDRESS_SLUG_DEBOUNCE_MS);
  assert.equal(writes.length, 2);
  stop();
  assert.equal(page.listeners, 0);
});

test("nothing is written before the title is known, or after the session stops", () => {
  const scheduler = new VirtualTimeScheduler();
  const { writes, location, history } = browser(`/p/${id}`);
  const page = session(undefined);
  const stop = followTitleInAddress(page, { history, location, scheduler });
  scheduler.flush();
  assert.deepEqual(writes, []);
  page.retitle("Plan");
  stop();
  scheduler.flush();
  assert.deepEqual(writes, []);
  // A hidden Page writes nothing either.
  const hidden = session("Plan");
  hidden.hidden = true;
  const stopHidden = followTitleInAddress(hidden, { history, location, scheduler });
  scheduler.flush();
  assert.deepEqual(writes, []);
  stopHidden();
});

test("an address already showing the slug, or showing something else, is left alone", () => {
  const scheduler = new VirtualTimeScheduler();
  const slugged = browser(`/p/${id}/Plan`);
  const stopSlugged = followTitleInAddress(session("Plan"), { ...slugged, scheduler });
  scheduler.flush();
  assert.deepEqual(slugged.writes, []);
  stopSlugged();
  // Project content: the address names the Project, not its document.
  const project = browser(`/project/prj_${id}`);
  const stopProject = followTitleInAddress(session("Plan"), { ...project, scheduler });
  scheduler.flush();
  assert.deepEqual(project.writes, []);
  stopProject();
  // The address moved on to another Page before the quiet time ended.
  const moved = browser(`/p/${id}`);
  const page = session("Plan");
  const stopMoved = followTitleInAddress(page, { ...moved, scheduler });
  moved.location.href = at(`/p/${other}`);
  scheduler.flush();
  assert.deepEqual(moved.writes, []);
  stopMoved();
});
