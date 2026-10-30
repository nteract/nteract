import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runTable } from "../shared/machine-test.mjs";
import { pageLifecycleSpec } from "./page-lifecycle.mjs";
import {
  drive,
  rowLabel,
  lostSuccess,
  STALE_KEY,
  scenario,
  suite,
} from "./page-lifecycle-drive.mjs";

test("the page-lifecycle table covers every pair and case and drives the Page host", async (t) => {
  const s = await suite(t);
  const summary = await runTable(pageLifecycleSpec, s.table, {
    drive: async (state, event) => (await drive(s, state, event)).result,
  });
  assert.deepEqual(summary, { rows: s.table.rows.length, pairs: 48, unreachable: 24, cases: 42 });
});

test("a request in a pending phase settles it first, then runs as in the settled state", async (t) => {
  const s = await suite(t);
  let checked = 0;
  for (const settle of s.table.rows.filter((row) => row.event.type === "commitOk")) {
    for (const type of ["trash", "restore", "purgePreview", "purgeConfirm"]) {
      // A preview token for a trashed Page comes from a preview, which settles.
      if (type === "purgeConfirm" && settle.expect.state.name === "trashed") continue;
      const row = s.table.rows.find(
        (candidate) =>
          candidate.event.type === type &&
          candidate.event.key !== "recorded" &&
          !candidate.event.children &&
          isDeepStrictEqual(candidate.state, settle.expect.state),
      );
      if (!row) continue;
      const { result } = await drive(s, settle.state, row.event);
      const { rejected: _rejected, ...expect } = row.expect;
      assert.deepEqual(
        result,
        { ...expect, effects: [...settle.expect.effects, ...row.expect.effects] },
        `${rowLabel(settle)} then ${rowLabel(row)}`,
      );
      checked++;
    }
  }
  assert.equal(checked, 9);
});

/** Keys whose durable values differ between two snapshots. */
function differences(actual, expected) {
  const found = [];
  for (const part of ["page", "owner", "member"]) {
    const a = new Map(actual[part]);
    const b = new Map(expected[part]);
    for (const key of new Set([...a.keys(), ...b.keys()]))
      if (!isDeepStrictEqual(a.get(key), b.get(key))) found.push(`${part} ${key}`);
  }
  if (!isDeepStrictEqual(actual.documents, expected.documents)) found.push("documents");
  for (const table of ["page", "access"])
    if (!isDeepStrictEqual(actual.index[table], expected.index[table]))
      found.push(`index ${table}`);
  return found;
}

/** Where a replayed run may differ from its uncut reference, and why:
 * - tail: the process died after the record committed, and the memory-only
 *   phase forgot the rest of the sequence. Index rows, title projections and
 *   a revoked key's retirement lag until something repeats them. Grant
 *   generations keep that key from writing meanwhile.
 * - index: a D1 write rejected. Index writes are best-effort; a failed report
 *   stores the repair marker, and listings verify rows with the Page.
 * - prune: a receipt landed but its prune did not. The store holds one
 *   receipt over the limit until the next receipt write prunes it. */
function allowance(key, run, committed) {
  const cutD1 = run.cut && run.mutations[run.cut.index]?.startsWith("d1 ");
  const tail = run.mode === "crash" && committed;
  if (key.startsWith("index ")) return cutD1 ? "index" : tail ? "tail" : undefined;
  if (key === "page host/index/report-pending") return cutD1 ? "index" : undefined;
  if (key.startsWith("page host/lifecycle/seed-")) return "prune";
  if (key.startsWith("owner page/") || key.startsWith("member shared/"))
    return tail ? "tail" : undefined;
  if (key === `page host/binding/${STALE_KEY}`) return tail ? "tail" : undefined;
  return undefined;
}

/** Problems with one cut run. Every run must restart, keep every success it
 * reported, never boot below the revision it started from, and keep active
 * and trashed records with their documents. A run restarted from written
 * storage must also replay to its reference exactly, apart from the
 * allowances above. */
