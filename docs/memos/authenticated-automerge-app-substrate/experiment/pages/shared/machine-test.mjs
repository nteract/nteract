// Exhaustive table runner for shared/machine.mjs. Node tests only.
//
// A row is { label?, note?, case?, state, event, expect: { state, effects,
// response?, rejected? } }. runTable fails when any state × event pair has
// neither a row nor an unreachable entry, so a new state or event forces a
// decision for every pair. Tables can be JSON files (loadTable); that file is
// the contract a port to another language replays.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MachineError, defineAlphabet } from "./machine.mjs";

const TABLE_KEYS = new Set([
  "machine",
  "description",
  "states",
  "events",
  "unreachable",
  "cases",
  "rows",
]);
const ROW_KEYS = new Set(["label", "note", "case", "state", "event", "expect"]);

/** `expect.response` value that skips the response comparison for one row.
 * In JSON: `"response": { "$ignore": true }`. */
export const IGNORE = Object.freeze({ $ignore: true });

/** Read a JSON table: { machine, description?, states, events, unreachable,
 * cases?, rows }. */
export function loadTable(file) {
  const table = JSON.parse(readFileSync(file, "utf8"));
  checkTable(table, String(file));
  return table;
}

/**
 * Check coverage, then run every row.
 *
 * `machine` comes from defineMachine, or is `{ name, states, events,
 * unreachable, cases?, validate? }` when rows drive code that has no
 * transition function yet. `table` is an array of rows or a table from
 * loadTable. A table must name this machine and repeat its states, events,
 * unreachable pairs and cases, so the file stands on its own.
 *
 * Coverage: every state × event pair needs a row or an unreachable entry. A
 * pair with declared cases needs a row for each case, and each of its rows
 * names one.
 *
 * Each row compares `state`, `effects`, `rejected` and `response` exactly,
 * including whether `rejected` and `response` are present. Use IGNORE as
 * `expect.response` to skip the response for one row.
 *
 * Options:
 * - drive(state, event): run the row through an adapter instead of
 *   machine.step. May be async. Without it, each row runs twice and must give
 *   the same result.
 * - unreachable: extra [state, event, reason] entries for this run only.
 *
 * Every run checks that the input state and event are left untouched.
 */
