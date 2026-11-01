import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { pageState } from "./access.mjs";
import { runTable } from "../shared/machine-test.mjs";
import { pageLifecycle, pageLifecycleSpec } from "./page-lifecycle.mjs";
import { pageId } from "./trash-fixture.mjs";
import {
  boot,
  call,
  creationIntent,
  drive,
  host,
  readState,
  rowLabel,
  lostSuccess,
  reach,
  STALE_KEY,
  scenario,
  settle,
  suite,
  walk,
} from "./page-lifecycle-drive.mjs";

test("the page-lifecycle machine passes its table", async (t) => {
  const { table } = await suite(t);
  const summary = await runTable(pageLifecycle, table);
  assert.equal(summary.rows, table.rows.length);
});

test("the page-lifecycle table covers every pair and case and drives the Page host", async (t) => {
  const s = await suite(t);
  const summary = await runTable(pageLifecycleSpec, s.table, {
    drive: async (state, event) => (await drive(s, state, event)).result,
  });
  assert.deepEqual(summary, { rows: s.table.rows.length, pairs: 45, unreachable: 27, cases: 40 });
});

test("a request or tombstone in a pending phase settles it first, then runs as in the settled state", async (t) => {
  const s = await suite(t);
  let checked = 0;
  for (const settle of s.table.rows.filter((row) => row.event.type === "commitOk")) {
    for (const type of ["trash", "restore", "purgePreview", "purgeConfirm", "tombstone"]) {
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
  assert.equal(checked, 12);
});

test("a creation replay after Trash keeps the trashed record", async (t) => {
  const s = await suite(t);
  const h = await host(s);
  await walk(h, 1);
  // A creation whose flush failed leaves its intent beside the record.
  await h.f.storage.put("host/creation", creationIntent(h));
  const replay = await call(h, "owner", "/internal/create", {
    page_id: pageId,
    title: "Launch plan",
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(readState(h), { name: "trashed", revision: 1 });
  assert.equal(pageState(await h.f.storage.get("host/document")), "trashed");
  assert.equal(h.f.storage.values.has("host/creation"), false);
});

test("a boot logs a creation intent that disagrees with the installed record and keeps the record", async (t) => {
  const s = await suite(t);
  const h = await host(s);
  const event = {
    type: "boot",
    record: { state: "active", revision: 2 },
    creation: { state: "active", revision: 0 },
  };
  await reach(h, { name: "active", revision: 2, intent: true }, event);
  const warn = t.mock.method(console, "warn", () => {});
  await boot(h, event);
  const lines = warn.mock.calls
    .map((call) => call.arguments[0])
    .filter((line) => typeof line === "string" && line.includes("page.creation_intent_conflict"));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    service: "nteract-pages-native",
    event: "page.creation_intent_conflict",
    page_id: pageId,
    fields: ["lifecycleRevision", "acl"],
    timestamp: new Date().toISOString(),
  });
  // Field names only: no principal, role or revision value.
  assert.doesNotMatch(lines[0], /member-user|editor|"revision"/);
  assert.deepEqual(readState(h), { name: "active", revision: 2 });
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

/** Effects that follow a lifecycle commit, and the durable keys each one
 * writes. A process that dies after the commit skips them; the memory-only
 * phase forgets them, and an exact retry replays the receipt without running
 * them (https://github.com/nteract/nteract/issues/4553). */
const POST_COMMIT = {
  retireIndex: {
    name: "indexRetirement",
    writes: (key) => key.startsWith("index "),
  },
  projectTitle: {
    name: "titleProjection",
    writes: (key) =>
      key.startsWith("index ") || key.startsWith("owner page/") || key.startsWith("member shared/"),
  },
  refreshAccess: {
    name: "bindingRetirement",
    writes: (key) => key === `page host/binding/${STALE_KEY}`,
  },
};

/** Where a replayed run may differ from its uncut reference, and why:
 * - indexRetirement, titleProjection, bindingRetirement: the process died
 *   after the record committed and before that post-commit effect ran. Only
 *   the keys that effect writes may differ. Grant generations keep a revoked
 *   key from writing while its retirement is missing.
 * - index: a D1 write rejected. Index writes are best-effort; a failed report
 *   stores the repair marker, and listings verify rows with the Page.
 * - prune: a receipt landed but its prune did not. The store holds one
 *   receipt over the limit until the next receipt write prunes it. */
function allowance(key, run, row, committed) {
  const cutD1 = run.cut && run.mutations[run.cut.index]?.startsWith("d1 ");
  if (key.startsWith("index ") && cutD1) return "index";
  if (key === "page host/index/report-pending") return cutD1 ? "index" : undefined;
  if (key.startsWith("page host/lifecycle/seed-")) return "prune";
  if (run.mode !== "crash" || !committed) return undefined;
  for (const [type, effect] of Object.entries(POST_COMMIT)) {
    const owed = row.expect.effects.some((entry) => entry.type === type);
    if (owed && !run.effects.includes(type) && effect.writes(key)) return effect.name;
  }
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
    const reason = allowance(key, run, row, committed);
    if (reason) reasons.add(reason);
    else problems.push(`replay differs at ${key}`);
  }
  for (const reason of reasons) tally[reason] = (tally[reason] ?? 0) + 1;
  return problems;
}

/** Inconsistencies the cuts find in the current host. */
const CUT_INCONSISTENCIES = [];

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
    {
      // The comments document's import and delete are cut points too.
      cuts: 148,
      runs: 552,
      indexRetirement: 14,
      titleProjection: 14,
      bindingRetirement: 24,
      prune: 20,
      index: 12,
    },
  );
});

