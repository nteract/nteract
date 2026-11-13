import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHART_EXPRESSION_FUNCTIONS,
  CHART_MAX_ROWS,
  CHART_SPEC_LIMITS,
  checkChartSpec,
  loadsResource,
} from "../shared/chart-spec.mjs";

const stacked = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: { name: "calls" },
  transform: [{ calculate: "round(datum.calls * 100) / 100", as: "share" }],
  mark: "bar",
  encoding: {
    y: { field: "tool", type: "nominal" },
    x: { field: "calls", type: "quantitative", aggregate: "sum" },
    color: { field: "client", type: "nominal" },
  },
};

const refusal = (spec, options) => {
  const result = checkChartSpec(spec, options);
  assert.equal(result.ok, false, "expected a refusal");
  // One sentence: a capital, one terminal period, no second sentence.
  assert.match(result.error, /^[A-Z].*\.$/);
  assert.doesNotMatch(result.error.slice(0, -1), /\.\s/);
  return result.error;
};

test("a spec over named data passes and lists the names it reads in first-use order", () => {
  const spec = {
    data: { name: "calls" },
    transform: [
      { lookup: "tool", from: { data: { name: "tools" }, key: "id", fields: ["label"] } },
    ],
    layer: [{ mark: "bar" }, { data: { name: "targets" }, mark: "rule" }, { mark: "text" }],
  };
  assert.deepEqual(checkChartSpec(spec), { ok: true, names: ["calls", "tools", "targets"] });
  assert.deepEqual(checkChartSpec(stacked, { datasets: ["calls"] }), {
    ok: true,
    names: ["calls"],
  });
});

test("a layer with data: null reads nothing and is allowed", () => {
  const spec = { data: { name: "calls" }, layer: [{ mark: "bar" }, { data: null, mark: "rule" }] };
  assert.equal(checkChartSpec(spec).ok, true);
});

test("a spec that isn't a JSON object is refused", () => {
  for (const spec of [null, "bar", 3, [stacked]]) assert.match(refusal(spec), /JSON object/);
  const cyclic = { data: { name: "calls" } };
  cyclic.self = cyclic;
  assert.match(refusal(cyclic), /nest at most|plain JSON/);
});

test("a spec over the byte limit is refused", () => {
  const spec = { ...stacked, description: "x".repeat(CHART_SPEC_LIMITS.maxBytes) };
  assert.match(refusal(spec), /64 KiB or smaller/);
});

test("a spec with more views than the limit is refused", () => {
  const layer = Array.from({ length: CHART_SPEC_LIMITS.maxViews }, () => ({ mark: "bar" }));
  assert.match(refusal({ data: { name: "calls" }, layer }), /at most 32 views/);
  const nested = {
    data: { name: "calls" },
    facet: { field: "a" },
    spec: { layer: layer.slice(1) },
  };
  assert.match(refusal(nested), /at most 32 views/);
  assert.equal(checkChartSpec({ data: { name: "calls" }, layer: layer.slice(1) }).ok, true);
});

test("a spec nested past the depth limit is refused", () => {
  let deep = { mark: "bar" };
  for (let i = 0; i < CHART_SPEC_LIMITS.maxDepth + 2; i++) deep = { layer: [deep] };
  deep.data = { name: "calls" };
  assert.match(refusal(deep), /nest at most/);
});

test("a Vega spec or another schema is refused", () => {
  assert.match(
    refusal({ ...stacked, $schema: "https://vega.github.io/schema/vega/v6.json" }),
    /must be Vega-Lite/,
  );
});

test("inline data is refused: values, datasets and generators", () => {
  assert.match(
    refusal({ ...stacked, data: { values: [{ tool: "a", calls: 1 }] } }),
    /not inline values \(at data\)/,
  );
  assert.match(
    refusal({ ...stacked, datasets: { calls: [{ tool: "a" }] } }),
    /not inline datasets/,
  );
  assert.match(refusal({ ...stacked, data: { sequence: { start: 0, stop: 9 } } }), /generated/);
  assert.match(
    refusal({ ...stacked, data: { name: "calls", format: { type: "csv" } } }),
    /must be/,
  );
  assert.match(refusal({ ...stacked, data: "calls" }), /must be \{"name"/);
});

test("a data name the caller didn't supply is refused", () => {
  assert.equal(
    refusal(stacked, { datasets: ["usage"] }),
    'This chart reads "calls", but no dataset has that name.',
  );
});

test("a spec with no data is refused", () => {
  assert.match(refusal({ mark: "rule", encoding: { y: { datum: 3 } } }), /needs data/);
});

test("anything that would fetch or navigate is refused", () => {
  assert.match(refusal({ ...stacked, data: { url: "https://x.test/a.csv" } }), /from a URL/);
  assert.match(
    refusal({
      ...stacked,
      transform: [{ lookup: "id", from: { data: { url: "/a.json" }, key: "id" } }],
    }),
    /from a URL \(at transform\.0\.from\.data\)/,
  );
  assert.match(refusal({ ...stacked, mark: "image" }), /image marks/);
  assert.match(refusal({ ...stacked, mark: { type: "image", width: 9 } }), /image marks/);
  assert.match(
    refusal({ ...stacked, encoding: { ...stacked.encoding, url: { field: "src" } } }),
    /from a URL \(at encoding\.url\)/,
  );
  assert.match(
    refusal({ ...stacked, encoding: { ...stacked.encoding, href: { field: "link" } } }),
    /link anywhere \(at encoding\.href\)/,
  );
  assert.match(refusal({ ...stacked, mark: { type: "bar", href: "https://x.test" } }), /link/);
  assert.match(refusal({ ...stacked, config: { mark: { href: "https://x.test" } } }), /link/);
});

test("the interactive surface is refused: selections, bindings and raw signals", () => {
  const select = (select, extra = {}) => ({
    ...stacked,
    params: [{ name: "p", select, ...extra }],
  });
  for (const spec of [
    select("interval"),
    select({ type: "point", toggle: "modify('calls', null, true)" }),
    select({ type: "point", on: "window:keydown!" }),
    select({ type: "interval", translate: "[mousedown, mouseup] > mousemove", zoom: "wheel!" }),
    select("interval", { bind: "scales" }),
    select({ type: "point", fields: ["client"] }, { bind: "legend" }),
    { ...stacked, params: [{ name: "p", value: 1, bind: { input: "range", min: 0, max: 9 } }] },
    { ...stacked, params: [{ name: "p", value: 1, bind: { element: "#comments" } }] },
    { ...stacked, selection: { brush: { type: "interval" } } },
    { ...stacked, config: { selection: { interval: { on: "click" } } } },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        color: { condition: { param: "p", field: "client" }, value: "grey" },
      },
    },
    { ...stacked, transform: [{ filter: { param: "p" } }] },
    { ...stacked, transform: [{ filter: { and: [{ param: "p", empty: false }] } }] },
    { ...stacked, transform: [{ lookup: "tool", from: { param: "p", key: "tool" } }] },
    {
      ...stacked,
      config: { signals: [{ name: "s", on: [{ events: "window:keydown", update: "1" }] }] },
    },
    { ...stacked, width: "container" },
  ])
    assert.match(
      refusal(spec),
      /static|selection|container|out-of-range from|can't use "(empty|signals)"/,
      JSON.stringify(spec).slice(0, 200),
    );
  // Value parameters stay.
  assert.equal(
    checkChartSpec({
      ...stacked,
      params: [
        { name: "cut", value: 5 },
        { name: "k", expr: "cut * 2" },
      ],
    }).ok,
    true,
  );
});

