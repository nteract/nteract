// The library's group sections over loaded rows.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_GROUP,
  ITEMS_GROUP,
  SHARED_GROUP,
  PROJECT_ACCENTS,
  UNDATED_GROUP,
  dateGroup,
  groupAccent,
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

test("a Project's accent follows its ID, never its title, and spreads over every accent", () => {
  const first = groupAccent(projectGroup(pageRow({ page_id: id(1), project_id: launch }, titles)));
  assert.match(first.accent, /^[1-6]$/);
  assert.equal(first.recency, null);
  const renamed = projectTitles([{ project_id: launch, title: "Renamed" }]);
  assert.deepEqual(
    groupAccent(projectGroup(pageRow({ page_id: id(2), project_id: launch }, renamed))),
    first,
    "a rename keeps the color",
  );
  // Pinned values: a change here recolors every Project people know.
  assert.equal(groupAccent({ key: `project:${launch}` }).accent, "5");
  assert.equal(groupAccent({ key: `project:${notes}` }).accent, "4");
  const seen = new Set();
  for (let index = 0; index < 64; index++)
    seen.add(
      groupAccent({
        key: `project:prj_${String(index).padStart(8, "0")}-6df1-4983-81eb-489ca5a26812`,
      }).accent,
    );
  assert.equal(seen.size, PROJECT_ACCENTS, "64 Projects use all six accents");
});

test("the fixed groups keep their own accents, and date groups fade with age", () => {
  assert.deepEqual(groupAccent(SHARED_GROUP), { accent: "shared", recency: null });
  assert.deepEqual(groupAccent(DEVICE_GROUP), { accent: "device", recency: null });
  assert.deepEqual(groupAccent(ITEMS_GROUP), { accent: "items", recency: null });
  assert.deepEqual(
    ["today", "yesterday", "week", "month", "m:2026-09", "y:2025", UNDATED_GROUP.key].map((key) =>
      groupAccent({ key }),
    ),
    [0, 1, 2, 3, 4, 5, 5].map((recency) => ({ accent: "date", recency })),
  );
});

test("every group accent reads as text at 4.5:1 on the page and its heading tint, in both themes", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("/* Group accents"));
  const tokens = (selector) => {
    const start = block.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} sets the group accents`);
    const body = block.slice(start, block.indexOf("}", start));
    return Object.fromEntries(
      [...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map(([, name, hex]) => [name, hex]),
    );
  };
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const luminance = (color) => {
    const [r, g, b] = color.map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  // A 10% sRGB mix tints more than the heading's 6% in oklab does.
  const tint = (accent, surface) =>
    accent.map((value, index) => value * 0.1 + surface[index] * 0.9);
  // --background: oklch(1 0 0) and oklch(0.145 0 0) (src/styles/notebook-tokens.css).
  for (const [selector, surface] of [
    [":root", [255, 255, 255]],
    [":root.dark", [10, 10, 10]],
  ]) {
    const set = tokens(selector);
    const names = [1, 2, 3, 4, 5, 6]
      .map((n) => `--chart-${n}`)
      .concat(["--group-shared", "--group-device"]);
    assert.deepEqual(Object.keys(set).sort(), names.sort(), `${selector} sets every accent`);
    assert.equal(new Set(Object.values(set)).size, names.length, `${selector} accents differ`);
    for (const [name, hex] of Object.entries(set)) {
      const accent = rgb(hex);
      for (const background of [surface, tint(accent, surface)])
        assert.ok(
          ratio(accent, background) >= 4.5,
          `${selector} ${name} ${hex}: ${ratio(accent, background).toFixed(2)}:1`,
        );
    }
  }
});
