import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { sourceLine, sourceLineClock, sourceTime } from "./source-line.mjs";

const now = Date.parse("2026-11-14T17:00:00Z");
const options = { locale: "en-US", timeZone: "America/Los_Angeles" };
const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour;
const source = (id, name, revision, set_at) => ({ source_id: id, name, revision, set_at });

test("zero sources has no line; sources without consumers still appear", () => {
  assert.equal(sourceLine({}, now), null);
  const result = sourceLine(
    { usage: source("usage", "Usage", "1", new Date(now).toISOString()) },
    now,
    options,
  );
  assert.equal(result.count, 1);
  assert.equal(result.entries[0].action, "added");
  assert.equal(result.entries[0].time.label, "just now");
});

test("the host's first set is added; every later set is refreshed, even for the same asset", () => {
  const first = source("usage", "Usage", "1", "2026-11-02T17:00:00Z");
  const second = { ...first, revision: "2", set_at: "2026-11-14T15:00:00Z" };
  assert.equal(sourceLine({ usage: first }, now, options).entries[0].action, "added");
  const entry = sourceLine({ usage: second }, now, options).entries[0];
  assert.equal(entry.action, "refreshed");
  assert.equal(entry.time.label, "2 hours ago");
});

test("names order entries while dates summarize all sources without calling additions refreshes", () => {
  const sources = {
    usage: source("usage", "Usage", "5", "2026-11-14T15:00:00Z"),
    targets: source("targets", "Targets", "1", "2026-11-02T17:00:00Z"),
    sales: source("sales", "Sales", "2", "2026-11-13T17:00:00Z"),
  };
  const first = sourceLine(sources, now, options);
  assert.deepEqual(
    first.entries.map((item) => item.name),
    ["Sales", "Targets", "Usage"],
  );
  assert.equal(first.newest.id, "usage");
  assert.equal(first.oldest.id, "targets");
  assert.equal(first.oldest.action, "added");
  const refreshed = sourceLine(
    { ...sources, sales: { ...sources.sales, revision: "3", set_at: new Date(now).toISOString() } },
    now,
    options,
  );
  assert.deepEqual(
    refreshed.entries.map((item) => item.id),
    first.entries.map((item) => item.id),
  );
  assert.equal(refreshed.newest.id, "sales");
  for (let i = 0; i < 61; i++)
    sources[`extra_${i}`] = source(`extra_${i}`, `Extra ${i}`, "1", "2026-10-02T17:00:00Z");
  const many = sourceLine(sources, now, options);
  assert.equal(many.count, 64);
  assert.deepEqual(many.entries, []);
  assert.equal(many.oldest.time.label, "Oct 2");
  assert.equal(many.newest.time.label, "2 hours ago");
});

test("relative ages cross minute/hour/day/seven-day boundaries and tolerate clock skew", () => {
  for (const [elapsed, label] of [
    [-hour, "just now"],
    [59_999, "just now"],
    [minute, "1 minute ago"],
    [hour, "1 hour ago"],
    [day, "1 day ago"],
    [2 * day, "2 days ago"],
    [7 * day, "Nov 7"],
  ])
    assert.equal(sourceTime(now - elapsed, now, options).label, label);
  assert.equal(sourceTime("broken", now, options).dateTime, null);
});

test("calendar dates and full timestamps use the reader's zone, including the year boundary", () => {
  const time = sourceTime("2026-01-01T01:00:00Z", now, options);
  assert.equal(time.label, "Dec 31, 2025");
  assert.equal(time.dateTime, "2026-01-01T01:00:00.000Z");
  assert.match(time.exact.replace(/\s/g, " "), /Dec 31, 2025, 5:00:00 PM PST/);
});

test("the presentation clock starts on subscribe and cancels on unsubscribe", () => {
  const scheduler = new VirtualTimeScheduler(undefined, 2 * minute);
  const clock = sourceLineClock({ scheduler, now: () => scheduler.now() });
  assert.equal(scheduler.actions.length, 0);
  const seen = [];
  const subscription = clock.subscribe((value) => seen.push(value));
  scheduler.flush();
  assert.deepEqual(seen, [0, minute, 2 * minute]);
  subscription.unsubscribe();
  assert.equal(scheduler.actions.length, 0);
});

// Elapsed-day labels must not claim a calendar day across midnight.
test("a source spanning two local midnights still describes elapsed days", () => {
  const label = sourceTime(
    "2026-11-09T09:00:00Z",
    Date.parse("2026-11-11T08:30:00Z"),
    options,
  ).label;
  assert.equal(label, "1 day ago");
});
