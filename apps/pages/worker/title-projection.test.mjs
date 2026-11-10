import assert from "node:assert/strict";
import test from "node:test";
import { titleProjection, TITLE_STORE_RETRY_MS } from "./title-projection.mjs";

const now = Date.parse("2026-11-05T00:00:00Z");
const project = (state, title = "A", extra = {}) =>
  titleProjection(state, { type: "project", title, now, ...extra });
const finish = (state, effect, ok = true) =>
  titleProjection(state, { ...effect, type: `${effect.type}Finished`, ok });
const effect = (result, type) => result.effects.find((item) => item.type === type);

test("new observations mark before storing, but deliver independently", () => {
  const started = project();
  assert.equal(started.state.name, "pending");
  assert.deepEqual(
    started.effects.map((item) => item.type),
    ["mark", "deliver"],
  );
  assert.deepEqual(started.state.record, {
    title: "A",
    observed_at: new Date(now).toISOString(),
    keep: true,
  });
  const marked = finish(started.state, effect(started, "mark"));
  assert.equal(marked.state.storage.name, "storing");
  assert.deepEqual(
    marked.effects.map((item) => item.type),
    ["store"],
  );
  const stored = finish(marked.state, effect(marked, "store"));
  assert.equal(stored.state.storage.name, "stored");
  assert.deepEqual(stored.effects, []);
  const delivered = finish(stored.state, effect(started, "deliver"));
  assert.equal(delivered.state.name, "clearing");
  const settled = finish(delivered.state, effect(delivered, "clear"));
  assert.equal(settled.state.name, "settled");
  assert.deepEqual(project(settled.state).effects, []);
});

for (const failure of ["mark", "store"]) {
  test(`${failure} failure retries storage alone at the request-driven boundary`, () => {
    const started = project();
    const storing = failure === "store" ? finish(started.state, effect(started, "mark")) : started;
    const failed = finish(storing.state, effect(storing, failure), false);
    const delivered = finish(failed.state, effect(started, "deliver"));
    assert.equal(delivered.state.storage.name, "retry");
    assert.equal(delivered.state.delivery.name, "delivered");
    assert.deepEqual(delivered.effects, []);
    assert.deepEqual(
      project(delivered.state, "A", { now: now + TITLE_STORE_RETRY_MS - 1 }).effects,
      [],
    );
    const retry = project(delivered.state, "A", { now: now + TITLE_STORE_RETRY_MS });
    assert.deepEqual(
      retry.effects.map((item) => item.type),
      ["mark"],
    );
    assert.equal(retry.state.record, started.state.record);
    assert.deepEqual(project(retry.state, "A", { now: now + TITLE_STORE_RETRY_MS }).effects, []);
    const marked = finish(retry.state, effect(retry, "mark"));
    const stored = finish(marked.state, effect(marked, "store"));
    assert.equal(stored.state.name, "clearing");
    assert.equal(finish(stored.state, effect(stored, "clear")).state.name, "settled");
  });
}

test("delivery failure retries delivery without rewriting the stored observation", () => {
  const started = project();
  const marked = finish(started.state, effect(started, "mark"));
  const stored = finish(marked.state, effect(marked, "store"));
  const failed = finish(stored.state, effect(started, "deliver"), false);
  assert.equal(failed.state.delivery.name, "needed");
  const retry = project(failed.state);
  assert.deepEqual(
    retry.effects.map((item) => item.type),
    ["deliver"],
  );
  assert.equal(retry.state.record, started.state.record);
  assert.equal(finish(retry.state, effect(started, "deliver")).state, retry.state);
});

test("storage retry during delivery waits for that delivery before clearing", () => {
  const started = project();
  const failed = finish(started.state, effect(started, "mark"), false);
  const retry = project(failed.state, "A", { now: now + TITLE_STORE_RETRY_MS });
  const marked = finish(retry.state, effect(retry, "mark"));
  const stored = finish(marked.state, effect(marked, "store"));
  assert.deepEqual(stored.effects, []);
  const delivered = finish(stored.state, effect(started, "deliver"));
  assert.deepEqual(
    delivered.effects.map((item) => item.type),
    ["clear"],
  );
});

