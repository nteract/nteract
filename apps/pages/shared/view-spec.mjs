// The check a view's spec passes before the host stores it. The viewer runs
// checkChartSpec again before every draw (viewer/vega-chart.mjs); this adds
// what a stored view needs beyond a drawable chart: its `data` binding names
// exactly the data the spec reads.
import { checkChartSpec } from "./chart-spec.mjs";

/** UTF-8 bytes of a view's spec as JSON. */
export const VIEW_SPEC_MAX_BYTES = 64 * 1024;

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** A data name as a refusal prints it: its first 64 characters as a JSON
 * string, so quotes and control characters stay escaped on one line. */
export const quotedDataName = (name) => JSON.stringify(String(name).slice(0, 64));

/** The most data names one refusal lists. */
const LISTED_NAMES = 8;

/** `names` as a refusal lists them: each quoted, at most LISTED_NAMES, then
 * how many more. */
export function quotedDataNames(names) {
  const listed = names.slice(0, LISTED_NAMES).map(quotedDataName).join(", ");
  return names.length > LISTED_NAMES ? `${listed} and ${names.length - LISTED_NAMES} more` : listed;
}

/**
 * Why `data`, a view's `{ [data_name]: binding }` map, doesn't bind exactly
 * `names`, the data names its spec reads, or null.
 */
export function viewDataProblem(names, data) {
  const unbound = names.find((name) => !Object.hasOwn(data, name));
  if (unbound !== undefined)
    return `The spec reads ${quotedDataName(unbound)}, but data doesn't map it to a source.`;
  const unread = Object.keys(data).find((name) => !names.includes(name));
  if (unread !== undefined)
    return `data names ${quotedDataName(unread)}, but the spec doesn't read it.`;
  return null;
}

/**
 * Check `spec`, and, when `data` is given, that `data` binds exactly the
 * names the spec reads. Returns `{ ok: true, names }`, the data names the
 * spec reads, or `{ ok: false, error }`, one sentence saying what is wrong.
 */
export function checkViewSpec(spec, data) {
  if (!isObject(spec)) return { ok: false, error: "spec must be a JSON object." };
  let json;
  try {
    json = JSON.stringify(spec);
  } catch {
    return { ok: false, error: "spec must be plain JSON." };
  }
  if (new TextEncoder().encode(json).byteLength > VIEW_SPEC_MAX_BYTES)
    return { ok: false, error: `spec must be ${VIEW_SPEC_MAX_BYTES / 1024} KiB or smaller.` };
  // The chart check the viewer runs too: its refusal reaches the caller as
  // it is.
  const checked = checkChartSpec(spec);
  if (!checked.ok || data === undefined) return checked;
  if (!isObject(data)) return { ok: false, error: "data must map each data name to a source." };
  const problem = viewDataProblem(checked.names, data);
  return problem ? { ok: false, error: problem } : checked;
}
