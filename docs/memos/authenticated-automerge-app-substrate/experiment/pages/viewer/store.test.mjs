import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import {
  EMPTY,
  Subject,
  defer,
  filter,
  ignoreElements,
  map,
  merge,
  mergeMap,
  switchMap,
  tap,
  timer,
} from "rxjs";
import { TestScheduler } from "rxjs/testing";
import { reconnect } from "../test/example-reconnect.mjs";
import { Store, useStore } from "./store.mjs";

const dom = new JSDOM("<!doctype html><body></body>");
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
// react-dom checks for a DOM when it loads.
const { Suspense, act, createElement, startTransition, use, useLayoutEffect } =
  await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");

function accessEquals(a, b) {
  return a === b || (a.phase === b.phase && a.writable === b.writable);
}
const access = (state) => ({ phase: state.phase, writable: state.writable });

test("select emits the current value synchronously, then only changes", () => {
  const store = new Store({ phase: "opening", count: 0 });
  const phases = [];
  const states = [];
  const subscriptions = [
    store.select((state) => state.phase).subscribe((phase) => phases.push(phase)),
    store.state$.subscribe((state) => states.push(state)),
  ];
  assert.deepEqual(phases, ["opening"]);
  store.update((state) => ({ ...state, count: 1 }));
  store.update((state) => ({ ...state, phase: "open" }));
  assert.equal(
    store.update((state) => state),
    store.snapshot(),
  );
  assert.deepEqual(phases, ["opening", "open"]);
  assert.equal(states.length, 3, "returning the current value emits nothing");
  assert.deepEqual(store.snapshot(), { phase: "open", count: 1 });
  for (const subscription of subscriptions) subscription.unsubscribe();
});

test("a structural comparator dedupes allocated projections", () => {
  const store = new Store({ phase: "open", writable: true, title: "A" });
  const deduped = [];
  const every = [];
  store.select(access, accessEquals).subscribe((value) => deduped.push(value));
  store.select(access).subscribe((value) => every.push(value));
  store.update((state) => ({ ...state, title: "B" }));
  store.update((state) => ({ ...state, writable: false }));
  assert.deepEqual(deduped, [
    { phase: "open", writable: true },
    { phase: "open", writable: false },
  ]);
  assert.equal(every.length, 3);
});

test("an update made by a subscriber reaches every subscriber in order", () => {
  const store = new Store(0);
  const first = [];
  const second = [];
  store.state$.subscribe((value) => {
    first.push(value);
    if (value === 1) {
      store.update(() => 2);
      assert.equal(store.snapshot(), 2);
    }
  });
  store.state$.subscribe((value) => second.push(value));
  store.update(() => 1);
  assert.deepEqual(first, [0, 1, 2]);
  assert.deepEqual(second, [0, 1, 2]);
});

test("useStore renders the current projection and re-renders only when it changes", async (t) => {
  const store = new Store({ phase: "open", writable: true, title: "A" });
  const renders = [];
  function Access({ label }) {
    const value = useStore(store, (state) => ({ ...access(state) }), accessEquals);
    renders.push(value);
    return createElement("output", null, `${label} ${value.phase}:${value.writable}`);
  }
  assert.equal(
    renderToStaticMarkup(createElement(Access, { label: "server" })),
    "<output>server open:true</output>",
  );
  renders.length = 0;

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(() => act(() => root.unmount()));
  await act(() => root.render(createElement(Access, { label: "a" })));
  assert.equal(container.textContent, "a open:true");
  assert.equal(renders.length, 1);

  await act(() => store.update((state) => ({ ...state, title: "B" })));
  assert.equal(renders.length, 1, "an unrelated field does not re-render");

  // A parent render passes a new inline projection; the value keeps its identity.
  await act(() => root.render(createElement(Access, { label: "b" })));
  assert.equal(renders.length, 2);
  assert.equal(renders[1], renders[0]);

  await act(() => store.update((state) => ({ ...state, writable: false })));
  assert.equal(container.textContent, "b open:false");
  assert.equal(renders.length, 3);
});

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

// Renders the selection as JSON and records each committed value.
function Show({ store, project, equals, commits = [] }) {
  const value = useStore(store, project, equals);
  useLayoutEffect(() => {
    commits.push(value);
  });
  return createElement("output", null, JSON.stringify(value));
}

function mount(t) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(() => act(() => root.unmount()));
  return { container, root, render: (props) => act(() => root.render(createElement(Show, props))) };
}

test("useStore re-selects when only the comparator changes", async (t) => {
  const store = new Store({ phase: "open", writable: true });
  const phaseOnly = (a, b) => a.phase === b.phase;
  const { container, render } = mount(t);
  await render({ store, project: access, equals: phaseOnly });
  await act(() => store.update((state) => ({ ...state, writable: false })));
  assert.equal(container.textContent, '{"phase":"open","writable":true}', "phaseOnly holds");
  await render({ store, project: access, equals: accessEquals });
  assert.equal(container.textContent, '{"phase":"open","writable":false}');
});

