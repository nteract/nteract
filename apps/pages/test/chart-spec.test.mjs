import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHART_EXPRESSION_FUNCTIONS,
  CHART_SPEC_LIMITS,
  checkChartSpec,
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
  assert.match(refusal(cyclic), /plain JSON/);
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

test("input controls are refused; scale and legend bindings are allowed", () => {
  const param = (bind) => ({ ...stacked, params: [{ name: "p", select: "interval", bind }] });
  assert.match(refusal(param({ input: "range", min: 0, max: 9 })), /input controls/);
  assert.match(refusal(param({ element: "#comments" })), /input controls/);
  for (const bind of ["scales", "legend", { legend: "dblclick" }])
    assert.equal(checkChartSpec(param(bind)).ok, true, JSON.stringify(bind));
});

test("expressions may call only allowlisted functions", () => {
  const calc = (calculate) => ({ ...stacked, transform: [{ calculate, as: "v" }] });
  assert.equal(checkChartSpec(calc("format(datum.calls, ',') + upper(datum.tool)")).ok, true);
  assert.equal(
    refusal(calc("modify('calls', datum)")),
    "A chart expression can't call modify() (at transform.0.calculate).",
  );
  assert.match(refusal(calc("lassoAppend(null, 1, 2)")), /can't call lassoAppend\(\)/);
  assert.match(refusal(calc("regexp ('a+')")), /can't call regexp\(\)/);
  // A function name inside a string literal is text, not a call.
  assert.equal(checkChartSpec(calc("'modify(' + datum.tool")).ok, true);
});

test("every expression position is checked", () => {
  const bad = "windowSize()";
  for (const spec of [
    { ...stacked, transform: [{ filter: bad }] },
    {
      ...stacked,
      encoding: {
        ...stacked.encoding,
        opacity: { condition: { test: bad, value: 1 }, value: 0.3 },
      },
    },
    { ...stacked, mark: { type: "bar", opacity: { expr: bad } } },
    { ...stacked, params: [{ name: "p", expr: bad }] },
    { ...stacked, config: { bar: { color: { signal: bad } } } },
  ])
    assert.match(refusal(spec), /can't call windowSize\(\)/);
  assert.equal(
    checkChartSpec({ ...stacked, transform: [{ filter: { field: "a", equal: 1 } }] }).ok,
    true,
  );
});

test("expressions can't reach prototypes", () => {
  for (const name of ["constructor", "__proto__", "prototype"])
    assert.match(
      refusal({ ...stacked, transform: [{ calculate: `datum.${name}`, as: "v" }] }),
      new RegExp(`can't use "${name}"`),
    );
});

test("the allowlist leaves out writes, lasso helpers and window geometry", () => {
  for (const name of [
    "modify",
    "lassoAppend",
    "intersectLasso",
    "windowSize",
    "containerSize",
    "warn",
  ])
    assert.equal(CHART_EXPRESSION_FUNCTIONS.has(name), false, name);
});

test("usermeta is the spec author's own and isn't checked", () => {
  assert.equal(checkChartSpec({ ...stacked, usermeta: { url: "https://x.test" } }).ok, true);
});