test("expressions may call only allowlisted functions", () => {
  const calc = (calculate) => ({ ...stacked, transform: [{ calculate, as: "v" }] });
  assert.equal(checkChartSpec(calc("format(datum.calls, ',') + upper(datum.tool)")).ok, true);
  assert.equal(
    refusal(calc("modify('calls', datum)")),
    "A chart expression calls modify() (at transform.0.calculate).",
  );
  assert.match(refusal(calc("lassoAppend(null, 1, 2)")), /calls lassoAppend\(\)/);
  assert.match(refusal(calc("datum.tool.toString()")), /something that isn't a function name/);
  // A function name inside a string literal is text, not a call.
  assert.equal(checkChartSpec(calc("'modify(' + datum.tool")).ok, true);
  assert.match(refusal(calc("datum.calls +")), /doesn't parse/);
});

test("generators that build arrays or strings of any length are refused", () => {
  for (const call of [
    "sequence(0, 1e9)",
    "timeSequence('day', 0, 1e15)",
    "utcSequence('day', 0, 1e15)",
    "pad('', 1e9)",
  ]) {
    assert.match(
      refusal({ ...stacked, transform: [{ calculate: call, as: "v" }] }),
      /calls \w+\(\)/,
    );
    assert.equal(CHART_EXPRESSION_FUNCTIONS.has(call.split("(")[0]), false);
  }
});

test("regular expression literals are refused", () => {
  assert.match(
    refusal({
      ...stacked,
      transform: [{ calculate: "replace(datum.tool, /^(a+)+$/, '')", as: "v" }],
    }),
    /uses a regular expression/,
  );
  assert.equal(
    checkChartSpec({
      ...stacked,
      transform: [{ calculate: "replace(datum.tool, '_', ' ')", as: "v" }],
    }).ok,
    true,
  );
});

test("every Vega-Lite expression position is checked", () => {
  const bad = "warn(datum.value)";
  const label = { labelExpr: bad };
  for (const spec of [
    { ...stacked, transform: [{ filter: bad }] },
    { ...stacked, transform: [{ filter: { and: [bad, "true"] } }] },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        opacity: { condition: { test: bad, value: 1 }, value: 0.3 },
      },
    },
    { ...stacked, mark: { type: "bar", opacity: { expr: bad } } },
    { ...stacked, params: [{ name: "p", expr: bad }] },
    { ...stacked, encoding: { ...stacked.encoding, y: { ...stacked.encoding.y, axis: label } } },
    { ...stacked, encoding: { ...stacked.encoding, color: { field: "client", legend: label } } },
    { ...stacked, config: { axis: label } },
    { ...stacked, encoding: { ...stacked.encoding, row: { field: "client", header: label } } },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        y: {
          ...stacked.encoding.y,
          axis: { encode: { labels: { update: { fill: { signal: bad } } } } },
        },
      },
    },
  ])
    assert.match(refusal(spec), /calls warn\(\)/, JSON.stringify(spec).slice(0, 200));
  assert.equal(
    checkChartSpec({ ...stacked, transform: [{ filter: { field: "a", equal: 1 } }] }).ok,
    true,
  );
});

test("raw Vega signals and custom format functions are refused", () => {
  assert.match(
    refusal({ ...stacked, config: { signals: [{ name: "s", init: "1" }] } }),
    /"signals"; charts are static/,
  );
  assert.match(
    refusal({
      ...stacked,
      encoding: { ...stacked.encoding, x: { ...stacked.encoding.x, formatType: "warn" } },
    }),
    /format type must be number, time or utc/,
  );
  for (const key of [
    "customFormatTypes",
    "numberFormatType",
    "normalizedNumberFormatType",
    "timeFormatType",
  ])
    assert.match(
      refusal({ ...stacked, config: { [key]: key === "customFormatTypes" ? true : "f" } }),
      /custom format/,
    );
  assert.equal(
    checkChartSpec({
      ...stacked,
      encoding: {
        ...stacked.encoding,
        x: { ...stacked.encoding.x, formatType: "number", format: ",d" },
      },
    }).ok,
    true,
  );
});

