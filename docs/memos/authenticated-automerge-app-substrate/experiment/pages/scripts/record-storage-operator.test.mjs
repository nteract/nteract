// ONE-SHOT MIGRATION tests: delete with record-storage-operator.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callScript, operatorConfig } from "./operator-ssh.mjs";
import { ROUTE, operatorRun, parseArgs } from "./record-storage-operator.mjs";

const id = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const cell = (n) => String(n).repeat(64);

test("arguments: one target, one mode, one scope", () => {
  const args = parseArgs(["--target", "pages", "--mode", "convert", "--all", "--max", "3"]);
  assert.equal(args.all, true);
  assert.equal(args.max, 3);
  assert.match(args.log, /^record-storage-operator-pages-convert-.*\.jsonl$/);
  assert.deepEqual(
    parseArgs(["--target", "pages", "--mode", "status", "--page-id", id(1), "--page-id", id(2)])
      .pageIds,
    [id(1), id(2)],
  );
  for (const argv of [
    ["--target", "pages", "--mode", "convert"],
    ["--target", "pages", "--mode", "convert", "--all", "--principal", "p"],
    ["--target", "pages", "--mode", "go", "--all"],
    ["--target", "pages", "--mode", "convert", "--page-id", "nope"],
    ["--target", "pages", "--mode", "convert", "--all", "--max", "0"],
    ["--mode", "convert", "--all"],
  ])
    assert.throws(() => parseArgs(argv), undefined, argv.join(" "));
});

