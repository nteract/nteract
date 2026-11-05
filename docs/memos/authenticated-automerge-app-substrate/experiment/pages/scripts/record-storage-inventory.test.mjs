import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InventoryError,
  inventory,
  main,
  parseArgs,
  parseJsonLines,
} from "./record-storage-inventory.mjs";

// Synthetic fixtures in the shapes operators collect: d1.mjs rows, raw
// /api/connect bodies, decoded host/document records and an installed canary.
const ID = {
  old: "10000000-0000-4000-8000-000000000001",
  oldProbed: "10000000-0000-4000-8000-000000000002",
  converted: "10000000-0000-4000-8000-000000000003",
  canaried: "10000000-0000-4000-8000-000000000004",
  fresh: "10000000-0000-4000-8000-000000000005",
  trashed: "10000000-0000-4000-8000-000000000006",
  cellOnly: "10000000-0000-4000-8000-000000000007",
  local: "10000000-0000-4000-8000-000000000008",
};
const PLAIN_SINCE = "2026-11-06T12:00:00.000Z";
const row = (page_id, created_at, state = "active", owner = "owner:a") => ({
  page_id,
  owner,
  state,
  created_at,
});
const D1 = [
  row(ID.old, "2026-10-01T00:00:00.000Z"),
  row(ID.oldProbed, "2026-10-02T00:00:00.000Z"),
  row(ID.converted, "2026-10-03T00:00:00.000Z"),
  row(ID.canaried, "2026-10-04T00:00:00.000Z"),
  row(ID.fresh, "2026-11-07T00:00:00.000Z", "active", "owner:b"),
  row(ID.trashed, "2026-10-05T00:00:00.000Z", "trashed"),
  row(ID.local, "2026-09-01T00:00:00.000Z"),
];
const CONNECT = [
  { page_id: ID.oldProbed, documentId: "doc", serverPeerId: "peer", canWrite: true },
  { page_id: ID.converted, documentId: "doc", recordStorage: "automerge", canWrite: true },
  { error: "Page not found", code: "not_found" },
];
const RECORDS = [
  // Captured before the conversion; the later probe shows plain.
  { pageId: ID.converted, documentId: "doc", recordStorage: "buffered" },
  {
    page_id: ID.converted,
    record: {
      pageId: ID.converted,
      recordStorage: "automerge",
      recordStorageMigratedFrom: "buffered",
      recordStorageMigratedAt: "2026-11-08T00:00:00.000Z",
    },
  },
  // A record from before recordStorage existed: synchronous local storage.
  { pageId: ID.local, documentId: "doc" },
];
const CANARY = { enabled: true, pageIds: [ID.converted, ID.canaried] };
const byId = (report) => Object.fromEntries(report.pages.map((page) => [page.page_id, page]));

test("each Page gets its storage from the strongest evidence", () => {
  const report = inventory({
    target: "pages",
    plainSince: PLAIN_SINCE,
    d1Rows: D1,
    connect: CONNECT,
    records: RECORDS,
    pageIds: [ID.cellOnly],
    canaries: [CANARY],
  });
  const pages = byId(report);
  assert.deepEqual(
    Object.fromEntries(Object.entries(pages).map(([id, page]) => [id, [page.storage, page.basis]])),
    {
      [ID.old]: ["native", "created_before_plain"],
      [ID.oldProbed]: ["native", "connect"],
      [ID.converted]: ["automerge", "connect"],
      [ID.canaried]: ["unknown", "none"],
      [ID.fresh]: ["automerge", "created_after_plain"],
      [ID.trashed]: ["native", "created_before_plain"],
      [ID.cellOnly]: ["unknown", "none"],
      [ID.local]: ["native", "record"],
    },
  );
  assert.equal(pages[ID.converted].migrated_from, "buffered");
  assert.equal(pages[ID.converted].migrated_at, "2026-11-08T00:00:00.000Z");
  assert.match(pages[ID.converted].notes.join(), /one-way/);
  assert.equal(pages[ID.local].native_kind, "local");
  assert.equal(pages[ID.oldProbed].native_kind, null);
  assert.match(pages[ID.fresh].notes.join(), /inferred/);
  assert.match(pages[ID.canaried].notes.join(), /may have converted/);
  assert.equal(pages[ID.cellOnly].in_d1, false);
  assert.deepEqual(report.counts.storage, { native: 4, automerge: 2, unknown: 2 });
  // The trashed Page is native but not a canary candidate.
  assert.equal(report.counts.active_native, 3);
  assert.deepEqual(report.inputs, { d1_rows: 7, connect: 3, records: 3, page_ids: 1, canaries: 1 });
  assert.deepEqual(
    report.issues.map(({ code }) => code),
    ["connect_unattributed", "not_in_d1"],
  );
  // Oldest first, so canaries can be picked by age.
  assert.equal(report.pages[0].page_id, ID.local);
});

test("without a plain-since time or direct evidence a Page is unknown", () => {
  const report = inventory({ d1Rows: D1 });
  assert.deepEqual(report.counts.storage, { native: 0, automerge: 0, unknown: 7 });
  assert.equal(report.plain_since, null);
});

test("a paused canary still marks its Pages: they may have converted while it ran", () => {
  const report = inventory({
    plainSince: PLAIN_SINCE,
    d1Rows: D1,
    canaries: [{ enabled: false, pageIds: [ID.canaried] }],
  });
  assert.equal(byId(report)[ID.canaried].storage, "unknown");
});

