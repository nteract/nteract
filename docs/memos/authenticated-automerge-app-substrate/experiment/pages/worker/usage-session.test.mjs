import assert from "node:assert/strict";
import { test } from "node:test";
import { Subject, VirtualTimeScheduler } from "rxjs";
import { BrowserWrites, READER_MS, UsageSession, usageSessionStep } from "./usage-session.mjs";

const start = Date.parse("2026-11-04T12:00:00Z");
const identity = { principal: "user:one", driver: "Browser" };
const pageId = "44444444-4444-4444-8444-444444444444";

test("session transition table covers every state/event pair", () => {
  const waiting = { name: "waiting" };
  const open = usageSessionStep(waiting, { type: "admit", now: start }).state;
  const closed = { name: "closed" };
  const expected = {
    waiting: { admit: "open", tick: "waiting", close: "closed" },
    open: { admit: "open", tick: "open", close: "closed" },
    closed: { admit: "closed", tick: "closed", close: "closed" },
  };
  for (const state of [waiting, open, closed])
    for (const type of ["admit", "tick", "close"]) {
      const result = usageSessionStep(state, { type, now: start + READER_MS });
      assert.equal(result.state.name, expected[state.name][type], `${state.name}/${type}`);
      assert.equal(result.visits.length, state.name === "open" && type !== "admit" ? 1 : 0);
    }
});

test("read threshold is inclusive, read-only idle sessions qualify, reconnect sessions do not count opens", () => {
  const opened = usageSessionStep({ name: "waiting" }, { type: "admit", now: start }).state;
  assert.deepEqual(
    usageSessionStep(opened, { type: "close", now: start + READER_MS - 1 }).visits,
    [],
  );
  const qualified = usageSessionStep(opened, { type: "tick", now: start + READER_MS });
  assert.deepEqual(qualified.visits, [start + READER_MS]);
  assert.deepEqual(
    usageSessionStep(qualified.state, { type: "tick", now: start + 125_000 }).visits,
    [],
  );
  assert.deepEqual(usageSessionStep(qualified.state, { type: "tick", now: start }).visits, []);
  assert.deepEqual(
    usageSessionStep(qualified.state, { type: "close", now: start + 125_000 }).visits,
    [],
  );
});

test("sessions qualify on total length, attributing the 30-second mark to its UTC day", () => {
  const midnight = Date.parse("2026-11-05T00:00:00Z");
  for (const before of [15_000, 29_999, 30_000, 30_001]) {
    const openedAt = midnight - before;
    const state = usageSessionStep({ name: "waiting" }, { type: "admit", now: openedAt }).state;
    assert.deepEqual(
      usageSessionStep(state, { type: "close", now: openedAt + READER_MS - 1 }).visits,
      [],
    );
    const first = usageSessionStep(state, { type: "tick", now: openedAt + READER_MS });
    assert.deepEqual(first.visits, [openedAt + READER_MS]);
    assert.equal(
      new Date(first.visits[0]).toISOString().slice(0, 10),
      before > READER_MS ? "2026-11-04" : "2026-11-05",
    );
    assert.deepEqual(usageSessionStep(first.state, { type: "tick", now: openedAt }).visits, []);
  }
  const opened = usageSessionStep(
    { name: "waiting" },
    { type: "admit", now: midnight - 15_000 },
  ).state;
  assert.deepEqual(usageSessionStep(opened, { type: "close", now: midnight + 20_000 }).visits, [
    midnight + 15_000,
  ]);
});

test("qualified long-lived sessions count once on each following UTC day", () => {
  const day = 86_400_000;
  const opened = usageSessionStep({ name: "waiting" }, { type: "admit", now: start }).state;
  const first = usageSessionStep(opened, { type: "tick", now: start + READER_MS });
  const midnight = Date.parse("2026-11-05T00:00:00Z");
  assert.deepEqual(usageSessionStep(first.state, { type: "tick", now: midnight - 1 }).visits, []);
  const next = usageSessionStep(first.state, { type: "tick", now: midnight });
  assert.deepEqual(next.visits, [midnight]);
  assert.deepEqual(
    usageSessionStep(next.state, { type: "tick", now: midnight + 30_000 }).visits,
    [],
  );
  assert.deepEqual(
    usageSessionStep(next.state, { type: "close", now: midnight + 2 * day }).visits,
    [midnight + day, midnight + 2 * day],
  );
});

test("virtual-time resident session records owner visits, non-owner reads, and excludes agents", async () => {
  for (const [driver, owner, action] of [
    ["Browser", "user:other", "page.read"],
    ["Browser", identity.principal, "page.visit"],
    ["Kilo", "user:other", undefined],
  ]) {
    const scheduler = new VirtualTimeScheduler();
    const disconnected = new Subject();
    const events = [];
    const session = new UsageSession({
      identity: { ...identity, driver },
      pageId,
      owner,
      scheduler,
      now: () => start + scheduler.now(),
      emit: (event) => events.push(event),
    });
    session.event("admit");
    const held = session.serve(disconnected);
    scheduler.schedule(() => disconnected.next(), 125_000);
    scheduler.flush();
    await held;
    assert.deepEqual(
      events.map((event) => event.action),
      action ? [action] : [],
    );
    assert.equal(session.state.name, "closed");
  }
});

test("browser writes dedupe per session/action/day and never count an agent or unknown document", () => {
  let now = start;
  const events = [];
  const writes = new BrowserWrites({ now: () => now, emit: (event) => events.push(event) });
  const session = {};
  for (let n = 0; n < 100; n++) writes.admitted(session, identity, "page", pageId);
  writes.admitted(session, identity, "comments", pageId);
  writes.admitted(session, identity, "comments", pageId);
  writes.admitted({}, { ...identity, driver: "Kilo" }, "page", pageId);
  writes.admitted(undefined, identity, "page", pageId);
  writes.admitted(session, identity, "other", pageId);
  assert.deepEqual(
    events.map((event) => event.action),
    ["page.write", "comment.write"],
  );
  now = Date.parse("2026-11-05T00:00:00Z");
  writes.admitted(session, identity, "page", pageId);
  writes.admitted({}, identity, "page", pageId);
  assert.equal(events.length, 4, "a reconnect may emit; the daily rollup unions it");
});