test("useStore re-selects when the projection changes", async (t) => {
  const store = new Store({ phase: "open", title: "Notes" });
  const { container, render } = mount(t);
  await render({ store, project: (state) => state.phase });
  assert.equal(container.textContent, '"open"');
  await render({ store, project: (state) => state.title });
  assert.equal(container.textContent, '"Notes"');
});

test("useStore follows a new store and drops the old subscription", async (t) => {
  const first = new Store({ phase: "first" });
  const second = new Store({ phase: "second" });
  const commits = [];
  const { container, render } = mount(t);
  const project = (state) => state.phase;
  await render({ store: first, project, commits });
  await render({ store: second, project, commits });
  assert.equal(container.textContent, '"second"');
  assert.equal(commits.length, 2);
  await act(() => first.update(() => ({ phase: "first again" })));
  assert.equal(commits.length, 2, "the old store no longer renders");
  await act(() => second.update(() => ({ phase: "second again" })));
  assert.equal(container.textContent, '"second again"');
  assert.equal(commits.length, 3);
});

test("an abandoned transition render does not disturb the committed selection", async (t) => {
  const store = new Store({ phase: "open", writable: true });
  const phase = (state) => ({ phase: state.phase });
  const both = (state) => ({ phase: state.phase, writable: state.writable });
  const commits = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  function Gate({ wait }) {
    if (wait) use(pending);
    return null;
  }
  const app = (project, wait) =>
    createElement(
      Suspense,
      { fallback: "loading" },
      createElement(Show, { store, project, equals: shallowEqual, commits }),
      createElement(Gate, { wait }),
    );
  const { container, root } = mount(t);
  await act(() => root.render(app(phase, false)));
  assert.equal(commits.length, 1);

  // The transition renders Show with a wider projection, then suspends on
  // Gate. React keeps the committed UI and throws that render away.
  await act(() => startTransition(() => root.render(app(both, true))));
  assert.equal(container.textContent, '{"phase":"open"}');
  assert.equal(commits.length, 1);

  // The committed Show still projects `phase`, which hasn't changed.
  await act(() => store.update((state) => ({ ...state, writable: false })));
  assert.equal(commits.length, 1, "no re-render for an unchanged committed selection");

  await act(async () => {
    release();
    await pending;
  });
  assert.equal(container.textContent, '{"phase":"open","writable":false}');
  assert.equal(commits.length, 2);
});

// Virtual-time pattern for machine interpreters. The interpreter steps the
// machine, keeps its state in a Store, and turns schedule and cancelTimer
// effects into one latest-only timer that feeds a timer event back in. Socket
// events come from the input marbles here; a real interpreter would dial.
function interpret(machine, store, input$) {
  return defer(() => {
    const timers$ = new Subject();
    return merge(input$, timers$).pipe(
      map((event) => machine.step(store.snapshot(), event)),
      tap(({ state }) => store.update(() => state)),
      mergeMap(({ effects }) => effects),
      filter(({ type }) => type === "schedule" || type === "cancelTimer"),
      switchMap((effect) =>
        effect.type === "schedule"
          ? timer(effect.delayMs).pipe(map(() => ({ type: "timer" })))
          : EMPTY,
      ),
      tap((event) => timers$.next(event)),
      ignoreElements(),
    );
  });
}

const PHASES = { a: "idle", b: "connecting", c: "backoff", d: "connecting", e: "open" };
const EVENTS = {
  c: { type: "connect" },
  x: { type: "closed", generation: 1 },
  o: { type: "opened", generation: 2 },
};

test("virtual time: backoff fires its timer and the next socket opens", () => {
  new TestScheduler(assert.deepStrictEqual).run(({ cold, expectObservable }) => {
    const store = new Store(reconnect.initial);
    // connect at 0, the socket closes at 10, the retry's socket opens at 600.
    const input$ = cold("c 9ms x 589ms o", EVENTS);
    const phases$ = store.select((state) => state.name);
    expectObservable(merge(phases$, interpret(reconnect, store, input$))).toBe(
      "(ab) 6ms c 499ms d 89ms e",
      PHASES,
    );
  });
});

test("virtual time: connect during backoff cancels the pending timer", () => {
  new TestScheduler(assert.deepStrictEqual).run(({ cold, expectObservable }) => {
    const store = new Store(reconnect.initial);
    // A timer firing at 510 would step connecting × timer, which throws.
    const input$ = cold("c 9ms x 89ms c", EVENTS);
    const phases$ = store.select((state) => state.name);
    expectObservable(merge(phases$, interpret(reconnect, store, input$))).toBe(
      "(ab) 6ms c 89ms d",
      PHASES,
    );
  });
});