test("malformed evidence is refused, not guessed at", () => {
  for (const [evidence, pattern] of [
    [{ d1Rows: [row("not-a-uuid", "2026-10-01T00:00:00Z")] }, /lowercase Page UUID/],
    [{ d1Rows: [row(ID.old.toUpperCase().replace("0", "A"), "x")] }, /lowercase Page UUID/],
    [{ d1Rows: [row(ID.old, "2026-10-01T00:00:00Z", "gone")] }, /unknown state/],
    [{ d1Rows: [row(ID.old, "yesterday")] }, /ISO 8601/],
    [{ d1Rows: [row(ID.old, ""), row(ID.old, "")] }, /appears twice/],
    [{ d1Rows: [[ID.old]] }, /expected an object/],
    [{ connect: [{ page_id: ID.old }] }, /neither recordStorage/],
    [{ connect: [{ page_id: ID.old, recordStorage: "buffered" }] }, /neither recordStorage/],
    [{ records: [{ pageId: ID.old, recordStorage: "future" }] }, /unknown recordStorage/],
    [{ records: [{ page_id: ID.old, record: { pageId: ID.fresh } }] }, /differ/],
    [{ pageIds: ["*"] }, /lowercase Page UUID/],
    [{ canaries: [{ enabled: true, pageIds: "*" }] }, /expected \{enabled, pageIds\}/],
    [{ canaries: [{ enabled: true, pageIds: ["*"] }] }, /lowercase Page UUID/],
    [{ plainSince: "soon" }, /ISO 8601/],
  ])
    assert.throws(
      () => inventory(evidence),
      (error) => {
        assert.ok(error instanceof InventoryError);
        assert.match(error.message, pattern);
        return true;
      },
    );
});

test("JSON lines and arrays both parse; bad lines name their number", () => {
  assert.deepEqual(parseJsonLines('{"a":1}\n\n{"a":2}\n', "x"), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseJsonLines('[{"a":1}]', "x"), [{ a: 1 }]);
  assert.deepEqual(parseJsonLines("  \n", "x"), []);
  assert.throws(() => parseJsonLines('{"a":1}\nnope', "--d1"), /--d1 line 2: not JSON/);
});

test("the CLI reads only the files it is given and prints the report", () => {
  const files = {
    "pages.jsonl": D1.map((r) => JSON.stringify(r)).join("\n"),
    "connect.jsonl": CONNECT.map((r) => JSON.stringify(r)).join("\n"),
    "records.json": JSON.stringify(RECORDS),
    "ids.txt": `${ID.cellOnly}\n\n`,
    "canary.json": JSON.stringify(CANARY),
  };
  const read = (file) => {
    if (!Object.hasOwn(files, file)) throw new InventoryError(`${file}: ENOENT`);
    return files[file];
  };
  const out = [];
  const err = [];
  const io = { read, out: (line) => out.push(line), err: (line) => err.push(line) };
  const argv = [
    "--target",
    "pages",
    "--d1",
    "pages.jsonl",
    "--plain-since",
    PLAIN_SINCE,
    "--connect",
    "connect.jsonl",
    "--records",
    "records.json",
    "--page-ids",
    "ids.txt",
    "--canary",
    "canary.json",
  ];
  assert.equal(main(argv, io), 0);
  const report = JSON.parse(out[0]);
  assert.equal(report.target, "pages");
  assert.equal(report.pages.length, 8);
  assert.match(err.at(-1), /8 Pages: 4 native, 2 automerge, 2 unknown; 3 active native; 2 issues/);

  out.length = 0;
  assert.equal(main([...argv, "--only", "native", "--format", "ids"], io), 0);
  assert.deepEqual(out, [ID.local, ID.old, ID.oldProbed, ID.trashed]);

  for (const bad of [
    [],
    ["--d1"],
    ["--d1", "pages.jsonl", "--only", "subduction"],
    ["--d1", "pages.jsonl", "--format", "csv"],
    ["--d1", "pages.jsonl", "--d1", "pages.jsonl"],
    ["--d1", "pages.jsonl", "--wildcard"],
    ["--d1", "missing.jsonl"],
  ]) {
    err.length = 0;
    assert.equal(main(bad, io), 2, bad.join(" "));
    assert.ok(err.length > 0);
  }
  assert.equal(parseArgs(["--help"]).help, true);
});

test("review fixes: zoned times only, paused canaries count, canary outranks native evidence, --only lists", async () => {
  const inv = await import("./record-storage-inventory.mjs");
  const id = "11111111-1111-4111-8111-111111111111";
  const rows = [{ page_id: id, owner: "o", state: "active", created_at: "2026-11-05T10:00:00Z" }];
  for (const bad of ["2026-11-05 18:52:02.1 +0000", "2026-11-05T18:52:02", "yesterday"])
    assert.throws(
      () => inv.inventory({ target: "pages", plainSince: bad, d1Rows: rows }),
      /Z or an offset/,
    );
  const paused = inv.inventory({
    target: "pages",
    plainSince: "2026-11-05T18:52:02Z",
    d1Rows: rows,
    canaries: [{ enabled: false, pageIds: [id] }],
    connect: [{ page_id: id, serverPeerId: "peer" }],
  });
  const row = paused.pages.find((p) => p.page_id === id);
  assert.equal(row.storage, "unknown");
  assert.ok(row.notes.some((n) => /may have converted/.test(n)));
});
