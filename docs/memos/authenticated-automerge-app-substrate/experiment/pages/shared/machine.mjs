// Pure state machines over JSON data.
//
// A machine names its states and events and owns one transition function:
// `transition(state, event) -> { state, effects, response?, rejected? }`.
// States are plain objects whose `name` is one of `states`. Events and effects
// are plain objects with a `type`. Everything is JSON data, so a table of rows
// can live in a fixture file that another implementation replays.
//
// The transition never touches storage, the network, clocks or randomness. An
// interpreter at the edge runs the returned effects and feeds replies and
// timers back in as events.
//
// This module has no dependencies; the Worker, the viewer and tests share it.

export class MachineError extends Error {
  constructor(message) {
    super(message);
    this.name = "MachineError";
  }
}

const ALPHABET_KEYS = new Set(["name", "states", "events", "unreachable", "cases", "validate"]);
const VALIDATE_KEYS = new Set(["states", "events", "effects"]);
const RESULT_KEYS = new Set(["state", "effects", "response", "rejected"]);

/** A guard's answer: stay in `state`, emit nothing, and say why. `response`
 * is optional JSON for the caller (an HTTP reply, for example). */
export function reject(state, reason, options = {}) {
  const result = { state, effects: [], rejected: reason };
  if ("response" in options) result.response = options.response;
  return result;
}

/**
 * Validate a machine's names, `unreachable` list, guard cases and domain
 * validators without a transition. Tables written against existing code use
 * this shape before a transition function exists; `defineMachine` builds on it.
 *
 * - `cases: { "state/event": ["case-id", ...] }` names the guard outcomes of a
 *   pair. runTable then needs a row for each one.
 * - `validate: { states: { [name]: fn }, events: { [type]: fn }, effects:
 *   { [type]: fn } }` checks domain fields. Each fn throws to reject. Declaring
 *   `effects` also makes its keys the only effect types allowed.
 */
export function defineAlphabet(spec) {
  const name = spec?.name;
  if (typeof name !== "string" || name === "") throw new MachineError("A machine needs a name");
  const fail = (message) => {
    throw new MachineError(`${name}: ${message}`);
  };
  for (const key of Object.keys(spec)) if (!ALPHABET_KEYS.has(key)) fail(`unknown option ${key}`);
  const states = names(fail, "states", spec.states);
  const events = names(fail, "events", spec.events);
  const unreachable = spec.unreachable ?? [];
  if (!Array.isArray(unreachable)) fail("unreachable must be an array");
  const blocked = new Map();
  for (const entry of unreachable) {
    if (!Array.isArray(entry) || entry.length !== 3)
      fail("unreachable entries are [state, event, reason]");
    const [state, event, reason] = entry;
    if (!states.has(state)) fail(`unreachable names unknown state ${JSON.stringify(state)}`);
    if (!events.has(event)) fail(`unreachable names unknown event ${JSON.stringify(event)}`);
    if (typeof reason !== "string" || reason.trim() === "")
      fail(`unreachable ${state} × ${event} needs a reason`);
    const key = pairKey(state, event);
    if (blocked.has(key)) fail(`unreachable lists ${state} × ${event} twice`);
    blocked.set(key, reason);
  }
  const cases = caseMap(fail, spec.cases, states, events, blocked);
  const validate = validators(fail, spec.validate, states, events);

  function assertState(state, label = "state") {
    if (!isPlainObject(state) || typeof state.name !== "string")
      fail(`${label} must be an object with a name`);
    if (!states.has(state.name)) fail(`${label} ${JSON.stringify(state.name)} is not a state`);
    assertJson(fail, state, label);
    runValidator(fail, validate.states?.get(state.name), state, label);
  }

  function assertEvent(event, label = "event") {
    if (!isPlainObject(event) || typeof event.type !== "string")
      fail(`${label} must be an object with a type`);
    if (!events.has(event.type)) fail(`${label} ${JSON.stringify(event.type)} is not an event`);
    assertJson(fail, event, label);
    runValidator(fail, validate.events?.get(event.type), event, label);
  }

  function assertEffect(effect, label) {
    if (!isPlainObject(effect) || typeof effect.type !== "string" || effect.type === "")
      fail(`${label} must be an object with a type`);
    if (validate.effects && !validate.effects.has(effect.type))
      fail(`${label} ${JSON.stringify(effect.type)} is not a declared effect`);
    runValidator(fail, validate.effects?.get(effect.type), effect, label);
  }

  /** Check a transition result. With `input`, also require that a rejection
   * returns that same state object. */
  function assertResult(result, input) {
    if (!isPlainObject(result)) fail("a transition must return { state, effects }");
    for (const key of Object.keys(result))
      if (!RESULT_KEYS.has(key)) fail(`unexpected result key ${key}`);
    assertState(result.state, "next state");
    if (!Array.isArray(result.effects)) fail("effects must be an array");
    // The JSON check rejects holes, which forEach and for...of would skip.
    assertJson(fail, result.effects, "effects");
    for (let index = 0; index < result.effects.length; index++)
      assertEffect(result.effects[index], `effects[${index}]`);
    if ("response" in result) assertJson(fail, result.response, "response");
    if ("rejected" in result) {
      if (typeof result.rejected !== "string" || result.rejected === "")
        fail("rejected must be a reason string");
      if (result.effects.length > 0) fail("a rejection must not emit effects");
      if (input !== undefined && result.state !== input)
        fail("a rejection must return the input state");
    }
  }

  return Object.freeze({
    name,
    states: Object.freeze([...states]),
    events: Object.freeze([...events]),
    unreachable: Object.freeze(unreachable.map((entry) => Object.freeze([...entry]))),
    cases,
    /** The declared reason a pair can't happen, or undefined. */
    unreachableReason: (state, event) => blocked.get(pairKey(state, event)),
    /** The declared case ids for a pair, or undefined. */
    casesFor: (state, event) => cases[`${state}/${event}`],
    assertState,
    assertEvent,
    assertEffect,
    assertResult,
  });
}