test("expressions can't reach prototypes, however the name is written", () => {
  for (const calculate of [
    "datum.constructor",
    "datum.__proto__",
    "datum['__proto__']",
    'datum["constructor"]',
    'datum["constr\\u0075ctor"]',
    "datum['proto' + 'type']",
    "datum[datum.key]",
    "{__proto__: 1}",
    "{'constructor': 1}",
  ])
    assert.match(
      refusal({ ...stacked, transform: [{ calculate, as: "v" }] }),
      /uses "(constructor|__proto__|prototype)"|indexes with something other than a literal/,
      calculate,
    );
  assert.equal(
    checkChartSpec({
      ...stacked,
      transform: [{ calculate: "datum['calls per day'] + datum[0]", as: "v" }],
    }).ok,
    true,
  );
});

test("a repeat counts every copy it draws", () => {
  const inner = {
    mark: "bar",
    encoding: { x: { field: { repeat: "row" }, type: "quantitative" } },
  };
  const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
  assert.match(
    refusal({ data: { name: "calls" }, repeat: { row: names, column: names }, spec: inner }),
    /at most 32 views/,
  );
  assert.match(
    refusal({
      data: { name: "calls" },
      repeat: Array.from({ length: 40 }, (_, i) => `f${i}`),
      spec: inner,
    }),
    /at most 32 views/,
  );
  assert.equal(
    checkChartSpec({
      data: { name: "calls" },
      repeat: { row: names.slice(0, 3), column: names.slice(0, 3) },
      spec: inner,
    }).ok,
    true,
  );
});

test("a CSS url() in any string is refused, escaped or not", () => {
  const probe = "url(https://x.example/p.png)";
  for (const spec of [
    { ...stacked, mark: { type: "bar", fill: probe } },
    { ...stacked, mark: { type: "bar", stroke: probe } },
    { ...stacked, encoding: { ...stacked.encoding, color: { value: probe } } },
    {
      ...stacked,
      mark: {
        type: "bar",
        fill: {
          gradient: "linear",
          stops: [
            { offset: 0, color: probe },
            { offset: 1, color: "red" },
          ],
        },
      },
    },
    { ...stacked, mark: { type: "text", font: probe } },
    { ...stacked, background: probe },
    {
      ...stacked,
      config: { style: { hostile: { fill: probe } } },
      mark: { type: "bar", style: "hostile" },
    },
    { ...stacked, config: { view: { stroke: probe } } },
    { ...stacked, config: { axis: { gridColor: probe } } },
    { ...stacked, mark: { type: "bar", fill: "u\\72l(https://x.example/p.png)" } },
    { ...stacked, mark: { type: "bar", fill: "URL(https://x.example/p.png)" } },
    { ...stacked, mark: { type: "bar", fill: "image-set('https://x.example/p.png' 1x)" } },
    { ...stacked, transform: [{ calculate: `'${probe}'`, as: "paint" }] },
  ])
    assert.match(
      refusal(spec),
      /can't load anything from a URL/,
      JSON.stringify(spec).slice(0, 160),
    );
  // Prose with a space before the parenthesis isn't a CSS function.
  assert.equal(
    checkChartSpec({ ...stacked, title: "Hover image (left) and url (right)" }).ok,
    true,
  );
  assert.equal(loadsResource("rgb(1, 2, 3)"), false);
});

test("a symbol shape is one of Vega's own, never a custom SVG path", () => {
  const point = { data: { name: "calls" }, mark: "point" };
  const shapeField = { field: "client", type: "nominal" };
  const allowed = [
    { ...point, mark: { type: "point", shape: "triangle-up" } },
    { ...point, encoding: { shape: { value: "diamond" } } },
    { ...point, encoding: { shape: { ...shapeField, scale: { range: ["circle", "wedge"] } } } },
    { ...point, encoding: { shape: { ...shapeField, scale: { range: "symbol" } } } },
    { ...point, encoding: { shape: { ...shapeField, legend: { symbolType: "square" } } } },
    // A field named "shape" is a field, not a shape.
    { ...point, encoding: { color: { field: "shape", type: "nominal" } } },
    { ...point, config: { point: { shape: "cross" }, range: { symbol: ["stroke", "arrow"] } } },
  ];
  for (const spec of allowed) assert.equal(checkChartSpec(spec).ok, true, JSON.stringify(spec));
  const custom = "M-1,-1H1V1H-1Z";
  const refused = [
    { ...point, mark: { type: "point", shape: custom } },
    { ...point, encoding: { shape: { value: custom } } },
    {
      ...point,
      encoding: { shape: { ...shapeField, condition: { test: "datum.calls > 1", value: custom } } },
    },
    { ...point, encoding: { shape: { ...shapeField, scale: { range: ["circle", custom] } } } },
    { ...point, encoding: { shape: { ...shapeField, legend: { symbolType: custom } } } },
    { ...point, config: { mark: { shape: custom } } },
    { ...point, config: { range: { symbol: ["circle", custom] } } },
    { ...point, config: { legend: { symbolType: custom } } },
    { layer: [{ ...point, mark: { type: "point", shape: custom } }] },
  ];
  for (const spec of refused)
    assert.match(
      refusal(spec),
      /A chart's symbols are Vega's own shapes: circle, square, cross, diamond, triangle-up, triangle-down, triangle-right, triangle-left, triangle, arrow, wedge or stroke; it can't draw a custom SVG path/,
      JSON.stringify(spec),
    );
});

