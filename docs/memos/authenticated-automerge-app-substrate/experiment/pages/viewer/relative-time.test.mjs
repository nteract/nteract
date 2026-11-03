import assert from "node:assert/strict";
import test from "node:test";
import { compactAge, NO_TIME, timeCell, toDate } from "./relative-time.mjs";

const now = Date.parse("2026-11-03T18:00:00.000Z");
const ago = (ms) => new Date(now - ms).toISOString();
const s = 1000,
  m = 60 * s,
  h = 60 * m,
  d = 24 * h;

test("each unit starts at its boundary and holds until the next", () => {
  for (const [elapsed, label] of [
    [0, "now"],
    [59 * s, "now"],
    [m, "1m"],
    [59 * m + 59 * s, "59m"],
    [h, "1h"],
    [23 * h + 59 * m, "23h"],
    [d, "1d"],
    [2 * d, "2d"],
    [6 * d + 23 * h, "6d"],
    [7 * d, "1w"],
    [13 * d, "1w"],
    [14 * d, "2w"],
    [21 * d, "3w"],
    [29 * d + 23 * h, "4w"],
    [30 * d, "1mo"],
    [61 * d, "2mo"],
    [364 * d, "11mo"],
    [365 * d, "1y"],
    [800 * d, "2y"],
  ])
    assert.equal(compactAge(ago(elapsed), now), label, `${elapsed}ms ago`);
});

test("a time after now, from clock skew, is now", () => {
  assert.equal(compactAge(ago(-5 * s), now), "now");
  assert.equal(compactAge(ago(-3 * d), now), "now");
});

test("a missing or unreadable time shows a dash", () => {
  for (const value of [undefined, null, "", "yesterday", "2026-13-45", Number.NaN])
    assert.equal(compactAge(value, now), NO_TIME, String(value));
  assert.equal(NO_TIME, "—");
  assert.equal(compactAge(ago(h), "not a clock"), NO_TIME);
});

test("dates, epoch milliseconds and ISO strings all read", () => {
  assert.equal(compactAge(new Date(now - 3 * h), now), "3h");
  assert.equal(compactAge(now - 5 * m, new Date(now)), "5m");
  assert.equal(toDate("2026-11-03T18:00:00Z").getTime(), now);
  assert.equal(toDate("nope"), null);
});

test("a time cell carries the label, the ISO instant and a local tooltip", () => {
  const cell = timeCell(ago(2 * d), now, "en-US");
  assert.equal(cell.label, "2d");
  assert.equal(cell.dateTime, "2026-11-01T18:00:00.000Z");
  assert.equal(typeof cell.title, "string");
  assert.match(cell.title, /2026/);
  assert.deepEqual(timeCell("garbage", now), { label: NO_TIME, dateTime: null, title: null });
});
