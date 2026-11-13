// What a chart Worker gives up before it reads a message. The Worker runs
// with the reader's origin, so a spec that ever found a way to run code there
// would hold the reader's cookies against authenticated Pages endpoints, and
// their storage. `lockDown` keeps an allowlist: ECMAScript's own globals and
// the host globals the chart code reads. It removes every other own property
// of the Worker's global and each prototype up its chain, navigator included,
// so an API a browser adds later is gone too. `freezeScope` then freezes the
// global and its prototypes, so nothing can be put back. The Worker's own CSP
// (shared/chart-worker-csp.mjs) closes the network and code from strings a
// second time. scripts/chart-smoke.mjs records what the chart code reads in
// every engine and fails on a name off the allowlist, and tries every way out
// with each layer alone and both together. No DOM.

/** ECMAScript's own globals (ES2025), which reach no network, storage or
 * other context. `eval` is not among them: lockDown replaces it (NEUTERED). */
export const ECMASCRIPT_GLOBALS = Object.freeze([
  "globalThis",
  "Infinity",
  "NaN",
  "undefined",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Intl",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "URIError",
  "WeakMap",
  "WeakRef",
  "WeakSet",
]);

/** Host globals the chart Worker's code reads, each with why: the
 * smoke's recorder (scripts/fixtures/chart-globals-recorder.mjs) finds them
 * by drawing the chart corpus in every engine. A name the bundle starts
 * reading belongs here, with its reason, after checking it reaches no
 * network, storage or other context. */
export const WORKER_GLOBALS = Object.freeze([
  // The Worker's global, for the code that reaches it by name.
  "self",
  // Receives jobs (chart-dataflow.mjs serveCharts).
  "addEventListener",
  // Answers them.
  "postMessage",
  // Vega's and d3-timer's scheduling; vega-expression also lists them as
  // functions an expression may never call.
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  // Text measurement (chart-dataflow.mjs installTextMetrics).
  "OffscreenCanvas",
  // Arrow's UTF-8 strings, and the spec check's byte count.
  "TextDecoder",
  "TextEncoder",
  // Vega-Lite copies specs with it.
  "structuredClone",
  // d3-timer's clock.
  "performance",
  // Vega's and Vega-Lite's logger.
  "console",
]);

/** Globals the code reads but never calls, each replaced by a function that
 * throws: vega-expression puts `eval` in its set of functions an expression
 * may not call, as it loads. */
export const NEUTERED = Object.freeze(["eval"]);

/** Interface constants Chromium defines on the Worker global's prototype
 * that can't be deleted or overwritten (the old file-system API's storage
 * types). They're kept only while each holds a number. */
export const HOST_CONSTANTS = Object.freeze(["TEMPORARY", "PERSISTENT"]);

/** Every object from `target` up its prototype chain, Object.prototype
 * excluded. */
function chain(target) {
  const objects = [];
  for (
    let object = target;
    object && object !== Object.prototype;
    object = Object.getPrototypeOf(object)
  )
    objects.push(object);
  return objects;
}

const KEPT = new Set(["constructor", ...ECMASCRIPT_GLOBALS, ...WORKER_GLOBALS]);

/** Remove `key` from `object`: delete it, or overwrite it with undefined
 * when it can only be overwritten. Throws when it can be neither. */
function remove(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor.configurable) delete object[key];
  else if (descriptor.writable) object[key] = undefined;
  const left = Object.getOwnPropertyDescriptor(object, key);
  if (left && !("value" in left && left.value === undefined))
    throw new Error(`The chart Worker couldn't remove ${String(key)}.`);
}

/** Keep only the allowlist on `scope` (the Worker's global) and each
 * prototype up its chain, HOST_CONSTANTS that hold numbers aside, and
 * replace NEUTERED with throwing functions.
 * Throws, so the Worker never answers, if a name off the allowlist can't be
 * removed. */
export function lockDown(scope) {
  for (const object of chain(scope))
    for (const key of Reflect.ownKeys(object))
      if (KEPT.has(key) || NEUTERED.includes(key)) continue;
      else if (HOST_CONSTANTS.includes(key) && typeof object[key] === "number") continue;
      else remove(object, key);
  for (const name of NEUTERED) {
    const refuse = () => {
      throw new EvalError(`The chart Worker doesn't run ${name}.`);
    };
    Object.defineProperty(scope, name, { value: refuse, writable: false, configurable: false });
    for (const object of chain(scope).slice(1))
      if (Object.hasOwn(object, name)) remove(object, name);
  }
}

/** Freeze `scope` and its prototypes, so a removed name can't be put back. */
export function freezeScope(scope) {
  for (const object of chain(scope)) Object.freeze(object);
}
