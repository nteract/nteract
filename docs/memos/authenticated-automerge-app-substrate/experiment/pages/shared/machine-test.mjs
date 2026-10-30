// Exhaustive table runner for shared/machine.mjs. Node tests only.
//
// A row is { label?, note?, state, event, expect: { state, effects,
// response?, rejected? } }. runTable fails when any state × event pair has
// neither a row nor an unreachable entry, so a new state or event forces a
// decision for every pair. Tables can be JSON files (loadTable); that file is
// the contract a port to another language replays.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MachineError, defineAlphabet } from "./machine.mjs";

const TABLE_KEYS = new Set(["machine", "description", "states", "events", "unreachable", "rows"]);
const ROW_KEYS = new Set(["label", "note", "state", "event", "expect"]);

/** Read a JSON table: { machine, description?, states, events, unreachable, rows }. */
export function loadTable(file) {
  const table = JSON.parse(readFileSync(file, "utf8"));
  checkTable(table, String(file));
  return table;
}

/**
 * Check coverage, then run every row.
 *
 * `machine` comes from defineMachine, or is `{ name, states, events,
 * unreachable }` when rows drive code that has no transition function yet.
 * `table` is an array of rows or a table from loadTable. A table must name
 * this machine and repeat its states, events and unreachable pairs, so the
 * file stands on its own.
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
    rows = table.rows;
  }

  const covered = new Set();
  const conflicts = [];
  rows.forEach((row, index) => {
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
    const reason = reasonFor(row.state.name, row.event.type);
    if (reason !== undefined) conflicts.push(`${where} covers an unreachable pair (${reason})`);
    covered.add(pairKey(row.state.name, row.event.type));
  });
  if (conflicts.length > 0) assert.fail(`${spec.name}:\n  ${conflicts.join("\n  ")}`);

  const missing = [];
  let skipped = 0;
  for (const state of spec.states)
    for (const event of spec.events) {
      if (reasonFor(state, event) !== undefined) skipped++;
      else if (!covered.has(pairKey(state, event))) missing.push(`${state} × ${event}`);
    }
  if (missing.length > 0) {
    const count = `${missing.length} pair${missing.length === 1 ? "" : "s"}`;
    assert.fail(
      `${spec.name}: no row or unreachable entry for ${count}:\n  ${missing.join("\n  ")}`,
    );
  }

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
      same(actual.rejected, row.expect.rejected, "rejected");
      if ("response" in row.expect) same(actual.response, row.expect.response, "response");
    } catch (error) {
      failures.push(`${label(row, index)}: ${error.message}`);
    }
  }
  if (failures.length > 0)
    assert.fail(
      `${spec.name}: ${failures.length} of ${rows.length} rows failed\n\n${failures.join("\n\n")}`,
    );
  return { rows: rows.length, pairs: covered.size, unreachable: skipped };
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

function label(row, index) {
  const name = row?.label ?? `${row?.state?.name} × ${row?.event?.type}`;
  return `row ${index} (${name})`;
}

function pairs(entries) {
  return entries.map(([state, event]) => `${state} × ${event}`).sort();
}

function pairKey(state, event) {
  return JSON.stringify([state, event]);
}
