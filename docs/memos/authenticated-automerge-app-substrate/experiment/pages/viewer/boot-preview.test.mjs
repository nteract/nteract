// The boot-preview table through the pure machine, and BootPreview's
// interpretation of it over the head script's real early request.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { bootPreviewMachine } from "./boot-preview-machine.mjs";
import { BootPreview, isPagePreview, visiblePreview } from "./boot-preview.mjs";
import { EARLY_CONNECT, earlyConnectAnswer, startEarlyConnect } from "./early-session.mjs";

const TABLE = new URL("../test/fixtures/machines/boot-preview.json", import.meta.url);

test("the boot-preview table covers every state × event through the pure machine", async () => {
  assert.deepEqual(await runTable(bootPreviewMachine, loadTable(TABLE)), {
    rows: 38,
    pairs: 25,
    unreachable: 3,
    cases: 18,
  });
});

const PAGE = "5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70";
const OTHER = "6a1d5b6f-7d2f-4c1f-8b9a-1e1e5d6f7a81";
const preview = {
  title: "Private plan",
  blocks: [{ id: "b1", content: [["p", {}, "Only Alice can read this."]] }],
  truncated: false,
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}

/** A tab on /p/PAGE whose head script's discovery waits on `response`. */
function tab(response = deferred()) {
  const target = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener: (type, fn) =>
        listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
      removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
      dispatch: (type, event = {}) => {
        for (const fn of Array.from(listeners.get(type) ?? [])) fn(event);
      },
    };
  };
  const signals = [];
  const win = {
    location: { href: `https://pages.example/p/${PAGE}` },
    document: { visibilityState: "hidden", ...target() },
    ...target(),
    fetch: (_url, init) => {
      signals.push(init.signal);
      return response.promise;
    },
  };
  startEarlyConnect(win);
  const boot = new BootPreview();
  boot.start(PAGE, earlyConnectAnswer(PAGE, win));
  return { win, boot, response, signals, state: () => boot.store.snapshot() };
}
const answer = (principal, body = {}) =>
  Response.json({
    identity: { principal, displayName: principal },
    access: { canRead: true },
    preview,
    ...body,
  });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const shownTo = (t, principal, pageId = PAGE) => visiblePreview(t.state(), { pageId, principal });

test("the preview shows only once the session and the host agree on the account", async () => {
  const t = tab();
  assert.equal(t.state().name, "pending");
  t.response.resolve(answer("alice"));
  await flush();
  assert.deepEqual(t.state().answer, { principal: "alice", preview });
  assert.equal(shownTo(t, "alice"), null, "no session answer yet");
  t.boot.dispatch({ type: "session", principal: "alice" });
  assert.deepEqual(shownTo(t, "alice"), preview);
  // The shell's own check: another account or route never sees it.
  assert.equal(shownTo(t, "bob"), null);
  assert.equal(shownTo(t, undefined), null);
  assert.equal(shownTo(t, "alice", OTHER), null);
});

test("an account change before the preview resolves retires it, and the late answer is ignored", async () => {
  const t = tab();
  t.boot.dispatch({ type: "session", principal: "alice" });
  // Another tab signs in as Bob; this tab's session check sees it first.
  t.boot.dispatch({ type: "session", principal: "bob" });
  assert.deepEqual(t.state(), { name: "retired", reason: "principal-changed" });
  t.response.resolve(answer("alice"));
  await flush();
  assert.deepEqual(t.state(), { name: "retired", reason: "principal-changed" });
  assert.equal(shownTo(t, "alice"), null);
  assert.equal(shownTo(t, "bob"), null);
});

test("a preview the host answered for another account than the session never shows", async () => {
  // The cookie switched to Bob between the head script's two requests.
  const t = tab();
  t.boot.dispatch({ type: "session", principal: "bob" });
  t.response.resolve(answer("alice"));
  await flush();
  assert.deepEqual(t.state(), { name: "retired", reason: "principal-mismatch" });
  // And in the other order.
  const u = tab();
  u.response.resolve(answer("alice"));
  await flush();
  u.boot.dispatch({ type: "session", principal: "bob" });
  assert.deepEqual(u.state(), { name: "retired", reason: "principal-mismatch" });
  assert.equal(shownTo(u, "bob"), null);
});

test("an account change or sign-out after the preview resolves retires it for good", async () => {
  for (const [next, reason] of [
    ["bob", "principal-changed"],
    [null, "signed-out"],
  ]) {
    const t = tab();
    t.response.resolve(answer("alice"));
    await flush();
    t.boot.dispatch({ type: "session", principal: "alice" });
    assert.equal(t.state().name, "shown");
    t.boot.dispatch({ type: "session", principal: next });
    assert.deepEqual(t.state(), { name: "retired", reason });
    // Switching back doesn't bring it back.
    t.boot.dispatch({ type: "session", principal: "alice" });
    assert.equal(shownTo(t, "alice"), null);
  }
});

