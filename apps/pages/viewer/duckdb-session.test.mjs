import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const siftWasmPath = require.resolve("@nteract/sift/sift.wasm");
const siftWasm = readFileSync(siftWasmPath);
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
  assert.ok(!session.capabilities.sort.includes("ints"), "a list does not sort");
  assert.ok(session.capabilities.sort.includes("amount"));
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

test("timestamps keep Sift's fractional milliseconds at range boundaries", async () => {
  await engine.run(`CREATE TABLE fine AS SELECT * FROM (VALUES
    (TIMESTAMP '1970-01-01 00:00:00.0005', TIMESTAMP_NS '1970-01-01 00:00:00.0000005',
     TIMESTAMPTZ '1970-01-01 00:00:00.0005+00')
  ) t(us, ns, zoned)`);
  const session = await createDuckQuerySession(engine, "fine");
  const matched = async (filter) => (await session.count(query([filter]), "exact", ctx())).value;
  for (const [column, ms] of [
    ["us", 0.5],
    ["ns", 0.0005],
    ["zoned", 0.5],
  ]) {
    assert.equal(await matched({ column, op: "between", value: [0, 0] }), 0, column);
    assert.equal(await matched({ column, op: "between", value: [ms, ms] }), 1, column);
    assert.equal(await matched({ column, op: "gt", value: 0 }), 1, column);
  }
});

test("whole-millisecond units compare exactly past 2^53 microseconds", async () => {
  // 72057594037929 ms is 7.2e16 us: a double of the microseconds rounds it.
  const ms = 72057594037929;
  await engine.run(`CREATE TABLE units AS SELECT
    epoch_ms(${ms}::BIGINT)::TIMESTAMP_MS AS t_ms,
    epoch_ms(${ms - (ms % 1000)}::BIGINT)::TIMESTAMP_S AS t_s,
    DATE '2026-01-02' AS d`);
  const session = await createDuckQuerySession(engine, "units");
  const matched = async (filter) => (await session.count(query([filter]), "exact", ctx())).value;
  const day = Date.UTC(2026, 0, 2);
  for (const [column, value] of [
    ["t_ms", ms],
    ["t_s", ms - (ms % 1000)],
    ["d", day],
  ]) {
    assert.equal(await matched({ column, op: "between", value: [value, value] }), 1, column);
    assert.equal(await matched({ column, op: "gt", value }), 0, column);
  }
});

test("numbers: NaN never in a range, fractional bounds compare as f64, big integers exact", async () => {
  await engine.run(`CREATE TABLE nums AS SELECT * FROM (VALUES
    (1.0::DOUBLE, 3::INTEGER, 9007199254740993::BIGINT, 'Apple'),
    ('NaN'::DOUBLE, 4::INTEGER, 9007199254740992::BIGINT, 'apple'),
    (-0.0::DOUBLE, 2::INTEGER, NULL, 'Äpfel'),
    (NULL, NULL, 1::BIGINT, NULL)
  ) t(x, n, big, word)`);
  const session = await createDuckQuerySession(engine, "nums");
  const matched = async (...filters) => (await session.count(query(filters), "exact", ctx())).value;
  assert.equal(await matched({ column: "x", op: "gt", value: 0 }), 1, "NaN is not > 0");
  assert.equal(await matched({ column: "x", op: "gte", value: 0 }), 2, "-0 >= 0, NaN is not");
  assert.equal(await matched({ column: "x", op: "between", value: [-1e308, 1e308] }), 2);
  assert.equal(await matched({ column: "n", op: "between", value: [1.5, 3.5] }), 2);
  assert.equal(await matched({ column: "n", op: "lt", value: 2.5 }), 1);
  assert.equal(await matched({ column: "big", op: "eq", value: "9007199254740993" }), 1);
  assert.equal(await matched({ column: "big", op: "in", value: ["9007199254740992", "1"] }), 2);
  assert.equal(
    await matched({ column: "word", op: "contains", value: "App" }),
    1,
    "case-sensitive",
  );
  assert.equal(await matched({ column: "word", op: "contains", value: "pfel" }), 1);
});

test("a result over the byte budget keeps the batches that fit and says it stopped", async () => {
  await engine.run(
    "CREATE TABLE wide AS SELECT range::INTEGER AS i, repeat('x', 40) AS pad FROM range(100000)",
  );
  const session = await createDuckQuerySession(engine, "wide");
  const budget = { maxIpcBytes: 256 * 1024, maxDecodedBytes: 1 << 24 };
  const page = await session.query(query([], [{ column: "i", direction: "asc" }], 100000), {
    ...ctx(),
    budget,
  });
  assert.deepEqual(page.continuation, { kind: "stopped", reason: "budget" });
  assert.ok(page.ipc.byteLength <= budget.maxIpcBytes);
  assert.ok(page.returnedRows > 0 && page.returnedRows < 100000, String(page.returnedRows));
  const got = rows(page.ipc);
  assert.equal(got.length, page.returnedRows);
  assert.equal(got.at(-1).i, page.returnedRows - 1, "a prefix in order");
  assert.deepEqual(page.matchedCount, { kind: "exact", value: 100000 });
  // The cancelled result does not leak into the next query.
  assert.deepEqual(rows(await engine.run("SELECT 7 AS seven")), [{ seven: 7 }]);
});