test("both failed lanes retry independently without observing the title again", () => {
  const started = project();
  const failedStore = finish(started.state, effect(started, "mark"), false);
  const failedBoth = finish(failedStore.state, effect(started, "deliver"), false);
  const retry = project(failedBoth.state);
  assert.deepEqual(
    retry.effects.map((item) => item.type),
    ["deliver"],
  );
  assert.equal(retry.state.record, started.state.record);
  const storedLater = project(retry.state, "A", { now: now + TITLE_STORE_RETRY_MS });
  assert.deepEqual(
    storedLater.effects.map((item) => item.type),
    ["mark"],
  );
});

test("stored observations retain legacy keep semantics; forced same-title observations do not", () => {
  for (const keep of [undefined, true, false]) {
    const record = {
      title: "A",
      observed_at: new Date(now - 1000).toISOString(),
      ...(keep !== undefined && { keep }),
    };
    const restored = titleProjection(undefined, { type: "restore", record });
    assert.equal(restored.state.storage.name, "stored");
    const started = project(restored.state);
    assert.deepEqual(
      started.effects.map((item) => item.type),
      ["deliver"],
    );
    assert.equal(started.state.record, record);
    const forced = project(started.state, "A", { observe: true });
    assert.equal(forced.state.record.keep, false);
    assert.notEqual(forced.state.record, record);
    assert.equal(forced.state.record.observed_at, new Date(now).toISOString());
    assert.deepEqual(
      forced.effects.map((item) => item.type),
      ["mark", "deliver"],
    );
    assert.equal(titleProjection(forced.state, { type: "restore", record }).state, forced.state);
  }
});

test("an index observation stores but does not claim Catalog delivery", () => {
  const observed = titleProjection(undefined, { type: "observe", title: "A", now });
  assert.deepEqual(
    observed.effects.map((item) => item.type),
    ["mark"],
  );
  assert.equal(observed.state.delivery.name, "needed");
  const sending = project(observed.state);
  assert.deepEqual(
    sending.effects.map((item) => item.type),
    ["deliver"],
  );
  assert.deepEqual(project(sending.state).effects, []);
});

test("late completions cannot alter newer A -> B -> A observations", () => {
  const a = project();
  const marked = finish(a.state, effect(a, "mark"));
  const stored = finish(marked.state, effect(marked, "store"));
  const clearing = finish(stored.state, effect(a, "deliver"));
  const b = project(clearing.state, "B");
  const newest = project(b.state, "A");
  for (const old of [...a.effects, ...marked.effects, ...clearing.effects, ...b.effects]) {
    for (const ok of [false, true]) {
      const result = finish(newest.state, old, ok);
      assert.equal(result.state, newest.state, old.type);
      assert.deepEqual(result.effects, []);
    }
  }
});

test("clear failure retries only the clear; duplicate and unowned completions are ignored", () => {
  const started = project();
  const marked = finish(started.state, effect(started, "mark"));
  const stored = finish(marked.state, effect(marked, "store"));
  const clearing = finish(stored.state, effect(started, "deliver"));
  const failed = finish(clearing.state, effect(clearing, "clear"), false);
  const retry = project(failed.state);
  assert.deepEqual(
    retry.effects.map((item) => item.type),
    ["clear"],
  );
  const settled = finish(retry.state, effect(retry, "clear"));
  for (const state of [
    undefined,
    started.state,
    marked.state,
    stored.state,
    clearing.state,
    failed.state,
    settled.state,
  ]) {
    for (const type of ["mark", "store", "deliver", "clear"]) {
      const result = titleProjection(state, { type: `${type}Finished`, token: {}, ok: true });
      assert.deepEqual(result.effects, []);
      assert.equal(result.state.name, state?.name ?? "empty");
    }
  }
});