function judge(run, reference, row, tally) {
  const problems = [];
  if (run.restart) return [`restart failed: ${run.restart}`];
  const lost = lostSuccess(run);
  if (lost) problems.push(`reported success lost: ${lost}`);
  const pending = ["trashing", "restoring", "purging"].includes(row.state.name);
  const floor = pending ? row.state.revision - 1 : (row.state.revision ?? 0);
  if ((run.booted.revision ?? 0) < floor) problems.push("the lifecycle revision fell back");
  const absent = row.event.type === "tombstone" && row.state.name === "trashed";
  if (!absent && ["active", "trashed"].includes(run.booted.name) && !run.document)
    problems.push(`a ${run.booted.name} record without its document`);
  if (run.view !== "written") return problems;
  const committed = isDeepStrictEqual(run.booted, reference.booted);
  const reasons = new Set();
  for (const key of differences(run.final, reference.final)) {
    const reason = allowance(key, run, committed);
    if (reason) reasons.add(reason);
    else problems.push(`replay differs at ${key}`);
  }
  for (const reason of reasons) tally[reason] = (tally[reason] ?? 0) + 1;
  return problems;
}

/** Inconsistencies the cuts find in the current host:
 * - leftover-intent boot: a creation intent beside the record is installed
 *   again, so the revision falls back.
 * - purge (trashed × purgeConfirm, purging × commitOk): the document is
 *   deleted before the record's sync.
 * - tombstone during a pending commit (trashing, restoring, purging): the
 *   tombstone does not settle the commit first.
 * - trashed × tombstone: the next tombstone does not repeat a failed write. */
const CUT_INCONSISTENCIES = [
  "active × boot [leftover-intent] uncut: the lifecycle revision fell back",
  "active × boot [leftover-intent]: the lifecycle revision fell back",
  "purging × commitOk: a trashed record without its document",
  "purging × tombstone uncut: reported success lost: told deleted, booted trashed",
  "restoring × tombstone: replay differs at index access",
  "restoring × tombstone: replay differs at index page",
  "restoring × tombstone: reported success lost: told deleted, booted trashed",
  "trashed × purgeConfirm [preview-valid]: a trashed record without its document",
  "trashed × tombstone: replay differs at index access",
  "trashed × tombstone: replay differs at index page",
  "trashed × tombstone: reported success lost: told deleted, booted trashed",
  "trashing × tombstone: replay differs at index access",
  "trashing × tombstone: replay differs at index page",
  "trashing × tombstone: replay differs at page host/document",
  "trashing × tombstone: reported success lost: told deleted, booted active",
];

test("every mutation the lifecycle makes can reject before or after it applies, and restart then replay converges", async (t) => {
  const s = await suite(t);
  const found = new Set();
  const tally = {};
  let cuts = 0;
  let runs = 0;
  for (const row of s.table.rows) {
    if (row.event.type === "commitFailed") continue;
    // A tombstone means an earlier build deleted the trashed Page's document.
    const documentAbsent = row.event.type === "tombstone" && row.state.name === "trashed";
    const modes = row.event.type === "boot" ? ["crash"] : ["crash", "retry"];
    for (const view of ["written", "synced"])
      for (const mode of modes) {
        const reference = await scenario(s, row, { view, mode, documentAbsent });
        for (const problem of judge(reference, reference, row, {}))
          found.add(`${rowLabel(row)} uncut: ${problem}`);
        if (view === "written" && mode === "crash") cuts += reference.mutations.length * 2;
        for (let index = 0; index < reference.mutations.length; index++)
          for (const outcome of ["before", "after"]) {
            runs++;
            const run = await scenario(s, row, {
              cut: { index, outcome },
              view,
              mode,
              documentAbsent,
            });
            for (const problem of judge(run, reference, row, tally))
              found.add(`${rowLabel(row)}: ${problem}`);
          }
      }
  }
  assert.deepEqual([...found].sort(), CUT_INCONSISTENCIES);
  assert.deepEqual(
    { cuts, runs, ...tally },
    { cuts: 154, runs: 576, tail: 50, prune: 20, index: 22 },
  );
});