test("a tombstone whose write or sync rejected repeats its barrier on retry, so a restart boots the deletion", async (t) => {
  const s = await suite(t);
  const row = s.table.rows.find((r) => r.state.name === "trashed" && r.event.type === "tombstone");
  const options = { view: "synced", mode: "retry", documentAbsent: true };
  const reference = await scenario(s, row, options);
  assert.deepEqual(reference.mutations.slice(0, 2), ["put host/document", "sync"]);
  // The record write rejects before it lands; then the sync itself fails.
  for (const index of [0, 1]) {
    const run = await scenario(s, row, { ...options, cut: { index, outcome: "before" } });
    assert.equal(run.status, 500);
    assert.equal(run.retried, 200);
    assert.deepEqual(run.told.at(-1), { state: "deleted" });
    assert.deepEqual(run.booted, { name: "deleting", revision: 2 });
    assert.equal(run.document, false);
  }
});

/** Owner Trash, a member listing while it is trashed, then a restore through
 * the owner's Catalog. `interrupt` makes the restore's process die after its
 * record and receipt are durable and before it projects its title; the Page
 * then restarts and the client repeats the restore exactly. */
async function restoreDiscovery(t, { interrupt }) {
  const s = await suite(t);
  const h = await host(s);
  await walk(h, 0);
  const { f } = h;
  const listed = async () => {
    const response = await f.catalogCall("member", "list_pages");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.pages.some((page) => page.page_id === pageId);
  };
  assert.equal(await listed(), true, "the member lists the active Page");
  const trashed = await f.catalogCall("owner", "delete_page", {
    page_id: pageId,
    base_heads: f.heads(),
    idempotency_key: "discovery-trash",
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  await settle(h);
  assert.equal(await listed(), false, "the member's listing drops the trashed Page");
  const restore = { page_id: pageId, idempotency_key: "discovery-restore" };
  if (interrupt) {
    h.trace.start({ crash: (effect) => effect.type === "refreshAccess" });
    const failed = await f.catalogCall("owner", "restore_page", restore);
    h.trace.stop();
    assert.ok(failed.status >= 500, JSON.stringify(failed.body));
    const record = await f.storage.get("host/document");
    assert.equal(pageState(record), "active", "the restored record is durable");
    assert.ok(f.storage.values.has("host/lifecycle/discovery-restore"), "its receipt is durable");
    await boot(h, { type: "boot" }, { check: false });
  }
  const restored = await f.catalogCall("owner", "restore_page", restore);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await settle(h);
  return listed();
}

test("a member finds a restored Page", async (t) => {
  assert.equal(await restoreDiscovery(t, { interrupt: false }), true);
});

// A pending phase lives only in memory, so a restart forgets the projection a
// committed restore still owes, and an exact retry replays the receipt.
test(
  "a member finds a restored Page after a restart interrupted its title projection",
  { todo: "https://github.com/nteract/nteract/issues/4553" },
  async (t) => {
    assert.equal(await restoreDiscovery(t, { interrupt: true }), true);
  },
);
