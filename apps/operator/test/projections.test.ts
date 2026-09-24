import assert from "node:assert/strict";
import { test } from "node:test";
import { currentHost, isMetrics, type Metrics, type Observation } from "../viewer/metrics.ts";
import {
  chartPath,
  fleetGroups,
  historyCoverage,
  hostSeries,
  residentSeries,
  presenceSeries,
} from "../viewer/projections.ts";

const fixture = (): Metrics => ({
  schema: 1,
  provenance: "Synthetic test",
  stale: false,
  now: 180000,
  intervalMs: 60000,
  strideMs: 60000,
  retentionDays: 14,
  latest: {
    at: 180000,
    discovery_status: "ok",
    journal_status: "ok",
    duration_ms: 10,
    recovery: null,
  },
  previews: [],
  observations: [],
  currentHost: [],
  gaps: [],
  sourceGaps: [],
  sourceGapsTruncated: false,
  deployments: [],
  runtime: null,
});
const row = (
  kind: string,
  at: number,
  preview: string,
  values: Record<string, number | null>,
  status = "ok",
): Observation => ({
  kind,
  at,
  preview,
  role: kind === "host" ? "" : "main",
  class: kind === "class" ? "NotebookRoom" : "",
  status,
  process: "same-process",
  values,
});

test("stopped previews collapse only with fresh discovery, and active deployments sort ahead of retained state", () => {
  const data = fixture();
  data.previews = ["pr-99", "pr-2", "main", "app"].map((id) => ({
    id,
    status: id === "pr-99" ? "retained" : "ready",
    revision: null,
    desiredRevision: null,
  }));
  assert.deepEqual(
    fleetGroups(data).current.map((p) => p.id),
    ["main", "app", "pr-2"],
  );
  assert.deepEqual(
    fleetGroups(data).retained.map((p) => p.id),
    ["pr-99"],
  );
  assert.equal(fleetGroups({ ...data, stale: true }).retained.length, 0);
  assert.equal(
    fleetGroups({ ...data, latest: { ...data.latest!, discovery_status: "error" } }).current.length,
    4,
  );
});

test("partial host data preserves measured memory and CPU while missing values and gaps stay unknown", () => {
  const data = fixture();
  const a = row(
    "host",
    120000,
    "",
    {
      cpu_total_ticks: 100,
      cpu_idle_ticks: 50,
      memory_total_bytes: 100,
      memory_available_bytes: 80,
    },
    "partial",
  );
  const b = row(
    "host",
    180000,
    "",
    {
      cpu_total_ticks: 200,
      cpu_idle_ticks: 150,
      memory_total_bytes: 100,
      memory_available_bytes: null,
    },
    "partial",
  );
  data.observations = [a, b];
  data.currentHost = [a, b];
  const [cpu, memory] = hostSeries(data);
  assert.equal(cpu.points[1].value, 0);
  assert.equal(Math.round(memory.points[0].value!), 20);
  assert.equal(memory.points[1].value, null);
  assert.equal(currentHost(data), b);
  data.gaps = [{ from: 130000, to: 170000 }];
  assert.equal(hostSeries(data)[0].points[1].value, null);
});

test("resident totals retain healthy fleets with explicit partial coverage and break across unknown captures", () => {
  const data = fixture();
  data.observations = [
    row("fleet", 60000, "main", { resident_objects: 3 }),
    row("class", 60000, "main", { resident_objects: 3 }),
    row("fleet", 60000, "pr-2", { resident_objects: null }, "error"),
    row("host", 120000, "", {}),
    row("fleet", 180000, "main", { resident_objects: 0 }),
    row("class", 180000, "main", { resident_objects: 0 }),
  ];
  const points = residentSeries(data)[0].points;
  assert.deepEqual(
    points.map((p) => p.value),
    [3, null, 0],
  );
  assert.equal(points[0].detail, "1/2 application fleets measured");
  const path = chartPath(
    points,
    (x) => x,
    (y) => y,
    data,
  );
  assert.equal((path.match(/M/g) || []).length, 2);
  assert(!path.includes("L"));
  assert(
    !chartPath(
      [points[0], points[2]],
      (x) => x,
      (y) => y,
      { ...data, sourceGapsTruncated: true },
    ).includes("L"),
  );
});

test("presence aggregates by half-hour without filling absent windows or presenting occupants as unique people", () => {
  const data = fixture();
  assert.deepEqual(presenceSeries(data), []);
  data.presence = [
    {
      bucket: 0,
      preview: "main",
      reports: 4,
      positive_reports: 2,
      distinct_rooms: 2,
      max_occupants: 8,
    },
    {
      bucket: 0,
      preview: "pr-2",
      reports: 5,
      positive_reports: 4,
      distinct_rooms: 3,
      max_occupants: 20,
    },
    {
      bucket: 3600000,
      preview: "main",
      reports: 1,
      positive_reports: 0,
      distinct_rooms: 0,
      max_occupants: 0,
    },
  ];
  assert.deepEqual(presenceSeries(data)[0].points, [
    { at: 0, value: 5 },
    { at: 3600000, value: 0 },
  ]);
});

test("pre-collection time is distinguished from real collection gaps and optional reader fields are validated", () => {
  const data = fixture();
  assert(isMetrics(data));
  data.coverage = { availableFrom: 120000, requestedFrom: 0, firstInRange: 120000 };
  data.gaps = [
    { from: 0, to: 120000 },
    { from: 130000, to: 170000 },
  ];
  assert.deepEqual(historyCoverage(data), { first: 120000, gaps: 1 });
  assert(isMetrics(data));
  assert(
    !isMetrics({
      ...data,
      coverage: { availableFrom: "yesterday", requestedFrom: 0, firstInRange: 120000 },
    }),
  );
  assert(!isMetrics({ ...data, presence: [{ bucket: 0, preview: "main", reports: 1 }] }));
  assert(!isMetrics({ ...data, processChanges: [{ at: NaN, preview: "main", role: "main" }] }));
});
