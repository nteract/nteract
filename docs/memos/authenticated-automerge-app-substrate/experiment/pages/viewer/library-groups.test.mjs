// The library's group sections over loaded rows.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_GROUP,
  ITEMS_GROUP,
  SHARED_GROUP,
  UNDATED_GROUP,
  dateGroup,
  groupRows,
  projectGroup,
} from "./library-groups.mjs";
import { pageRow, projectTitles } from "./listing.mjs";

const id = (n) => `1a160b47-6df1-4983-81eb-${String(n).padStart(12, "0")}`;
const launch = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";
const notes = "prj_3b160b47-6df1-4983-81eb-489ca5a26812";
const titles = projectTitles([
  { project_id: launch, title: "Launch" },
  { project_id: notes, title: "Notes" },
]);
const utc = { locale: "en-US", timeZone: "UTC" };
// Tuesday, 3 November 2026, 15:00 UTC.
const now = Date.parse("2026-11-03T15:00:00.000Z");
const at = (iso) => dateGroup(iso, now, utc);

test("date groups follow calendar days, then months of the last year, then years", () => {
  assert.deepEqual(at("2026-11-03T00:00:00.000Z"), { key: "today", label: "Today" });
  assert.deepEqual(at("2026-11-03T23:59:00.000Z"), { key: "today", label: "Today" });
  assert.equal(at("2026-11-04T09:00:00.000Z").label, "Today", "clock skew counts as today");
  assert.deepEqual(at("2026-11-02T23:59:59.000Z"), { key: "yesterday", label: "Yesterday" });
  assert.equal(at("2026-11-02T00:00:00.000Z").label, "Yesterday");
  assert.equal(at("2026-11-01T12:00:00.000Z").label, "Previous 7 days");
  assert.equal(at("2026-10-27T00:00:00.000Z").label, "Previous 7 days");
  assert.equal(at("2026-10-26T23:00:00.000Z").label, "Previous 30 days");
  assert.equal(at("2026-10-04T00:00:00.000Z").label, "Previous 30 days");
  assert.deepEqual(at("2026-10-03T12:00:00.000Z"), { key: "m:2026-10", label: "October 2026" });
  assert.deepEqual(at("2026-09-30T12:00:00.000Z"), {
    key: "m:2026-09",
    label: "September 2026",
  });
  assert.deepEqual(at("2025-12-01T00:00:00.000Z"), {
    key: "m:2025-12",
    label: "December 2025",
  });
  assert.deepEqual(at("2025-11-30T00:00:00.000Z"), { key: "y:2025", label: "2025" });
  assert.deepEqual(at("2019-02-01T00:00:00.000Z"), { key: "y:2019", label: "2019" });
  for (const value of [null, undefined, "", "not a time"]) assert.equal(at(value), UNDATED_GROUP);
});

test("date groups use the browser's time zone for the day boundary", () => {
  // 01:30 UTC on 3 November is still 2 November in New York.
  const late = Date.parse("2026-11-03T01:30:00.000Z");
  const value = "2026-11-02T20:00:00.000Z";
  assert.equal(dateGroup(value, late, utc).label, "Yesterday");
  assert.equal(
    dateGroup(value, late, { locale: "en-US", timeZone: "America/New_York" }).label,
    "Today",
  );
  assert.equal(
    dateGroup("2026-10-01T02:00:00.000Z", now, {
      locale: "en-US",
      timeZone: "America/Los_Angeles",
    }).label,
    "September 2026",
    "a month is named in the browser's time zone",
  );
});

test("Project groups: each Project, Your items, Shared with you, and this device", () => {
  const owned = pageRow({ page_id: id(1), project_id: launch }, titles);
  assert.deepEqual(projectGroup(owned), {
    key: `project:${launch}`,
    label: "Launch",
    projectId: launch,
    href: `/project/${launch}`,
  });
  assert.equal(projectGroup(pageRow({ page_id: id(2) }, titles)), ITEMS_GROUP);
  assert.equal(
    projectGroup(pageRow({ page_id: id(3), shared: true, project_id: launch }, titles)),
    SHARED_GROUP,
    "a shared row never reveals its Project",
  );
  assert.equal(
    projectGroup(pageRow({ page_id: id(4), pending: true }, titles, { local: true })),
    DEVICE_GROUP,
  );
});

test("groups keep the order their first row appears in, and count loaded rows", () => {
  const rows = [
    pageRow({ page_id: id(9), title: "Draft", pending: true }, titles, { local: true }),
    pageRow({ page_id: id(1), project_id: launch, updated_at: "2026-11-03T10:00:00Z" }, titles),
    pageRow({ page_id: id(2), shared: true, updated_at: "2026-11-02T10:00:00Z" }, titles),
    pageRow({ page_id: id(3), updated_at: "2026-11-01T10:00:00Z" }, titles),
    pageRow({ page_id: id(4), project_id: notes, updated_at: "2026-09-01T10:00:00Z" }, titles),
    pageRow({ page_id: id(5), project_id: launch, updated_at: "2025-01-01T10:00:00Z" }, titles),
    pageRow({ page_id: id(6), shared: true }, titles),
  ];
  const summary = (sections) =>
    sections.map((section) => [section.label, section.rows.map((row) => row.id)]);
  assert.deepEqual(summary(groupRows(rows, "project", { now, ...utc })), [
    ["On this device", [id(9)]],
    ["Launch", [id(1), id(5)]],
    ["Shared with you", [id(2), id(6)]],
    ["Your items", [id(3)]],
    ["Notes", [id(4)]],
  ]);
  assert.deepEqual(summary(groupRows(rows, "date", { now, ...utc })), [
    ["On this device", [id(9)]],
    ["Today", [id(1)]],
    ["Yesterday", [id(2)]],
    ["Previous 7 days", [id(3)]],
    ["September 2026", [id(4)]],
    ["2025", [id(5)]],
    ["No date", [id(6)]],
  ]);
  assert.deepEqual(summary(groupRows(rows, null)), [[null, rows.map((row) => row.id)]]);
  assert.deepEqual(groupRows([], "project"), []);
  assert.deepEqual(groupRows([], null), []);
});

test("rows a Load more appends join the groups they belong to", () => {
  const first = [
    pageRow({ page_id: id(1), project_id: launch }, titles),
    pageRow({ page_id: id(2) }, titles),
  ];
  const more = [...first, pageRow({ page_id: id(3), project_id: launch }, titles)];
  const sections = groupRows(more, "project");
  assert.deepEqual(
    sections.map((section) => [section.key, section.rows.length]),
    [
      [`project:${launch}`, 2],
      ["items", 1],
    ],
  );
});