export async function runTable(machine, table, { drive, unreachable = [] } = {}) {
  const spec = typeof machine?.assertResult === "function" ? machine : defineAlphabet(machine);
  if (!drive && typeof spec.step !== "function")
    throw new MachineError(`${spec.name}: pass drive, or a machine from defineMachine`);
  const extra = defineAlphabet({
    name: spec.name,
    states: spec.states,
    events: spec.events,
    unreachable,
  });
  const reasonFor = (state, event) =>
    spec.unreachableReason(state, event) ?? extra.unreachableReason(state, event);

  let rows = table;
  if (!Array.isArray(table)) {
    checkTable(table, `${spec.name} table`);
    defineAlphabet({
      name: `${spec.name} table`,
      states: table.states,
      events: table.events,
      unreachable: table.unreachable,
      cases: table.cases,
    });
    const mismatch = (what) => `${spec.name}: the table's ${what} differ from the machine's`;
    assert.equal(table.machine, spec.name, `the table is for ${table.machine}, not ${spec.name}`);
    assert.deepEqual([...table.states].sort(), [...spec.states].sort(), mismatch("states"));
    assert.deepEqual([...table.events].sort(), [...spec.events].sort(), mismatch("events"));
    assert.deepEqual(
      pairs(table.unreachable),
      pairs(spec.unreachable),
      mismatch("unreachable pairs"),
    );
    assert.deepEqual(sortedCases(table.cases ?? {}), sortedCases(spec.cases), mismatch("cases"));
    rows = table.rows;
  }

  const covered = new Set();
  const coveredCases = new Set();
  const conflicts = [];
  for (let index = 0; index < rows.length; index++) {
    if (!(index in rows)) throw new MachineError(`${spec.name}: rows has a hole at ${index}`);
    const row = rows[index];
    const where = label(row, index);
    if (row === null || typeof row !== "object" || Array.isArray(row))
      throw new MachineError(`${spec.name}: ${where} must be an object`);
    for (const key of Object.keys(row))
      if (!ROW_KEYS.has(key))
        throw new MachineError(`${spec.name}: ${where} has unknown key ${key}`);
    spec.assertState(row.state, `${where} state`);
    spec.assertEvent(row.event, `${where} event`);
    if (!row.expect || !("state" in row.expect) || !("effects" in row.expect))
      throw new MachineError(`${spec.name}: ${where} expect needs state and effects`);
    spec.assertResult(row.expect);
    const { name: state } = row.state;
    const { type: event } = row.event;
    const declared = spec.casesFor(state, event);
    if (declared) {
      if (!declared.includes(row.case))
        throw new MachineError(
          `${spec.name}: ${where} needs a case from ${state}/${event}: ${declared.join(", ")}`,
        );
      coveredCases.add(`${state}/${event}/${row.case}`);
    } else if ("case" in row) {
      throw new MachineError(`${spec.name}: ${where} names a case, but ${state}/${event} has none`);
    }
    const reason = reasonFor(state, event);
    if (reason !== undefined) conflicts.push(`${where} covers an unreachable pair (${reason})`);
    covered.add(pairKey(state, event));
  }
  if (conflicts.length > 0) assert.fail(`${spec.name}:\n  ${conflicts.join("\n  ")}`);

  const missing = [];
  let skipped = 0;
  for (const state of spec.states)
    for (const event of spec.events) {
      if (reasonFor(state, event) !== undefined) skipped++;
      else if (!covered.has(pairKey(state, event))) missing.push(`${state} × ${event}`);
    }
  const missingCases = [];
  let caseCount = 0;
  for (const [key, ids] of Object.entries(spec.cases))
    for (const id of ids) {
      caseCount++;
      if (!coveredCases.has(`${key}/${id}`)) missingCases.push(`${key.replace("/", " × ")}: ${id}`);
    }
  const gaps = [];
  if (missing.length > 0)
    gaps.push(`no row or unreachable entry for ${plural(missing.length, "pair")}:`, ...missing);
  if (missingCases.length > 0)
    gaps.push(`no row for ${plural(missingCases.length, "declared case")}:`, ...missingCases);
  if (gaps.length > 0) assert.fail(`${spec.name}: ${gaps.join("\n  ")}`);

  const failures = [];
  for (const [index, row] of rows.entries()) {
    try {
      const state = structuredClone(row.state);
      const event = structuredClone(row.event);
      const actual = drive ? await drive(row.state, row.event) : spec.step(row.state, row.event);
      if (drive) spec.assertResult(actual);
      same(row.state, state, "input state was mutated");
      same(row.event, event, "input event was mutated");
      if (!drive) same(spec.step(row.state, row.event), actual, "a second step differed");
      same(actual.state, row.expect.state, "state");
      same(actual.effects, row.expect.effects, "effects");
      same(optional(actual, "rejected"), optional(row.expect, "rejected"), "rejected");
      if (!isIgnore(row.expect.response))
        same(optional(actual, "response"), optional(row.expect, "response"), "response");
    } catch (error) {
      failures.push(`${label(row, index)}: ${error.message}`);
    }
  }
  if (failures.length > 0)
    assert.fail(
      `${spec.name}: ${failures.length} of ${rows.length} rows failed\n\n${failures.join("\n\n")}`,
    );
  return { rows: rows.length, pairs: covered.size, unreachable: skipped, cases: caseCount };
}

function checkTable(table, source) {
  if (table === null || typeof table !== "object" || Array.isArray(table))
    throw new MachineError(`${source}: a table must be an object`);
  for (const key of Object.keys(table))
    if (!TABLE_KEYS.has(key)) throw new MachineError(`${source}: unknown table key ${key}`);
  if (typeof table.machine !== "string" || table.machine === "")
    throw new MachineError(`${source}: machine must name the machine`);
  for (const key of ["states", "events", "unreachable", "rows"])
    if (!Array.isArray(table[key])) throw new MachineError(`${source}: ${key} must be an array`);
}

function same(actual, expected, field) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    error.message = `${field}: ${error.message}`;
    throw error;
  }
}

// `{}` when the key is absent, so presence is compared along with the value.
function optional(result, key) {
  return key in result ? { [key]: result[key] } : {};
}

function isIgnore(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    value.$ignore === true
  );
}

function label(row, index) {
  const name = row?.label ?? `${row?.state?.name} × ${row?.event?.type}`;
  return `row ${index} (${name}${row?.case ? ` [${row.case}]` : ""})`;
}

function pairs(entries) {
  return entries.map(([state, event]) => `${state} × ${event}`).sort();
}

function sortedCases(cases) {
  return Object.fromEntries(
    Object.keys(cases)
      .sort()
      .map((key) => [key, [...cases[key]].sort()]),
  );
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function pairKey(state, event) {
  return JSON.stringify([state, event]);
}