/**
 * Define a machine:
 *
 *   defineMachine({ name, states, events, initial?, unreachable?, transition })
 *
 * `unreachable` lists `[state, event, reason]` pairs that can't happen by
 * construction. `step` throws on them instead of calling `transition`, so an
 * interpreter that reaches one has a bug, not a quiet no-op. Events that can
 * arrive but must not act (a late reply, a duplicate request) are reachable:
 * the transition answers them with `reject`.
 */
export function defineMachine(spec) {
  const { initial, transition, ...rest } = spec ?? {};
  const alphabet = defineAlphabet(rest);
  const fail = (message) => {
    throw new MachineError(`${alphabet.name}: ${message}`);
  };
  if (typeof transition !== "function") fail("transition must be a function");
  let start;
  if (initial !== undefined) {
    start = typeof initial === "string" ? { name: initial } : initial;
    alphabet.assertState(start, "initial state");
    start = deepFreeze(structuredClone(start));
  }

  function step(state, event) {
    alphabet.assertState(state);
    alphabet.assertEvent(event);
    const reason = alphabet.unreachableReason(state.name, event.type);
    if (reason !== undefined) fail(`${state.name} × ${event.type} is unreachable: ${reason}`);
    const result = transition(state, event);
    alphabet.assertResult(result, state);
    return result;
  }

  return Object.freeze({ ...alphabet, initial: start, step });
}

// State and event names can't contain "/", which separates them in case keys.
function names(fail, kind, list, { slash = false } = {}) {
  if (!Array.isArray(list) || list.length === 0) fail(`${kind} must be a non-empty array`);
  const seen = new Set();
  for (let index = 0; index < list.length; index++) {
    const item = list[index];
    if (typeof item !== "string" || item === "") fail(`${kind} must be non-empty strings`);
    if (!slash && item.includes("/")) fail(`${kind} can't contain "/": ${JSON.stringify(item)}`);
    if (seen.has(item)) fail(`${kind} lists ${JSON.stringify(item)} twice`);
    seen.add(item);
  }
  return seen;
}

function caseMap(fail, cases = {}, states, events, blocked) {
  if (!isPlainObject(cases)) fail("cases must be an object");
  const result = {};
  for (const key of Object.keys(cases).sort()) {
    const [state, event, ...rest] = key.split("/");
    if (rest.length > 0 || !states.has(state) || !events.has(event))
      fail(`cases key ${JSON.stringify(key)} must be "state/event" with known names`);
    if (blocked.has(pairKey(state, event))) fail(`cases names unreachable pair ${key}`);
    result[key] = Object.freeze([...names(fail, `cases ${key}`, cases[key], { slash: true })]);
  }
  return Object.freeze(result);
}

function validators(fail, validate = {}, states, events) {
  if (!isPlainObject(validate)) fail("validate must be an object");
  for (const key of Object.keys(validate))
    if (!VALIDATE_KEYS.has(key)) fail(`unknown validate key ${key}`);
  const table = (kind, known) => {
    if (validate[kind] === undefined) return undefined;
    if (!isPlainObject(validate[kind])) fail(`validate.${kind} must be an object`);
    const map = new Map(Object.entries(validate[kind]));
    for (const [key, check] of map) {
      if (known && !known.has(key)) fail(`validate.${kind} names unknown ${JSON.stringify(key)}`);
      if (typeof check !== "function") fail(`validate.${kind}.${key} must be a function`);
    }
    return map;
  };
  return {
    states: table("states", states),
    events: table("events", events),
    effects: table("effects"),
  };
}

function runValidator(fail, check, value, label) {
  if (!check) return;
  try {
    check(value);
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pairKey(state, event) {
  return JSON.stringify([state, event]);
}

// Plain objects from any realm: their prototype is Object.prototype or null.
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

// JSON data survives a JSON round trip unchanged: null, booleans, strings,
// finite numbers, dense arrays and plain objects, without cycles.
function assertJson(fail, value, path, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} is not a finite number`);
    return;
  }
  if (typeof value !== "object") fail(`${path} is ${typeof value}, not JSON data`);
  if (ancestors.has(value)) fail(`${path} is circular`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) fail(`${path} is a sparse array`);
      assertJson(fail, value[index], `${path}[${index}]`, ancestors);
    }
  } else if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) fail(`${path} has symbol keys`);
    for (const [key, item] of Object.entries(value))
      assertJson(fail, item, `${path}.${key}`, ancestors);
  } else {
    fail(`${path} is a ${value.constructor?.name ?? "non-plain object"}, not JSON data`);
  }
  ancestors.delete(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