test("a cursor is a CSS keyword, never a URL or an expression", () => {
  assert.equal(checkChartSpec({ ...stacked, mark: { type: "bar", cursor: "pointer" } }).ok, true);
  assert.match(
    refusal({ ...stacked, mark: { type: "bar", cursor: "url(https://x.example/c.png), auto" } }),
    /cursor must be a CSS cursor keyword|from a URL/,
  );
  assert.match(
    refusal({ ...stacked, mark: { type: "bar", cursor: { expr: "'pointer'" } } }),
    /cursor must be a CSS cursor keyword/,
  );
  assert.match(refusal({ ...stacked, config: { mark: { cursor: "zoom" } } }), /cursor keyword/);
});

test("transforms that multiply rows or cost are bounded or refused", () => {
  const t = (transform) => ({ ...stacked, transform: [transform] });
  const fields = (n) => Array.from({ length: n }, (_, i) => `f${i}`);
  const cases = [
    [{ flatten: ["xs"] }, /can't use the flatten transform/],
    [{ loess: "y", on: "x" }, /can't use the loess transform/],
    [{ impute: "y", key: "x", keyvals: { start: 0, stop: 1e9 } }, /impute/],
    [{ fold: fields(33) }, /fold at most 32 fields/],
    [
      { window: [{ op: "mean", field: "calls", as: "m" }], frame: [-500, 500], ignorePeers: true },
      /window frame/,
    ],
    [{ window: [{ op: "mean", field: "calls", as: "m" }], frame: [0, null] }, /window frame/],
    [{ density: "calls", steps: 10_000 }, /density/],
    [{ density: "calls", maxsteps: 10_000 }, /density/],
    [{ regression: "y", on: "x", method: "poly", order: 50 }, /order/],
    [{ quantile: "calls", step: 1e-9 }, /quantile transform has an out-of-range step/],
    [{ quantile: "calls", probs: Array.from({ length: 1001 }, () => 0.5) }, /out-of-range probs/],
    [{ pivot: "client", value: "calls" }, /pivot/],
    [{ pivot: "client", value: "calls", limit: 5000 }, /pivot/],
    [{ bin: { maxbins: 1e6 }, field: "calls", as: "b" }, /maxbins is out of range/],
    [{ bin: { step: 0.001 }, field: "calls", as: "b" }, /literal extent/],
    [{ bin: { step: 0.001, extent: [0, 100] }, field: "calls", as: "b" }, /literal extent/],
  ];
  for (const [transform, sentence] of cases)
    assert.match(refusal(t(transform)), sentence, JSON.stringify(transform));
  assert.match(
    refusal({
      ...stacked,
      encoding: { ...stacked.encoding, x: { ...stacked.encoding.x, impute: { value: 0 } } },
    }),
    /impute/,
  );
  assert.match(
    refusal({
      ...stacked,
      encoding: { ...stacked.encoding, x: { field: "calls", bin: { maxbins: 1e6 } } },
    }),
    /maxbins is out of range/,
  );
  for (const transform of [
    { fold: fields(32) },
    { window: [{ op: "rank", as: "r" }] },
    { window: [{ op: "sum", field: "calls", as: "s" }], frame: [null, 0] },
    { window: [{ op: "mean", field: "calls", as: "m" }], frame: [-100, 100], ignorePeers: true },
    { density: "calls", steps: 200 },
    { regression: "y", on: "x", method: "poly", order: 3 },
    { quantile: "calls", step: 0.01 },
    { pivot: "client", value: "calls", limit: 20 },
    { bin: { step: 1, extent: [0, 100] }, field: "calls", as: "b" },
    { lookup: "tool", from: { data: { name: "calls" }, key: "tool", fields: ["client"] } },
  ])
    assert.equal(checkChartSpec(t(transform)).ok, true, JSON.stringify(transform));
});

test("the row cap is a named limit", () => {
  assert.equal(CHART_MAX_ROWS, 100_000);
});

test("the allowlist leaves out writes, paths, generators and geometry", () => {
  for (const name of [
    "modify",
    "pluck",
    "data",
    "indata",
    "merge",
    "sequence",
    "timeSequence",
    "utcSequence",
    "pad",
    "join",
    "split",
    "regexp",
    "test",
    "random",
    "lassoAppend",
    "intersectLasso",
    "windowSize",
    "containerSize",
    "warn",
  ])
    assert.equal(CHART_EXPRESSION_FUNCTIONS.has(name), false, name);
  assert.match(
    refusal({
      ...stacked,
      transform: [{ calculate: "toString(pluck(datum, 'constructor.constructor'))", as: "v" }],
    }),
    /calls pluck\(\)/,
  );
});

test("usermeta is the spec author's own and isn't checked", () => {
  assert.equal(checkChartSpec({ ...stacked, usermeta: { url: "https://x.test" } }).ok, true);
});

test("a bound refuses a number written as a string", () => {
  const t = (transform) => ({ ...stacked, transform: [transform] });
  for (const transform of [
    { density: "calls", steps: "1000000000", extent: [0, 1] },
    { density: "calls", maxsteps: "1e9" },
    { regression: "y", on: "x", method: "poly", order: "50" },
    { quantile: "calls", step: "1e-9" },
    { pivot: "client", value: "calls", limit: "5" },
    { bin: { maxbins: "1e9" }, field: "calls", as: "b" },
    { bin: { step: "0.001", extent: [0, 100] }, field: "calls", as: "b" },
    { window: [{ op: "sum", field: "calls", as: "s" }], frame: ["-5", 5], ignorePeers: true },
  ])
    assert.equal(checkChartSpec(t(transform)).ok, false, JSON.stringify(transform));
});

test("folds are bounded along a view's whole path", () => {
  const chained = {
    ...stacked,
    transform: Array.from({ length: 30 }, () => ({ fold: ["a", "b"] })),
  };
  assert.match(refusal(chained), /folds can multiply its rows at most 32 times/);
  const nested = {
    data: { name: "calls" },
    transform: [{ fold: ["a", "b", "c", "d"] }],
    layer: [
      { mark: "bar" },
      { transform: [{ fold: ["e", "f", "g", "h", "i", "j", "k", "l", "m"] }], mark: "point" },
    ],
  };
  assert.match(refusal(nested), /folds can multiply/);
  assert.equal(
    checkChartSpec({
      ...stacked,
      transform: [{ fold: ["a", "b"] }, { fold: ["c", "d"] }, { fold: ["e", "f", "g", "h"] }],
    }).ok,
    true,
  );
});

test("windows can't rescan the frame for every row", () => {
  const w = (window, extra = {}) => ({
    ...stacked,
    transform: [{ window, sort: [{ field: "calls" }], ...extra }],
  });
  for (const op of ["ci0", "ci1", "median", "q1", "q3", "values"])
    assert.match(
      refusal(w([{ op, field: "calls", as: "v" }], { frame: [null, 0], ignorePeers: true })),
      new RegExp(`can't compute ${op}`),
    );
  assert.match(
    refusal(w([{ op: "max", field: "calls", as: "v" }], { frame: [-5, 5] })),
    /ignorePeers/,
  );
  assert.equal(
    checkChartSpec(
      w([{ op: "max", field: "calls", as: "v" }], { frame: [-5, 5], ignorePeers: true }),
    ).ok,
    true,
  );
  assert.equal(
    checkChartSpec(w([{ op: "mean", field: "calls", as: "v" }], { frame: [null, 0] })).ok,
    true,
  );
});

test("a tick count is a number up to 1,000, never a time interval", () => {
  const axis = (tickCount) => ({
    ...stacked,
    encoding: { ...stacked.encoding, x: { ...stacked.encoding.x, axis: { tickCount } } },
  });
  for (const tickCount of [1e9, "1e9", "millisecond", { interval: "millisecond", step: 1 }])
    assert.match(refusal(axis(tickCount)), /tick count/, JSON.stringify(tickCount));
  assert.match(refusal({ ...stacked, config: { legend: { tickCount: 5000 } } }), /tick count/);
  assert.equal(checkChartSpec(axis(8)).ok, true);
});

test("checkChartSpec never throws, however deep or strange the spec", () => {
  let predicate = "true";
  for (let i = 0; i < 10_000; i++) predicate = { and: [predicate] };
  let array = [];
  for (let i = 0; i < 10_000; i++) array = [array];
  let object = { mark: "bar" };
  for (let i = 0; i < 10_000; i++) object = { layer: [object] };
  const throwing = {
    data: { name: "calls" },
    get mark() {
      throw new Error("boom");
    },
  };
  const explosive = {
    data: { name: "calls" },
    toJSON: () => {
      throw new Error("boom");
    },
  };
  for (const spec of [
    { ...stacked, transform: [{ filter: predicate }] },
    {
      ...stacked,
      encoding: { ...stacked.encoding, x: { ...stacked.encoding.x, axis: { values: array } } },
    },
    { ...object, data: { name: "calls" } },
    throwing,
    explosive,
  ]) {
    let result;
    assert.doesNotThrow(() => (result = checkChartSpec(spec)));
    assert.equal(result.ok, false);
    assert.match(result.error, /^[A-Z].*\.$/);
  }
});

test("transforms come from an allowlist, and so do their parameters", () => {
  const t = (transform) => ({ ...stacked, transform: [transform] });
  assert.match(
    refusal(t({ sequence: { start: 0, stop: 1e9 } })),
    /can't use the sequence transform/,
  );
  assert.match(refusal(t({ graticule: true })), /can't use the graticule transform/);
  assert.match(
    refusal(t({ calculate: "1", as: "v", sneaky: true })),
    /calculate transform can't use "sneaky"/,
  );
  assert.match(
    refusal(t({ aggregate: [{ op: "values", field: "calls", as: "v" }] })),
    /out-of-range aggregate/,
  );
  assert.match(
    refusal(t({ lookup: "tool", from: { data: { url: "/x.json" }, key: "tool" } })),
    /lookup transform has an out-of-range from|URL/,
  );
  assert.equal(
    checkChartSpec(t({ window: [{ op: "ntile", param: 4, as: "q" }], sort: [{ field: "calls" }] }))
      .ok,
    true,
  );
  assert.equal(
    checkChartSpec(t({ aggregate: [{ op: "median", field: "calls", as: "m" }], groupby: ["tool"] }))
      .ok,
    true,
  );
});

test("a bin's base, divide and every other parameter are ranged", () => {
  const b = (bin) => ({
    ...stacked,
    encoding: { ...stacked.encoding, x: { field: "calls", type: "quantitative", bin } },
  });
  // Vega's bin loop never ends with a base below 2.
  assert.match(refusal(b({ base: 0.5, maxbins: 20, extent: [0, 11] })), /base is out of range/);
  assert.match(refusal(b({ base: 1 })), /base is out of range/);
  assert.match(refusal(b({ divide: [0.5] })), /divide is out of range/);
  assert.match(refusal(b({ maxbins: 20, unknown: 1 })), /bin can't use "unknown"/);
  assert.match(refusal(b({ extent: { param: "brush" } })), /extent is out of range/);
  assert.equal(checkChartSpec(b({ base: 10, divide: [5, 2], maxbins: 20, nice: true })).ok, true);
});

test("folds compose across layers, inner specs and repeats", () => {
  const two = { fold: ["a", "b"] };
  assert.match(
    refusal({ ...stacked, transform: Array.from({ length: 26 }, () => two) }),
    /folds can multiply/,
  );
  // Parent folds apply to a repeat's inner spec and to each layer.
  assert.match(
    refusal({
      data: { name: "calls" },
      transform: [two, two, two],
      repeat: ["a", "b"],
      spec: { transform: [two, two, two], mark: "bar" },
    }),
    /folds can multiply/,
  );
  assert.match(
    refusal({
      data: { name: "calls" },
      transform: [two, two],
      layer: [{ mark: "bar" }, { transform: [two, two, two, two], mark: "point" }],
    }),
    /folds can multiply/,
  );
  // A pivot makes columns, at most 100, from rows; it never multiplies rows.
  assert.equal(
    checkChartSpec({
      ...stacked,
      transform: [two, two, { pivot: "key", value: "value", limit: 100 }, two, two, two],
    }).ok,
    true,
  );
});

test("a number format pads at most 64 characters, in a spec and in an expression", () => {
  assert.match(
    refusal({
      ...stacked,
      encoding: {
        ...stacked.encoding,
        x: { ...stacked.encoding.x, axis: { format: "1000000000" } },
      },
    }),
    /pads a number to 1000000000 characters/,
  );
  assert.match(
    refusal({ ...stacked, transform: [{ calculate: "format(datum.calls, '>99999')", as: "v" }] }),
    /pads a number/,
  );
  assert.match(
    refusal({ ...stacked, transform: [{ calculate: "format(datum.calls, datum.tool)", as: "v" }] }),
    /isn't a literal string/,
  );
  assert.equal(
    checkChartSpec({
      ...stacked,
      encoding: { ...stacked.encoding, x: { ...stacked.encoding.x, axis: { format: "08,.2f" } } },
    }).ok,
    true,
  );
  assert.equal(
    checkChartSpec({
      ...stacked,
      encoding: { ...stacked.encoding, x: { ...stacked.encoding.x, axis: { format: "%b %Y" } } },
    }).ok,
    true,
  );
});

test("sizes are numbers up to 10,000, or a step", () => {
  for (const spec of [
    { ...stacked, width: 1e9 },
    { ...stacked, height: { step: 1e6 } },
    { ...stacked, width: "1e9" },
    { ...stacked, config: { view: { continuousWidth: 1e9 } } },
  ])
    assert.match(refusal(spec), /must be a number up to/, JSON.stringify(spec).slice(-60));
  assert.equal(checkChartSpec({ ...stacked, width: 600, height: { step: 24 } }).ok, true);
  assert.equal(
    checkChartSpec({ ...stacked, mark: { type: "bar", width: { band: 0.6 } } }).ok,
    true,
  );
});

test("a spec can't look up a scale by name or pass a format specifier from data", () => {
  const calc = (expr) => ({ ...stacked, transform: [{ calculate: expr, as: "v" }] });
  for (const name of ["scale", "invert", "bandwidth"]) {
    assert.equal(CHART_EXPRESSION_FUNCTIONS.has(name), false, name);
    assert.match(refusal(calc(`${name}('x', datum.calls)`)), new RegExp(`calls ${name}\\(\\)`));
  }
  for (const name of ["timeFormat", "utcFormat", "timeParse", "utcParse"]) {
    assert.match(refusal(calc(`${name}(datum.day, datum.tool)`)), /isn't a literal string/, name);
    assert.equal(checkChartSpec(calc(`${name}(datum.day, '%Y-%m-%d')`)).ok, true, name);
  }
});

test("a time unit's step and maxbins are ranged, in an encoding and a transform", () => {
  const enc = (timeUnit) => ({
    ...stacked,
    encoding: { ...stacked.encoding, x: { field: "day", type: "temporal", timeUnit } },
  });
  assert.match(
    refusal(enc({ unit: "yearmonthdate", step: 0.000001 })),
    /time unit's step is out of range/,
  );
  assert.match(
    refusal(enc({ unit: "hours", maxbins: 1e9 })),
    /time unit's maxbins is out of range/,
  );
  assert.match(refusal(enc({ unit: "hours", sneaky: 1 })), /time unit can't use "sneaky"/);
  assert.match(
    refusal({
      ...stacked,
      transform: [{ timeUnit: { unit: "hours", step: 0 }, field: "day", as: "h" }],
    }),
    /time unit's step is out of range/,
  );
  assert.match(
    refusal({
      ...stacked,
      transform: [
        { filter: { and: [{ field: "day", timeUnit: { unit: "hours", step: 0.5 }, equal: 3 }] } },
      ],
    }),
    /time unit's step is out of range/,
  );
  assert.equal(checkChartSpec(enc("yearmonth")).ok, true);
  assert.equal(checkChartSpec(enc({ unit: "hours", step: 6, utc: true })).ok, true);
});

test("names every object already has are refused, as keys and as whole strings", () => {
  for (const name of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const sentence = new RegExp(`can't use "${name}" as a name`);
    assert.match(refusal({ ...stacked, data: { name } }), sentence, `data ${name}`);
    assert.match(
      refusal({
        ...stacked,
        encoding: { ...stacked.encoding, x: { field: name, type: "quantitative" } },
      }),
      sentence,
      `field ${name}`,
    );
    assert.match(
      refusal({ ...stacked, transform: [{ fold: ["calls", name] }] }),
      sentence,
      `fold ${name}`,
    );
    assert.match(
      refusal({ ...stacked, transform: [{ calculate: "1", as: name }] }),
      sentence,
      `as ${name}`,
    );
  }
  // JSON.parse keeps "__proto__" and "toString" as own keys.
  assert.match(
    refusal(
      JSON.parse(
        '{"data":{"name":"calls"},"mark":"bar","config":{"style":{"toString":{"fill":"red"}}}}',
      ),
    ),
    /can't use "toString" as a name/,
  );
  // A bin or time unit key never reaches Object.prototype.
  assert.match(
    refusal({
      ...stacked,
      transform: [{ bin: JSON.parse('{"toString":1}'), field: "calls", as: "b" }],
    }),
    /bin can't use "toString"|can't use "toString" as a name/,
  );
  // A name that merely contains one is fine.
  assert.equal(checkChartSpec({ ...stacked, title: "toString of calls" }).ok, true);
});

test("every ExprRef and SignalRef is checked, wherever it sits", () => {
  const enc = (channel) => ({ ...stacked, encoding: { ...stacked.encoding, ...channel } });
  const leaks = ["join(['a', 'b'], '')", "length(data('calls'))", "pluck(datum, 'tool')"];
  for (const code of leaks) {
    const ref = { expr: code };
    for (const [where, spec] of [
      [
        "field predicate equal",
        { ...stacked, transform: [{ filter: { field: "tool", equal: ref } }] },
      ],
      ["field predicate lt", { ...stacked, transform: [{ filter: { field: "calls", lt: ref } }] }],
      [
        "field predicate range",
        { ...stacked, transform: [{ filter: { field: "calls", range: [0, ref] } }] },
      ],
      [
        "field predicate oneOf",
        { ...stacked, transform: [{ filter: { field: "tool", oneOf: [ref] } }] },
      ],
      [
        "condition test predicate",
        enc({
          opacity: { condition: { test: { field: "calls", gt: ref }, value: 1 }, value: 0.5 },
        }),
      ],
      ["mark property", { ...stacked, mark: { type: "bar", opacity: ref } }],
      ["encoding value", enc({ opacity: { value: ref } })],
      ["encoding datum", enc({ x2: { datum: ref } })],
      ["axis", enc({ x: { field: "calls", type: "quantitative", axis: { labelAngle: ref } } })],
      ["legend", enc({ color: { field: "client", type: "nominal", legend: { offset: ref } } })],
      [
        "scale domain",
        enc({ x: { field: "calls", type: "quantitative", scale: { domain: [0, ref] } } }),
      ],
      [
        "scale range",
        enc({ color: { field: "client", type: "nominal", scale: { range: [ref, "red"] } } }),
      ],
      ["title", { ...stacked, title: { text: "t", fontSize: ref } }],
      ["config", { ...stacked, config: { bar: { opacity: ref } } }],
      ["param value", { ...stacked, params: [{ name: "p", value: { nested: ref } }] }],
      ["signal ref", { ...stacked, mark: { type: "bar", opacity: { signal: code } } }],
    ])
      assert.match(refusal(spec), /calls (join|data|pluck)\(\)/, `${where}: ${code}`);
  }
  assert.equal(
    checkChartSpec({
      ...stacked,
      transform: [{ filter: { field: "calls", lt: { expr: "10 * 2" } } }],
    }).ok,
    true,
  );
});

test("a chart can't change on hover", () => {
  const hover = { fill: { value: "red" } };
  for (const spec of [
    { ...stacked, title: { text: "t", encode: { title: { interactive: true, hover } } } },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        x: { field: "calls", type: "quantitative", axis: { encode: { labels: { hover } } } },
      },
    },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        color: {
          field: "client",
          type: "nominal",
          legend: { encode: { symbols: { interactive: true } } },
        },
      },
    },
  ])
    assert.match(refusal(spec), /can't change on hover/);
  // Plain encode blocks still style axes.
  assert.equal(
    checkChartSpec({
      ...stacked,
      encoding: {
        ...stacked.encoding,
        x: {
          field: "calls",
          type: "quantitative",
          axis: { encode: { labels: { update: { fontWeight: { value: "bold" } } } } },
        },
      },
    }).ok,
    true,
  );
});

test("numbers in a spec are 0 or between 1e-150 and 1e150 in size, and so are bin spans", () => {
  const b = (bin) => ({
    ...stacked,
    encoding: { ...stacked.encoding, x: { field: "calls", type: "quantitative", bin } },
  });
  for (const spec of [
    { ...stacked, transform: [{ bin: { base: 2, extent: [0, 5e-324] }, field: "calls", as: "b" }] },
    b({ extent: [0, 1e-200] }),
    b({ extent: [1, 1e200] }),
    b({ step: 1e-200 }),
    b({ minstep: 1e-160 }),
    b({ anchor: 1e-300 }),
    { ...stacked, mark: { type: "bar", opacity: 1e-200 } },
    { ...stacked, transform: [{ calculate: "1", as: "v" }, { sample: 5e-324 }] },
  ])
    assert.match(
      refusal(spec),
      /number must be 0 or between|out.of.range/,
      JSON.stringify(spec).slice(0, 120),
    );
  // A span below the floor between two numbers that are each in range.
  assert.match(refusal(b({ extent: [1e-140, 1e-140 + 1e-155] })), /extent is out of range/);
  assert.equal(checkChartSpec(b({ extent: [0, 1e-100], maxbins: 1000, base: 2 })).ok, true);
  assert.equal(checkChartSpec(b({ extent: [5, 5] })).ok, true);
});

test("scale, axis and legend counts, steps and bases are ranged literals", () => {
  const x = (extra) => ({
    ...stacked,
    encoding: { ...stacked.encoding, x: { field: "calls", type: "quantitative", ...extra } },
  });
  const refused = [
    [
      x({ scale: { type: "log", base: 1e20, domain: [-2, -1], nice: false } }),
      /base must be a number from 2 to 100/,
    ],
    [x({ scale: { type: "log", base: { expr: "1e20" } } }), /base must be/],
    [x({ scale: { type: "log", base: 1 } }), /base must be/],
    [{ ...stacked, config: { scale: { base: 1000 } } }, /base must be/],
    [x({ scale: { type: "pow", exponent: 50 } }), /exponent must be/],
    [x({ scale: { type: "symlog", constant: 0 } }), /symlog constant/],
    [x({ scale: { nice: 1e9 } }), /nice must be/],
    [x({ scale: { nice: { interval: "day", step: 1e6 } } }), /nice must be/],
    [x({ scale: { bins: { step: 1 } } }), /bins must be/],
    [x({ scale: { bins: { start: 0, stop: 1e9, step: 1 } } }), /bins must be/],
    [
      x({ scale: { domain: Array.from({ length: 1001 }, (_, i) => i) } }),
      /domain can list at most/,
    ],
    [x({ axis: { values: Array.from({ length: 1001 }, (_, i) => i) } }), /values can list at most/],
    [x({ axis: { tickCount: { expr: "1e9" } } }), /tick count/],
    [{ ...stacked, config: { legend: { symbolLimit: 1e7 } } }, /symbol limit/],
    [
      {
        ...stacked,
        encoding: {
          ...stacked.encoding,
          color: {
            field: "client",
            type: "nominal",
            scale: { scheme: { name: "blues", count: 1e6 } },
          },
        },
      },
      /scheme count/,
    ],
    [x({ bin: { binned: true, step: 1, extent: [0, 10] } }), /binned chart field can't set a step/],
    [x({ axis: { labelAngle: 1e7 } }), /labelAngle must be at most 1e6/],
    [{ ...stacked, mark: { type: "bar", size: 1e9 } }, /size must be at most 1e6/],
  ];
  for (const [spec, sentence] of refused)
    assert.match(refusal(spec), sentence, JSON.stringify(spec).slice(-120));
  for (const spec of [
    x({ scale: { type: "log", base: 2, nice: true } }),
    x({ scale: { type: "pow", exponent: 0.5, nice: 10 } }),
    x({ scale: { type: "symlog", constant: 1 } }),
    x({ scale: { bins: [0, 10, 20, 50] } }),
    x({ scale: { bins: { start: 0, stop: 100, step: 10 } } }),
    x({ axis: { tickCount: 5, tickMinStep: 1, values: [0, 100, 200] } }),
    // Data values may be timestamps.
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        x: { field: "day", type: "temporal", scale: { domain: [1.7e12, 1.8e12] } },
      },
    },
    { ...stacked, encoding: { ...stacked.encoding, x: { datum: 1.7e12, type: "temporal" } } },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        opacity: { condition: { test: { field: "calls", lt: 1.7e12 }, value: 1 }, value: 0.5 },
      },
    },
    { ...stacked, params: [{ name: "start", value: 1.7e12 }] },
  ])
    assert.equal(
      checkChartSpec(spec).ok,
      true,
      `${JSON.stringify(spec).slice(-120)}: ${checkChartSpec(spec).error}`,
    );
});

