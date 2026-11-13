// Static Vega-Lite specs across marks, transforms, facets, repeats, layers
// and concatenation, each drawn over `corpusRows`. viewer/vega-chart.test.mjs
// checks that both spec checks pass every one and that together they use
// every allowlisted operator and call; scripts/chart-smoke.mjs draws them in
// a recording Worker to find the globals the chart Worker uses.

/** Rows every corpus spec draws over, under each data name it reads. */
export const corpusRows = Array.from({ length: 24 }, (_, i) => ({
  a: ["read", "patch", "move"][i % 3],
  b: ["Claude", "Codex"][i % 2],
  n: 10 + ((i * 7) % 13),
  m: 3 + ((i * 5) % 11),
  t: Date.UTC(2026, i % 12, 1 + (i % 27)),
}));

export const CORPUS = (() => {
  const d = { name: "c" };
  const enc = { x: { field: "a", type: "nominal" }, y: { field: "n", type: "quantitative" } };
  const xy = { x: { field: "n", type: "quantitative" }, y: { field: "m", type: "quantitative" } };
  const time = {
    x: { field: "t", type: "temporal", timeUnit: "yearmonth" },
    y: { field: "n", type: "quantitative", aggregate: "sum" },
    color: { field: "a", type: "nominal" },
  };
  return [
    { data: d, mark: "bar", encoding: enc },
    {
      data: d,
      mark: "bar",
      encoding: {
        y: { field: "a", type: "nominal" },
        x: { field: "n", type: "quantitative", aggregate: "sum" },
        color: { field: "b" },
      },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        ...enc,
        y: { ...enc.y, stack: "normalize", axis: { format: "%" } },
        color: { field: "b" },
      },
    },
    { data: d, mark: "line", encoding: time },
    { data: d, mark: { type: "area", interpolate: "monotone" }, encoding: time },
    {
      data: d,
      mark: { type: "line", point: true },
      encoding: { ...time, strokeDash: { field: "a" } },
    },
    {
      data: d,
      mark: "point",
      encoding: {
        ...xy,
        color: { field: "a" },
        size: { field: "m", type: "quantitative" },
        shape: { field: "a" },
      },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        x: { field: "n", bin: { maxbins: 30 }, type: "quantitative" },
        y: { aggregate: "count" },
      },
    },
    {
      data: d,
      mark: "rect",
      encoding: {
        x: { field: "n", bin: true },
        y: { field: "m", bin: true },
        color: { aggregate: "count" },
      },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        x: { field: "n", bin: { step: 5, extent: [0, 100] }, type: "quantitative" },
        y: { aggregate: "count" },
      },
    },
    { data: d, mark: "bar", encoding: { ...enc, facet: { field: "b", columns: 2 } } },
    { data: d, facet: { row: { field: "b" } }, spec: { mark: "bar", encoding: enc } },
    { data: d, mark: "bar", encoding: { ...enc, row: { field: "b" }, column: { field: "c" } } },
    {
      data: d,
      repeat: ["n", "m"],
      spec: {
        mark: "bar",
        encoding: { x: { field: "a" }, y: { field: { repeat: "repeat" }, type: "quantitative" } },
      },
    },
    {
      data: d,
      hconcat: [
        { mark: "bar", encoding: enc },
        { mark: "point", encoding: enc },
      ],
    },
    {
      data: d,
      vconcat: [
        { mark: "bar", encoding: enc },
        { mark: "point", encoding: enc },
      ],
    },
    {
      data: d,
      layer: [
        { mark: "bar", encoding: enc },
        {
          mark: { type: "text", dy: -4 },
          encoding: { ...enc, text: { field: "n", format: ",.1f" } },
        },
        { mark: "rule", encoding: { y: { aggregate: "mean", field: "n" } } },
      ],
    },
    { data: d, mark: "boxplot", encoding: enc },
    { data: d, mark: "errorbar", encoding: enc },
    {
      data: d,
      mark: { type: "errorband", extent: "ci" },
      encoding: { x: { field: "t", type: "temporal" }, y: { field: "n", type: "quantitative" } },
    },
    {
      data: d,
      mark: { type: "arc", innerRadius: 40 },
      encoding: { theta: { field: "n", type: "quantitative", stack: true }, color: { field: "a" } },
    },
    {
      data: d,
      transform: [
        { window: [{ op: "rank", as: "r" }], sort: [{ field: "n", order: "descending" }] },
        { filter: "datum.r <= 5" },
        { joinaggregate: [{ op: "sum", field: "n", as: "tot" }] },
        { calculate: "datum.n/datum.tot", as: "p" },
      ],
      mark: "bar",
      encoding: {
        x: { field: "a" },
        y: { field: "p", type: "quantitative", axis: { format: ".0%" } },
      },
    },
    {
      data: d,
      layer: [
        { mark: "point", encoding: xy },
        { mark: "line", transform: [{ regression: "m", on: "n" }], encoding: xy },
      ],
    },
    {
      data: d,
      transform: [{ density: "n", groupby: ["a"] }],
      mark: "area",
      encoding: {
        x: { field: "value", type: "quantitative" },
        y: { field: "density", type: "quantitative" },
        color: { field: "a" },
      },
    },
    {
      data: d,
      transform: [{ quantile: "n", step: 0.01 }],
      mark: "point",
      encoding: {
        x: { field: "prob", type: "quantitative" },
        y: { field: "value", type: "quantitative" },
      },
    },
    {
      data: d,
      transform: [{ fold: ["n", "m"] }],
      mark: "bar",
      encoding: { x: { field: "key" }, y: { field: "value", type: "quantitative" } },
    },
    {
      data: d,
      transform: [{ pivot: "a", value: "n", groupby: ["t"], limit: 10 }],
      mark: "point",
      encoding: { x: { field: "t", type: "temporal" } },
    },
    {
      data: d,
      transform: [{ sample: 500 }, { extent: "n", param: "ext" }],
      mark: "point",
      encoding: xy,
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        x: { field: "a", sort: "-y" },
        y: { field: "n", aggregate: "argmax", type: "quantitative" },
        tooltip: [
          { field: "a" },
          { field: "n", format: ".2f" },
          { field: "t", type: "temporal", timeUnit: "yearmonthdate" },
        ],
      },
    },
    {
      data: d,
      mark: { type: "bar", tooltip: true },
      encoding: {
        ...enc,
        x: { ...enc.x, axis: { labelExpr: "upper(datum.label)", labelAngle: -45 } },
        color: { field: "b", legend: { labelExpr: "datum.label + '!'", orient: "bottom" } },
      },
    },
    {
      data: d,
      mark: "tick",
      encoding: {
        x: { field: "n", type: "quantitative", scale: { type: "log" } },
        y: { field: "a" },
      },
    },
    {
      data: d,
      mark: "point",
      encoding: {
        x: { field: "t", type: "temporal", scale: { type: "utc" }, axis: { format: "%b %Y" } },
        y: { field: "n", type: "quantitative", scale: { zero: false } },
      },
    },
    {
      data: d,
      mark: "text",
      encoding: { text: { field: "t", type: "temporal", format: "%Y" }, x: { field: "a" } },
    },
    {
      data: d,
      params: [{ name: "cut", value: 5 }],
      transform: [{ filter: "datum.n > cut" }],
      mark: "bar",
      encoding: enc,
    },
    {
      data: d,
      params: [{ name: "k", expr: "2 * 3" }],
      mark: "bar",
      encoding: { ...enc, opacity: { value: { expr: "k / 10" } } },
    },
    {
      data: d,
      mark: "rect",
      encoding: {
        x: { field: "t", timeUnit: "date", type: "ordinal" },
        y: { field: "t", timeUnit: "month", type: "ordinal" },
        color: { field: "n", aggregate: "max", type: "quantitative", scale: { scheme: "viridis" } },
      },
    },
    {
      data: d,
      mark: "geoshape",
      projection: { type: "albersUsa" },
      encoding: { color: { field: "n", type: "quantitative" } },
    },
    {
      data: d,
      mark: "trail",
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { field: "n", type: "quantitative" },
        size: { field: "m", type: "quantitative" },
      },
    },
    {
      data: d,
      transform: [
        { timeUnit: "yearmonth", field: "t", as: "ym" },
        { aggregate: [{ op: "mean", field: "n", as: "mn" }], groupby: ["ym"] },
        { lookup: "ym", from: { data: { name: "e" }, key: "ym", fields: ["x"] } },
      ],
      mark: "line",
      encoding: { x: { field: "ym", type: "temporal" }, y: { field: "mn", type: "quantitative" } },
    },
    {
      data: d,
      mark: "bar",
      encoding: { ...enc, color: { field: "a", type: "nominal", scale: null } },
    },
    {
      data: d,
      mark: "bar",
      encoding: {
        ...enc,
        color: { condition: { test: "datum.n > 3", value: "red" }, value: "grey" },
      },
    },
    { data: d, title: { text: "T", subtitle: "S" }, mark: "bar", encoding: enc },
    { data: d, mark: "bar", encoding: { ...enc, color: { field: "n", type: "quantitative" } } },
    { data: d, mark: "bar", encoding: { ...enc, x: { ...enc.x, title: ["Two", "lines"] } } },
  ];
})();