test("work queued for an aborted request never runs", async () => {
  const aborted = new AbortController();
  const pending = engine.stream("CREATE TABLE skipped AS SELECT 1 AS one", [], {
    signal: aborted.signal,
  });
  aborted.abort();
  await assert.rejects(pending);
  assert.deepEqual(
    rows(
      await engine.run(
        "SELECT count(*)::INT AS n FROM duckdb_tables() WHERE table_name = 'skipped'",
      ),
    ),
    [{ n: 0 }],
  );
});

test("a dropped source frees its relation and can load again", async () => {
  const other = "c".repeat(64);
  const relation = await engine.addSource(other, parquet);
  await engine.dropSource(other);
  await assert.rejects(engine.run(`SELECT * FROM "${relation}"`), /does not exist/);
  await engine.dropSource(other);
  assert.equal(await engine.addSource(other, parquet), relation);
  assert.equal(rows(await engine.run(`SELECT count(*)::INT AS n FROM "${relation}"`))[0].n, 4);
});

test("the memory limit is set and locked", async () => {
  await assert.rejects(
    openPageEngine(await database(), { memoryLimit: "1GB'; SET x='" }),
    /memory limit/,
  );
  const limited = await openPageEngine(await database(), { memoryLimit: "256MB" });
  try {
    const [{ limit }] = rows(await limited.run("SELECT current_setting('memory_limit') AS limit"));
    assert.match(limit, /^2\d\d\.\d MiB$|^244\.1 MiB$/);
    await assert.rejects(limited.run("SET memory_limit = '4GB'"), /locked/);
  } finally {
    await limited.close();
  }
});

test("the predicates Sift's table sends match Sift's resident filter, row for row", async () => {
  const glue = await import(pathToFileURL(path.join(path.dirname(siftWasmPath), "sift_wasm.js")));
  await glue.default({ module_or_path: siftWasm });
  await engine.run(`CREATE TABLE gen AS SELECT * FROM (VALUES
    (0, 1.5::DOUBLE, 10::BIGINT, 'Alpha', TRUE, TIMESTAMP '1970-01-01 00:00:00.0005'),
    (1, 'NaN'::DOUBLE, 9007199254740993::BIGINT, 'alpha', FALSE, TIMESTAMP '1970-01-01 00:00:00.001'),
    (2, -0.0::DOUBLE, -3::BIGINT, 'Ünïcode', NULL, TIMESTAMP '2026-01-02 00:00:00'),
    (3, NULL, NULL, NULL, TRUE, NULL),
    (4, 0.0::DOUBLE, 3::BIGINT, '', FALSE, TIMESTAMP '1969-12-31 23:59:59.9995'),
    (5, 1e308::DOUBLE, 4::BIGINT, 'beta', TRUE, TIMESTAMP '2026-01-02 00:00:00.000001'),
    (6, -1.5::DOUBLE, 9007199254740992::BIGINT, 'Beta ', FALSE, TIMESTAMP '1970-01-01 00:00:00')
  ) t(id, x, big, word, flag, ts)`);
  const ipc = await engine.run("SELECT * FROM gen ORDER BY id");
  const handle = glue.load_ipc_bounded(ipc, 1000, 16, 1 << 24);
  const session = await createDuckQuerySession(engine, "gen");
  const index = { x: 1, big: 2, word: 3, flag: 4, ts: 5 };
  const cases = [
    [
      { column: "x", op: "between", value: [-1.5, 1.5] },
      { kind: "range", col: index.x, min: -1.5, max: 1.5 },
    ],
    [
      { column: "x", op: "between", value: [0, 0] },
      { kind: "range", col: index.x, min: 0, max: 0 },
    ],
    [
      { column: "big", op: "between", value: [-2.5, 3.5] },
      { kind: "range", col: index.big, min: -2.5, max: 3.5 },
    ],
    [
      { column: "big", op: "between", value: [9007199254740992, 9007199254740992] },
      { kind: "range", col: index.big, min: 9007199254740992, max: 9007199254740992 },
    ],
    [
      { column: "ts", op: "between", value: [0, 1] },
      { kind: "range", col: index.ts, min: 0, max: 1 },
    ],
    [
      { column: "ts", op: "between", value: [-0.0005, 0.0005] },
      { kind: "range", col: index.ts, min: -0.0005, max: 0.0005 },
    ],
    [
      { column: "word", op: "in", value: ["alpha", "Ünïcode", ""] },
      { kind: "set", col: index.word, values: ["alpha", "Ünïcode", ""] },
    ],
    [
      {
        op: "or",
        args: [
          { column: "word", op: "is_null" },
          { column: "word", op: "not_in", value: ["Alpha", "Beta "] },
        ],
      },
      { kind: "not_in", col: index.word, values: ["Alpha", "Beta "] },
    ],
    [
      { column: "flag", op: "eq", value: true },
      { kind: "boolean", col: index.flag, value: true },
    ],
    [
      { column: "flag", op: "eq", value: false },
      { kind: "boolean", col: index.flag, value: false },
    ],
  ];
  try {
    for (const [predicate, spec] of cases) {
      const sift = [...glue.store_filter_rows(handle, [spec])];
      const page = await session.query(
        query([predicate], [{ column: "id", direction: "asc" }], 100),
        ctx(),
      );
      assert.deepEqual(
        rows(page.ipc).map((r) => r.id),
        sift,
        JSON.stringify(predicate),
      );
    }
  } finally {
    glue.free(handle);
  }
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