test("the remote call goes to the record-storage operator route", () => {
  assert.match(
    callScript(operatorConfig("pages"), ROUTE),
    /127\.0\.0\.1:9481\/api\/operator\/record-storage"/,
  );
  // The content migration's default is unchanged.
  assert.match(callScript(operatorConfig("pages")), /\/api\/operator\/content-migration"/);
});

/** A target of Page cells. Each is `{ page_id, owner, state, storage,
 * refusal?, fails? }`; converting flips storage unless `fails`. */
function fakeTarget(cells, { catalogs = {}, switchOff = false } = {}) {
  const calls = [];
  const statusOf = (key) => {
    const page = cells[key];
    if (!page)
      return {
        cell_id: key,
        page_id: null,
        owner: null,
        state: "missing",
        record_storage: null,
        refusal: "missing",
      };
    const plain = page.storage === "automerge";
    return {
      cell_id: key,
      page_id: page.page_id,
      owner: page.owner,
      state: page.state,
      record_storage: page.storage,
      refusal: switchOff
        ? "switch_off"
        : plain
          ? "plain"
          : page.state === "deleted"
            ? "deleted"
            : null,
    };
  };
  const byPage = (pageId) => Object.keys(cells).find((key) => cells[key].page_id === pageId);
  return {
    calls,
    transport: {
      async cells() {
        calls.push({ action: "cells" });
        return Object.keys(cells);
      },
      async call(body) {
        calls.push(body);
        const ok = (value) => ({ status: 200, text: JSON.stringify(value) });
        switch (body.action) {
          case "accounts":
            return ok({ principals: Object.keys(catalogs), source: "d1_projection" });
          case "targets":
            return ok({
              pages: (catalogs[body.principal] ?? []).map((page_id) => ({ page_id, kind: "page" })),
            });
          case "status":
            return ok({
              cells: [
                ...(body.page_ids ?? []).map((pageId) => statusOf(byPage(pageId) ?? `x${pageId}`)),
                ...(body.cell_ids ?? []).map(statusOf),
              ],
            });
          case "convert": {
            const key = byPage(body.page_id);
            const page = cells[key];
            if (page.fails)
              return ok({
                cell_id: key,
                page_id: body.page_id,
                outcome: { result: "skipped", reason: "busy" },
                status: statusOf(key),
              });
            page.storage = "automerge";
            return ok({
              cell_id: key,
              page_id: body.page_id,
              outcome: { error: "reset" },
              status: statusOf(key),
            });
          }
          default:
            return { status: 400, text: "{}" };
        }
      },
    },
  };
}

test("status --all reads every cell, writes nothing, and lists what remains on Subduction", async () => {
  const { transport, calls } = fakeTarget(
    {
      [cell(1)]: { page_id: id(1), owner: "a", state: "active", storage: "buffered" },
      [cell(2)]: { page_id: id(2), owner: "a", state: "trashed", storage: "local" },
      [cell(3)]: { page_id: id(3), owner: "b", state: "active", storage: "automerge" },
      [cell(4)]: { page_id: id(4), owner: "b", state: "deleted", storage: "buffered" },
    },
    { catalogs: { a: [id(1), id(2)], b: [id(3), id(5)] } },
  );
  const lines = [];
  const report = await operatorRun({
    mode: "status",
    all: true,
    transport,
    log: (line) => lines.push(line),
  });
  assert.equal(report.targets, 4);
  assert.deepEqual(report.before, {
    "active/buffered": 1,
    "trashed/local": 1,
    "active/automerge": 1,
    "deleted/buffered": 1,
  });
  assert.deepEqual(
    report.remaining.map((page) => page.page_id),
    [id(1), id(2)],
  );
  // A Page a Catalog names that no cell holds.
  assert.deepEqual(report.catalog_only, [id(5)]);
  assert.ok(!calls.some((call) => call.action === "convert"));
  assert.ok(lines.length >= 3);
});

test("convert --all converts each convertible Page once, paced, and reports what remains", async () => {
  const { transport, calls } = fakeTarget({
    [cell(1)]: { page_id: id(1), owner: "a", state: "active", storage: "buffered" },
    [cell(2)]: { page_id: id(2), owner: "a", state: "trashed", storage: "local" },
    [cell(3)]: { page_id: id(3), owner: "b", state: "active", storage: "automerge" },
    [cell(4)]: { page_id: id(4), owner: "b", state: "active", storage: "buffered", fails: true },
    [cell(5)]: { page_id: id(5), owner: "b", state: "deleted", storage: "buffered" },
  });
  const sleeps = [];
  const report = await operatorRun({
    mode: "convert",
    all: true,
    transport,
    pauseMs: 7,
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(report.converted, [id(1), id(2)]);
  assert.deepEqual(
    report.failed.map((page) => page.page_id),
    [id(4)],
  );
  assert.deepEqual(
    report.remaining.map((page) => page.page_id),
    [id(4)],
  );
  assert.deepEqual(
    calls.filter((call) => call.action === "convert"),
    [
      { action: "convert", page_id: id(1), owner: "a" },
      { action: "convert", page_id: id(2), owner: "a" },
      { action: "convert", page_id: id(4), owner: "b" },
    ],
  );
  assert.deepEqual(sleeps, [7, 7]);
});

test("a canary converts at most --max Pages; a principal's run covers only its Catalog", async () => {
  const cells = {
    [cell(1)]: { page_id: id(1), owner: "a", state: "active", storage: "buffered" },
    [cell(2)]: { page_id: id(2), owner: "a", state: "active", storage: "buffered" },
    [cell(3)]: { page_id: id(3), owner: "b", state: "active", storage: "buffered" },
  };
  const canary = await operatorRun({
    mode: "convert",
    principals: ["a"],
    max: 1,
    transport: fakeTarget(cells, { catalogs: { a: [id(1), id(2)], b: [id(3)] } }).transport,
    sleep: async () => {},
  });
  assert.deepEqual(canary.converted, [id(1)]);
  assert.deepEqual(
    canary.remaining.map((page) => page.page_id),
    [id(2)],
  );
  assert.equal(canary.not_converted[0].refusal, "max_reached");
  assert.equal(cells[cell(3)].storage, "buffered");
  const listed = await operatorRun({
    mode: "convert",
    pageIds: [id(3)],
    transport: fakeTarget(cells).transport,
    sleep: async () => {},
  });
  assert.deepEqual(listed.converted, [id(3)]);
});

test("convert stops before writing when the target lacks the plain switch", async () => {
  const { transport, calls } = fakeTarget(
    { [cell(1)]: { page_id: id(1), owner: "a", state: "active", storage: "buffered" } },
    { switchOff: true },
  );
  await assert.rejects(operatorRun({ mode: "convert", all: true, transport }), (error) => {
    assert.match(error.message, /PAGES_RECORD_STORAGE=automerge/);
    assert.equal(error.report.targets, 1);
    return true;
  });
  assert.ok(!calls.some((call) => call.action === "convert"));
});
