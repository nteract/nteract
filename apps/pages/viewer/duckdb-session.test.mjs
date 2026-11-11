import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parquetToArrowStream, setWasmUrl } from "@nteract/sift";
import { tableFromIPC } from "apache-arrow";
import { assetRelation, openPageEngine } from "./duckdb-engine.mjs";
import { createDuckQuerySession } from "./duckdb-session.mjs";

const require = createRequire(import.meta.url);
const duck = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));

async function database() {
  const db = await duck.createDuckDB(
    {
      mvp: { mainModule: `${dist}/duckdb-mvp.wasm`, mainWorker: "" },
      eh: { mainModule: `${dist}/duckdb-eh.wasm`, mainWorker: "" },
    },
    new duck.VoidLogger(),
    duck.NODE_RUNTIME,
  );
  await db.instantiate();
  return db;
}

// Node's fetch reads data: URLs, not file: URLs.
const siftWasm = readFileSync(require.resolve("@nteract/sift/sift.wasm"));
setWasmUrl(`data:application/wasm;base64,${siftWasm.toString("base64")}`);

const ASSET = "a".repeat(64);
let db, engine, parquet, dir;
const ctx = () => ({
  requestId: "r",
  signal: new AbortController().signal,
  budget: { maxIpcBytes: 1 << 20, maxDecodedBytes: 1 << 24 },
});
const rows = (ipc) =>
  tableFromIPC(ipc)
    .toArray()
    .map((row) => row.toJSON());
const window = (limit = 100) => ({ mode: "head", limit });
const query = (filters = [], sort = [], limit) => ({
  casts: [],
  filters,
  sort,
  window: window(limit),
});

before(async () => {
  // An unlocked database writes the fixture; the engine under test is locked.
  dir = mkdtempSync(path.join(tmpdir(), "pages-duckdb-"));
  const writer = await database();
  const file = path.join(dir, "fixture.parquet");
  writer.connect().query(`COPY (
    SELECT * FROM (VALUES
      (TIMESTAMP '2026-01-01', 'a', 3,    TRUE),
      (TIMESTAMP '2026-01-02', 'b', 1,    FALSE),
      (TIMESTAMP '2026-01-03', NULL, NULL, NULL),
      (TIMESTAMP '2026-01-04', 'c', 7,    TRUE)
    ) t(day, label, n, flag)
  ) TO '${file}' (FORMAT parquet)`);
  parquet = new Uint8Array(readFileSync(file));
  db = await database();
  engine = await openPageEngine(db);
});
after(async () => {
  await engine?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the engine reads registered sources and refuses files, URLs and settings", async () => {
  const relation = await engine.addSource(ASSET, parquet);
  assert.equal(relation, assetRelation(ASSET));
  assert.equal(await engine.addSource(ASSET, parquet), relation, "registered once");
  assert.equal(rows(await engine.run(`SELECT count(*)::INT AS n FROM "${relation}"`))[0].n, 4);
  for (const sql of [
    "SELECT * FROM read_csv('/etc/passwd')",
    `SELECT * FROM read_parquet('${path.join(dir, "fixture.parquet")}')`,
    "SELECT * FROM read_parquet('https://example.com/x.parquet')",
    `SELECT * FROM read_parquet('pages-src/../${ASSET}.parquet')`,
    "SET enable_external_access = true",
  ])
    await assert.rejects(
      engine.run(sql),
      /disabled by configuration|configuration has been locked/,
      sql,
    );
  await assert.rejects(engine.addSource("../x", parquet), /Invalid asset ID/);
});

test("filters, sort and the head window run in DuckDB; counts are for the query", async () => {
  const session = await createDuckQuerySession(engine, await engine.addSource(ASSET, parquet));
  assert.deepEqual(session.capabilities.filters.flag, ["eq", "is_null", "is_not_null"]);
  assert.ok(session.capabilities.filters.day.includes("between"));

  const all = await session.query(query([], [{ column: "n", direction: "desc" }], 2), ctx());
  assert.deepEqual(
    rows(all.ipc).map((r) => r.n),
    [7, 3],
  );
  assert.equal(all.returnedRows, 2);
  assert.deepEqual(all.matchedCount, { kind: "exact", value: 4 });
  assert.deepEqual(all.continuation, { kind: "more" });

  const jan2 = Date.UTC(2026, 0, 2);
  const range = await session.query(
    query([{ column: "day", op: "between", value: [jan2, jan2 + 86_400_000] }]),
    ctx(),
  );
  assert.deepEqual(
    rows(range.ipc).map((r) => r.label),
    ["b", null],
  );
  assert.deepEqual(range.continuation, { kind: "end" });

  // Sift's category exclusion: or(is_null, not_in) keeps nulls only when listed.
  const notIn = await session.query(
    query([{ column: "label", op: "not_in", value: ["a"] }]),
    ctx(),
  );
  assert.deepEqual(
    rows(notIn.ipc).map((r) => r.label),
    ["b", null, "c"],
  );
  const inNull = await session.query(
    query([{ column: "label", op: "in", value: ["c", null] }]),
    ctx(),
  );
  assert.deepEqual(
    rows(inNull.ipc).map((r) => r.label),
    [null, "c"],
  );
  const either = await session.query(
    query([
      {
        op: "or",
        args: [
          { column: "label", op: "contains", value: "%" },
          { column: "flag", op: "eq", value: false },
        ],
      },
    ]),
    ctx(),
  );
  assert.deepEqual(
    rows(either.ipc).map((r) => r.label),
    ["b"],
    "contains is literal, not LIKE",
  );

  assert.deepEqual(
    await session.count(query([{ column: "n", op: "gt", value: 2 }]), "exact", ctx()),
    { kind: "exact", value: 2 },
  );
});

