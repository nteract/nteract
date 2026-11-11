import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_SPEC_MAX_BYTES, checkChartSpec, checkFields } from "../shared/chart-spec.mjs";

const refusalRate = {
  data: { name: "usage_by_tool" },
  transform: [
    {
      aggregate: [
        { op: "sum", field: "calls", as: "calls" },
        { op: "sum", field: "refused", as: "refused" },
      ],
      groupby: ["tool"],
    },
    { calculate: "datum.refused / datum.calls", as: "refusal_rate" },
  ],
  layer: [
    {
      mark: { type: "bar" },
      encoding: {
        x: { field: "tool", type: "nominal", sort: "-y" },
        y: { field: "refusal_rate", type: "quantitative" },
      },
    },
    {
      transform: [
        {
          aggregate: [
            { op: "sum", field: "refused", as: "r" },
            { op: "sum", field: "calls", as: "c" },
          ],
        },
        { calculate: "datum.r / datum.c", as: "overall" },
      ],
      mark: { type: "rule" },
      encoding: { y: { field: "overall", type: "quantitative" } },
    },
  ],
};
const usageColumns = { usage_by_tool: ["client", "tool", "calls", "refused"] };

test("a spec reading named sources passes and lists them in first-use order", () => {
  const spec = {
    data: { name: "b" },
    hconcat: [{ mark: "bar" }, { data: { name: "a" }, mark: "line" }, { data: { name: "b" } }],
  };
  assert.deepEqual(checkChartSpec(spec), { sources: ["b", "a"], problems: [] });
});

test("a lookup's data is a source too", () => {
  const spec = {
    data: { name: "calls" },
    transform: [
      { lookup: "tool", from: { data: { name: "tools" }, key: "tool", fields: ["owner"] } },
    ],
    mark: "bar",
  };
  assert.deepEqual(checkChartSpec(spec).sources, ["calls", "tools"]);
});

test("URLs, inline values and generators are refused with the path that holds them", () => {
  const { problems } = checkChartSpec({
    data: { url: "https://example.com/data.csv" },
    layer: [{ data: { values: [{ a: 1 }] } }, { data: { sequence: { start: 0, stop: 3 } } }],
  });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^data: .*not a URL/);
  assert.match(problems[1], /^data: .*not inline values/);
  assert.match(problems[2], /^data: data must be/);
  assert.match(problems[3], /needs data/);
});

test("a spec with no data, a non-object, or an oversized spec is refused", () => {
  assert.match(checkChartSpec({ mark: "bar" }).problems[0], /needs data/);
  assert.match(checkChartSpec([]).problems[0], /JSON object/);
  const big = { data: { name: "s" }, description: "x".repeat(CHART_SPEC_MAX_BYTES) };
  assert.match(checkChartSpec(big).problems[0], /KiB or smaller/);
});

test("fields from columns, transforms and enclosing views pass", () => {
  assert.deepEqual(checkFields(refusalRate, usageColumns), { unknown: [], unchecked: false });
});

test("a misspelled field is reported with its channel", () => {
  const spec = structuredClone(refusalRate);
  spec.layer[0].encoding.x.field = "tooll";
  assert.deepEqual(checkFields(spec, usageColumns).unknown, [{ channel: "x", field: "tooll" }]);
});

test("a layer's own transform outputs don't leak to its siblings", () => {
  const spec = structuredClone(refusalRate);
  spec.layer[0].encoding.y.field = "overall";
  assert.deepEqual(checkFields(spec, usageColumns).unknown, [{ channel: "y", field: "overall" }]);
});

test("fold and tooltip arrays are followed; pivot leaves a view unchecked", () => {
  const folded = {
    data: { name: "daily" },
    transform: [{ fold: ["agent_calls", "browser_calls"] }],
    mark: "line",
    encoding: {
      x: { field: "day" },
      y: { field: "value" },
      color: { field: "key" },
      tooltip: [{ field: "value" }, { field: "nope" }],
    },
  };
  assert.deepEqual(checkFields(folded, { daily: ["day", "agent_calls", "browser_calls"] }), {
    unknown: [{ channel: "tooltip", field: "nope" }],
    unchecked: false,
  });
  const pivoted = { ...folded, transform: [{ pivot: "key", value: "value", groupby: ["day"] }] };
  assert.equal(checkFields(pivoted, { daily: ["day"] }).unchecked, true);
});
