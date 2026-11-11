// Vega-Lite chart specs as Pages accepts them, and the checks a host or a
// viewer runs before drawing one. Plain data with no Vega import, so the
// Worker and the viewer share it.
//
// A chart reads only named data: every `data` in a spec is `{ "name": ... }`,
// and the viewer supplies the rows for each name from the Page's sources.
// No URL, no inline values and no generator, so a spec carries no numbers of
// its own and fetches nothing. The viewer's Vega loader refuses every request
// as well; these checks give the agent a clear refusal before that.

export const VEGA_LITE_MEDIA_TYPES = Object.freeze([
  "application/vnd.vegalite.v6+json",
  "application/vnd.vegalite.v5+json",
]);
export const CHART_SPEC_MAX_BYTES = 64 * 1024;

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const VIEW_ARRAYS = ["layer", "concat", "hconcat", "vconcat"];
const VIEW_OBJECTS = ["spec"];

/** Each view in a spec, the spec itself first: layers, concatenations and the
 * inner spec of a facet or repeat. */
function* views(spec) {
  if (!isObject(spec)) return;
  yield spec;
  for (const key of VIEW_ARRAYS)
    if (Array.isArray(spec[key])) for (const child of spec[key]) yield* views(child);
  for (const key of VIEW_OBJECTS) if (isObject(spec[key])) yield* views(spec[key]);
}

/** Every `data` object in a view: its own, and a lookup transform's. */
function* dataRefs(view) {
  if (view.data !== undefined) yield { path: "data", data: view.data };
  if (Array.isArray(view.transform))
    for (const [i, transform] of view.transform.entries())
      if (isObject(transform?.from) && transform.from.data !== undefined)
        yield { path: `transform/${i}/from/data`, data: transform.from.data };
}

/**
 * Check a spec's shape and data. Returns `{ sources, problems }`: the source
 * names it reads, in first-use order, and each reason it can't be drawn.
 * `problems` empty means the spec may be drawn; it says nothing about whether
 * its fields exist (see `checkFields`).
 */
export function checkChartSpec(spec) {
  const problems = [];
  const sources = [];
  if (!isObject(spec)) return { sources, problems: ["A chart spec must be a JSON object."] };
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(spec)).byteLength;
  } catch {
    return { sources, problems: ["A chart spec must be plain JSON."] };
  }
  if (bytes > CHART_SPEC_MAX_BYTES)
    problems.push(`A chart spec must be ${CHART_SPEC_MAX_BYTES / 1024} KiB or smaller.`);
  for (const view of views(spec))
    for (const { path, data } of dataRefs(view)) {
      const keys = isObject(data) ? Object.keys(data) : [];
      if (keys.length === 1 && keys[0] === "name" && typeof data.name === "string" && data.name) {
        if (!sources.includes(data.name)) sources.push(data.name);
        continue;
      }
      problems.push(
        isObject(data) && ("url" in data || "values" in data)
          ? `${path}: a chart reads only named sources, not ${"url" in data ? "a URL" : "inline values"}.`
          : `${path}: data must be {"name": "<source>"}.`,
      );
    }
  if (!sources.length) problems.push('A chart needs data: {"name": "<source>"}.');
  return { sources, problems };
}

const CHANNEL_DEF_KEYS = ["field"];
/** Encoding field names a view reads, with the channel each came from. */
function* encodingFields(view) {
  if (!isObject(view.encoding)) return;
  for (const [channel, def] of Object.entries(view.encoding))
    for (const item of Array.isArray(def) ? def : [def])
      if (isObject(item))
        for (const key of CHANNEL_DEF_KEYS)
          if (typeof item[key] === "string") yield { channel, field: item[key] };
}

/** Field names a view's transforms create. `null` when a transform creates
 * fields this check can't name (pivot, a lookup without `as`), so the view's
 * fields can't be checked. */
function transformOutputs(view) {
  const out = new Set();
  const add = (as) => {
    for (const name of Array.isArray(as) ? as : [as]) if (typeof name === "string") out.add(name);
  };
  for (const t of Array.isArray(view.transform) ? view.transform : []) {
    if (!isObject(t)) continue;
    if (t.pivot !== undefined) return null;
    if (t.lookup !== undefined) {
      if (t.as === undefined && !Array.isArray(t.from?.fields)) return null;
      add(t.as ?? t.from.fields);
      continue;
    }
    if (t.fold !== undefined) add(t.as ?? ["key", "value"]);
    else if (t.density !== undefined) add(t.as ?? ["value", "density"]);
    else if (t.quantile !== undefined) add(t.as ?? ["prob", "value"]);
    else if (t.regression !== undefined || t.loess !== undefined)
      add(t.as ?? [t.on, t.regression ?? t.loess]);
    else if (t.bin !== undefined && t.as !== undefined) {
      add(t.as);
      if (typeof t.as === "string") add(`${t.as}_end`);
    } else add(t.as);
    for (const key of ["aggregate", "joinaggregate", "window"])
      if (Array.isArray(t[key])) for (const op of t[key]) add(op?.as);
  }
  return out;
}

/**
 * Encoding fields that no source column and no earlier transform supplies.
 * `columns` maps each source name to its column names. A view's transforms
 * also apply to its layers. Returns `{ unknown, unchecked }`: each unknown
 * field with its channel, and whether some view couldn't be checked.
 */
export function checkFields(spec, columns) {
  const known = new Set(Object.values(columns).flat());
  const unknown = [];
  let unchecked = false;
  const walk = (view, inherited) => {
    if (!isObject(view)) return;
    const outputs = transformOutputs(view);
    if (outputs === null) {
      unchecked = true;
      return;
    }
    const scope = new Set([...inherited, ...outputs]);
    for (const { channel, field } of encodingFields(view)) {
      const root = field.split(".")[0];
      if (!scope.has(field) && !known.has(field) && !known.has(root) && !scope.has(root))
        unknown.push({ channel, field });
    }
    for (const key of VIEW_ARRAYS)
      if (Array.isArray(view[key])) for (const child of view[key]) walk(child, scope);
    for (const key of VIEW_OBJECTS) if (isObject(view[key])) walk(view[key], scope);
  };
  walk(spec, new Set());
  return { unknown, unchecked };
}