test("data values may be large wherever they nest; ranged lists are written out", () => {
  const ok = (spec) => {
    const checked = checkChartSpec(spec);
    assert.equal(checked.ok, true, `${JSON.stringify(spec).slice(-120)}: ${checked.error}`);
  };
  ok({
    ...stacked,
    encoding: { ...stacked.encoding, y: { field: "day", type: "nominal", sort: [1.7e12, 1.8e12] } },
  });
  ok({ ...stacked, params: [{ name: "thresholds", value: { high: 1_000_001, when: [1.7e12] } }] });
  ok({
    ...stacked,
    encoding: {
      ...stacked.encoding,
      x: { field: "day", type: "temporal", scale: { domain: [1.7e12, 1.8e12] } },
    },
  });
  ok({
    ...stacked,
    encoding: { ...stacked.encoding, x: { datum: { year: 2024 }, type: "temporal" } },
  });
  ok({ ...stacked, transform: [{ filter: { field: "year", oneOf: [2023, 2024] } }] });
  ok({
    ...stacked,
    encoding: {
      ...stacked.encoding,
      opacity: { condition: { test: { field: "calls", equal: 1_000_001 }, value: 1 }, value: 0.5 },
    },
  });
  ok({
    ...stacked,
    encoding: { ...stacked.encoding, x: { datum: 1_000_001, type: "quantitative" } },
  });
  // A layout number is still at most 1e6.
  assert.match(
    refusal({ ...stacked, mark: { type: "bar", cornerRadius: 1_000_001 } }),
    /cornerRadius must be at most 1e6/,
  );
  // A ranged list is a literal list, never an expression.
  const x = (extra) => ({
    ...stacked,
    params: [{ name: "ticks", value: Array.from({ length: 1001 }, (_, i) => i) }],
    encoding: { ...stacked.encoding, x: { field: "calls", type: "quantitative", ...extra } },
  });
  assert.match(
    refusal(x({ axis: { values: { expr: "ticks" } } })),
    /values can list at most 1,000 entries, written out/,
  );
  assert.match(refusal(x({ scale: { domain: { expr: "ticks" } } })), /domain can list/);
  assert.match(refusal(x({ scale: { range: { signal: "ticks" } } })), /range can list/);
  assert.match(
    refusal(x({ scale: { domain: { unionWith: { expr: "ticks" } } } })),
    /unionWith can list/,
  );
  assert.match(refusal(x({ scale: { bins: { expr: "ticks" } } })), /bins must be/);
  ok({
    ...stacked,
    encoding: {
      ...stacked.encoding,
      color: { field: "client", type: "nominal", scale: { range: "category" } },
    },
  });
  ok({
    ...stacked,
    encoding: {
      ...stacked.encoding,
      x: { field: "calls", type: "quantitative", scale: { domain: { unionWith: [0, 100] } } },
    },
  });
});