test("a query outside the capabilities, an injected name or a closed session is refused", async () => {
  const session = await createDuckQuerySession(engine, await engine.addSource(ASSET, parquet));
  await assert.rejects(
    session.query(query([{ column: 'n" OR 1=1 --', op: "gt", value: 0 }]), ctx()),
    /n" OR 1=1/,
  );
  await assert.rejects(
    session.query(query([{ column: "flag", op: "between", value: [0, 1] }]), ctx()),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(session.query(query(), { ...ctx(), signal: aborted.signal }));
  await session.close();
  await assert.rejects(session.query(query(), ctx()), /closed/);
});

test("empty compounds hold for every row (and) or none (or)", async () => {
  const session = await createDuckQuerySession(engine, await engine.addSource(ASSET, parquet));
  const exact = async (filters) =>
    session.count(query(filters), "exact", ctx()).then((c) => c.value);
  assert.equal(await exact([{ op: "and", args: [] }]), 4);
  assert.equal(await exact([{ op: "or", args: [] }]), 0);
  assert.equal(await exact([{ op: "not", arg: { op: "or", args: [] } }]), 4);
  const page = await session.query(query([{ op: "and", args: [] }], [], 1), ctx());
  assert.deepEqual(page.matchedCount, { kind: "exact", value: 4 });
});

test("only scalar columns take pushdown; zoned and fine timestamps compare as instants", async () => {
  await engine.run(`CREATE TABLE typed AS SELECT * FROM (VALUES
    ([1, 2], [TIMESTAMP '2026-01-01'], 1.5::DECIMAL(4,1), TIMESTAMP_NS '2026-01-02 00:00:00',
     TIMESTAMPTZ '2026-01-02 00:00:00+00'),
    ([3], [], 2.5::DECIMAL(4,1), TIMESTAMP_NS '2026-01-03 00:00:00',
     TIMESTAMPTZ '2026-01-03 00:00:00+00')
  ) t(ints, days, amount, ns, zoned)`);
  const session = await createDuckQuerySession(engine, "typed");
  const { filters } = session.capabilities;
  assert.equal(filters.ints, undefined, "INTEGER[] is not numeric");
  assert.equal(filters.days, undefined, "TIMESTAMP[] is not temporal");
  assert.ok(filters.amount.includes("gt"), "DECIMAL(p,s) is numeric");
  const jan3 = Date.UTC(2026, 0, 3);
  for (const filter of [
    { column: "ns", op: "gte", value: jan3 },
    { column: "zoned", op: "gte", value: jan3 },
    { column: "zoned", op: "lt", value: jan3 },
    { column: "amount", op: "gt", value: 2 },
  ]) {
    const page = await session.query(query([filter]), ctx());
    assert.deepEqual(page.matchedCount, { kind: "exact", value: 1 }, JSON.stringify(filter));
  }
  await assert.rejects(session.query(query([{ column: "days", op: "is_null" }]), ctx()), /days/);
});

test("a closing engine takes no more work and shares one shutdown", async () => {
  const closing = await openPageEngine(await database());
  await closing.addSource(ASSET, parquet);
  const first = closing.close();
  assert.equal(closing.close(), first);
  await assert.rejects(closing.addSource(ASSET, parquet), /closed/, "cached source");
  await assert.rejects(closing.addSource("b".repeat(64), parquet), /closed/);
  await assert.rejects(closing.run("SELECT 1"), /closed/);
  await first;
});

test("an engine fed by Sift's Parquet decoder reads no files, not even registered Parquet", async () => {
  const arrowDb = await database();
  const decoded = [];
  const arrowEngine = await openPageEngine(arrowDb, {
    async toArrowStream(bytes) {
      decoded.push(bytes.byteLength);
      return parquetToArrowStream(bytes);
    },
  });
  try {
    const relation = await arrowEngine.addSource(ASSET, parquet);
    await arrowEngine.addSource(ASSET, parquet);
    assert.deepEqual(decoded, [parquet.byteLength], "decoded once");
    const session = await createDuckQuerySession(arrowEngine, relation);
    assert.ok(session.capabilities.filters.day.includes("between"), "timestamps survive");
    const page = await session.query(
      query([{ column: "n", op: "gte", value: 2 }], [{ column: "day", direction: "desc" }]),
      ctx(),
    );
    assert.deepEqual(
      rows(page.ipc).map((r) => r.label),
      ["c", "a"],
    );
    assert.deepEqual(rows(await arrowEngine.run(`SELECT count(*)::INT AS n FROM "${relation}"`)), [
      { n: 4 },
    ]);
    arrowDb.registerFileBuffer(`pages-src/${ASSET}.parquet`, parquet.slice());
    await assert.rejects(
      arrowEngine.run(`SELECT * FROM read_parquet('pages-src/${ASSET}.parquet')`),
      /disabled by configuration|parquet/i,
    );
  } finally {
    await arrowEngine.close();
  }
});