test("an answer completing after the live Page installed is ignored", async () => {
  const t = tab();
  t.boot.dispatch({ type: "session", principal: "alice" });
  t.boot.dispatch({ type: "installed" });
  assert.deepEqual(t.state(), { name: "retired", reason: "installed" });
  t.response.resolve(answer("alice"));
  await flush();
  assert.deepEqual(t.state(), { name: "retired", reason: "installed" });
  assert.equal(shownTo(t, "alice"), null);
});

test("navigating away and back leaves the preview retired", async () => {
  const t = tab();
  t.response.resolve(answer("alice"));
  await flush();
  t.boot.dispatch({ type: "session", principal: "alice" });
  // Rewriting the same Page's address is not leaving it.
  assert.equal(t.boot.dispatch({ type: "navigated", pageId: PAGE }), false);
  assert.equal(t.state().name, "shown");
  t.boot.dispatch({ type: "navigated", pageId: null });
  t.boot.dispatch({ type: "navigated", pageId: PAGE });
  assert.deepEqual(t.state(), { name: "retired", reason: "navigated" });
  assert.equal(shownTo(t, "alice"), null);
  // Away before the answer arrives: same.
  const u = tab();
  u.boot.dispatch({ type: "session", principal: "alice" });
  u.boot.dispatch({ type: "navigated", pageId: OTHER });
  u.boot.dispatch({ type: "navigated", pageId: PAGE });
  u.response.resolve(answer("alice"));
  await flush();
  assert.deepEqual(u.state(), { name: "retired", reason: "navigated" });
});

test("the tab dropping the early request retires the preview, shown or not", async () => {
  for (const shown of [false, true]) {
    const t = tab();
    if (shown) {
      t.response.resolve(answer("alice"));
      await flush();
      t.boot.dispatch({ type: "session", principal: "alice" });
      assert.equal(t.state().name, "shown");
    }
    t.win.document.visibilityState = "visible";
    t.win.document.dispatch("visibilitychange");
    assert.deepEqual(t.state(), { name: "retired", reason: "invalidated" });
    assert.equal(t.signals[0].aborted, true);
  }
  const t = tab();
  t.win.dispatch("pageshow", { persisted: true });
  assert.deepEqual(t.state(), { name: "retired", reason: "invalidated" });
});

test("retirement releases the invalidation listener", async () => {
  const t = tab();
  assert.equal(t.win[EARLY_CONNECT].dropped.size, 1);
  t.boot.dispatch({ type: "installed" });
  assert.equal(t.win[EARLY_CONNECT].dropped.size, 0);
  // A later drop finds nothing to tell and changes nothing.
  t.win.document.visibilityState = "visible";
  t.win.document.dispatch("visibilitychange");
  assert.deepEqual(t.state(), { name: "retired", reason: "installed" });
});

test("refusals, hidden Pages and broken answers retire without showing", async () => {
  for (const response of [
    Response.json({ error: "No access", code: "page_access_denied" }, { status: 403 }),
    Response.json({ error: "Sign in" }, { status: 401 }),
    answer("alice", { trash: { trashed_at: 1 } }),
    answer("alice", { access: { canRead: false } }),
    answer("alice", { preview: { title: "x", blocks: [{ id: 1 }] } }),
    answer("alice", { identity: {} }),
  ]) {
    const t = tab();
    t.boot.dispatch({ type: "session", principal: "alice" });
    t.response.resolve(response);
    await flush();
    assert.deepEqual(t.state(), { name: "retired", reason: "refused" });
  }
  const t = tab();
  t.response.reject(new TypeError("Failed to fetch"));
  await flush();
  assert.deepEqual(t.state(), { name: "retired", reason: "refused" });
  // No early request for this Page: nothing to show.
  const boot = new BootPreview();
  boot.start(PAGE, null);
  assert.deepEqual(boot.store.snapshot(), { name: "retired", reason: "refused" });
});

test("a failed open retires a shown preview", async () => {
  const t = tab();
  t.response.resolve(answer("alice"));
  await flush();
  t.boot.dispatch({ type: "session", principal: "alice" });
  t.boot.dispatch({ type: "refused" });
  assert.deepEqual(t.state(), { name: "retired", reason: "refused" });
});

test("only the projection's shape counts as a preview", () => {
  assert.equal(isPagePreview(preview), true);
  for (const bad of [
    null,
    "x",
    { title: 1, blocks: [] },
    { title: "x" },
    { title: "x", blocks: [{ id: 1, content: [] }] },
  ])
    assert.equal(isPagePreview(bad), false);
});
