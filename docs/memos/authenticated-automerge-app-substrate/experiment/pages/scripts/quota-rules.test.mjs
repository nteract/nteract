import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import * as pageQuota from "../worker/page-quota.mjs";
import * as shared from "../worker/quota-rule-match.mjs";
import { AUTH_D1, deploymentProfile } from "./deployment/profiles.mjs";
import {
  EXIT_CELL_MISSING,
  QUOTA_SCHEMA_VERSION,
  RULE_CACHE_MINUTES,
  UsageError,
  checkSql,
  cleanStderr,
  deleteSql,
  dryRun,
  getSql,
  hexText,
  listSql,
  main,
  parseArgs,
  parseLimit,
  parseRows,
  parseRule,
  remoteCommand,
  remoteScript,
  setSql,
  sshArgs,
  sshTransport,
  targetConfig,
} from "./quota-rules.mjs";

const NOW = 1_800_000_000_000;
const config = targetConfig("page10");

/** A migrated quota table in real SQLite. */
async function quotaDb(t) {
  const db = sqliteD1(t, "quota-rules-").open();
  await pageQuota.migrateQuotaRules(db);
  return db;
}

/**
 * A transport that runs the SQL as `celld d1 execute --json` would: every
 * statement in one transaction, every row as one JSON line, and on error a
 * rollback and exit 1. `before` and `after` hooks inject failures around it.
 */
function sqliteTransport(db, { before, after } = {}) {
  const calls = [];
  const transport = async (sql) => {
    calls.push(sql);
    const early = before?.(sql, calls.length);
    if (early) return early;
    const lines = [];
    let result;
    db.sqlite.exec("BEGIN");
    try {
      for (const statement of sql.split(/;\n/).filter((part) => part.trim()))
        for (const row of db.sqlite.prepare(statement).all()) lines.push(JSON.stringify(row));
      db.sqlite.exec("COMMIT");
      result = { code: 0, stdout: lines.map((line) => line + "\n").join(""), stderr: "" };
    } catch (error) {
      db.sqlite.exec("ROLLBACK");
      result = { code: 1, stdout: "", stderr: `Error: D1_EXEC_ERROR: ${error.message}\n` };
    }
    return after?.(result, sql, calls.length) ?? result;
  };
  return { transport, calls };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: { out: (line) => out.push(line), err: (line) => err.push(line), now: () => NOW },
  };
}

const isWrite = (sql) => /^(INSERT|DELETE)/m.test(sql);
const decodeHex = (sql) =>
  [...sql.matchAll(/X'([0-9a-f]*)'/g)].map(([, hex]) => Buffer.from(hex, "hex").toString("utf8"));

// --- Normalization parity ----------------------------------------------------

test("the Worker and the script share one normalization and one limit check", () => {
  for (const name of ["normalizeRuleMatch", "validPageLimit", "MAX_PAGE_QUOTA", "QUOTA_RULE_LIMIT"])
    assert.equal(pageQuota[name], shared[name], name);
  const maxVersion = Math.max(...pageQuota.QUOTA_MIGRATIONS.map((m) => m.version));
  assert.equal(QUOTA_SCHEMA_VERSION, maxVersion);
  assert.equal(RULE_CACHE_MINUTES * 60_000, pageQuota.pageQuotaBounds.rulesMs);
});

test("the script stores each value as the Worker's normalization reads it", () => {
  const inputs = [
    ["email", " RGBKRK@Gmail.com "],
    ["email", "O'Brien+Pages@Example.COM"],
    ["email", "zoë@example.com"],
    ["email", "a@b@example.com"],
    ["email", "no-at-sign.example.com"],
    ["email", "user@exämple.com"],
    ["email", "user@-bad.example.com"],
    ["email", "with space@example.com"],
    ["domain", " Anaconda.COM "],
    ["domain", "@anaconda.com"],
    ["domain", "anaconda..com"],
    ["domain", "*.anaconda.com"],
    ["domain", "exämple.com"],
    ["domain", "a".repeat(64) + ".com"],
  ];
  for (const [kind, input] of inputs) {
    const expected = pageQuota.normalizeRuleMatch(kind, input);
    if (expected === null) assert.throws(() => parseRule(kind, input), UsageError, input);
    else assert.deepEqual(parseRule(kind, input), { kind, value: expected }, input);
  }
});

test("a rule the script sets is the rule the Worker resolves", async (t) => {
  const db = await quotaDb(t);
  const { transport } = sqliteTransport(db);
  const run = (argv) => main(argv, { transport, ...capture().io });
  assert.equal(await run(["set", "email", "O'Brien+Pages@Example.COM", "251"]), 0);
  assert.equal(await run(["set", "email", "zoë@example.com", "7"]), 0);
  assert.equal(await run(["set", "domain", " Anaconda.COM ", "0"]), 0);
  const env = { DB: db };
  const identity = (verifiedEmail) => ({
    principal: `user:test:${verifiedEmail}`,
    credentialKind: "api-key",
    canWrite: true,
    expiresAt: NOW + 60_000,
    verifiedEmail,
  });
  for (const [email, expected] of [
    ["o'brien+pages@example.com", { limit: 251, source: "email" }],
    [" O'BRIEN+PAGES@EXAMPLE.COM", { limit: 251, source: "email" }],
    ["zoë@example.com", { limit: 7, source: "email" }],
    ["someone@anaconda.com", { limit: 0, source: "domain" }],
    ["someone@example.com", { limit: 250, source: "default" }],
  ])
    assert.deepEqual(await pageQuota.resolvePageQuota(env, identity(email), NOW), expected, email);
});

// --- SQL building -------------------------------------------------------------

test("values reach the SQL only as hex", (t) => {
  const tricky = [
    "o'brien@example.com",
    "note; DROP TABLE pages_quota_rules; --",
    "café ☕ 𝄞 '\"`$(x)",
    "line\nbreak\ttab\r\u0007",
    "",
  ];
  const { sqlite } = sqliteD1(t, "quota-hex-").open();
  for (const value of tricky) {
    const literal = hexText(value);
    assert.match(literal, /^CAST\(X'[0-9a-f]*' AS TEXT\)$/);
    assert.equal(sqlite.prepare(`SELECT ${literal} AS v, typeof(${literal}) AS t`).get().v, value);
    assert.equal(sqlite.prepare(`SELECT typeof(${literal}) AS t`).get().t, "text");
  }
  assert.throws(() => hexText("nul\0byte"), TypeError);
  assert.throws(() => hexText("lone \ud800 surrogate"), TypeError);
  assert.throws(() => hexText(42), TypeError);
});

test("statements carry only fixed literals, digits and hex", () => {
  const rule = { kind: "email", value: "o'brien+x@example.com" };
  const note = 'it\'s; -- "quoted" ☕';
  const fixed = new Set([
    "'email'",
    "'domain'",
    "'rule'",
    "'table'",
    "'schema'",
    "'count'",
    "'deleted'",
    "'pages_quota_rules'",
    "'pages_quota_schema'",
  ]);
  const sqls = [
    checkSql(rule),
    listSql(),
    getSql(rule),
    setSql({ rule, limit: 251, note, now: NOW }),
    setSql({ rule, limit: 0, note: null, now: NOW, createOnly: true }),
    deleteSql(rule),
  ];
  for (const sql of sqls) {
    assert.ok(!sql.includes("o'brien") && !sql.includes("it's"), sql);
    for (const [literal] of sql.replaceAll(/X'[0-9a-f]*'/g, "X").matchAll(/'[^']*'/g))
      assert.ok(fixed.has(literal), `${literal} in ${sql}`);
    // Every statement ends in ";", the last one included.
    assert.ok(sql.endsWith(";\n"), sql);
    for (const statement of sql.split(/;\n/).filter((part) => part.trim()))
      assert.ok(!statement.includes(";"), statement);
  }
  const set = setSql({ rule, limit: 251, note, now: NOW });
  assert.deepEqual(decodeHex(set), [rule.value, note, rule.value, rule.value]);
  assert.match(set, /DO UPDATE SET page_limit = excluded.page_limit/);
  assert.match(setSql({ rule, limit: 1, now: NOW, createOnly: true }), /DO NOTHING;/);
  assert.doesNotMatch(setSql({ rule, limit: 1, now: NOW, createOnly: true }), /DO UPDATE/);
  assert.match(set, new RegExp(`, 251, CAST\\(X'[0-9a-f]+' AS TEXT\\), ${NOW}\n`));
  for (const limit of [-1, 1.5, 10_001, "5", NaN])
    assert.throws(() => setSql({ rule, limit, now: NOW }), TypeError, String(limit));
  assert.throws(() => setSql({ rule, limit: 1, now: 0 }), TypeError);
  assert.throws(() => getSql({ kind: "phone", value: "x" }), TypeError);
});

test("the SQL runs on the real schema: upsert, create-only, the rule cap and delete", async (t) => {
  const db = await quotaDb(t);
  const { transport } = sqliteTransport(db);
  const rows = async (sql) => {
    const result = await transport(sql);
    assert.equal(result.code, 0, result.stderr);
    return parseRows(result.stdout);
  };
  const rule = { kind: "email", value: "o'brien@example.com" };
  const note = "café; DROP TABLE x; --";
  assert.deepEqual(await rows(checkSql(rule)), [
    { r: "table", name: "pages_quota_rules" },
    { r: "table", name: "pages_quota_schema" },
    { r: "count", n: 0 },
    { r: "schema", version: 1 },
  ]);
  const row = (limit, rowNote, updated) => ({
    r: "rule",
    match_kind: "email",
    match_value: rule.value,
    page_limit: limit,
    note: rowNote,
    updated_at: updated,
  });
  assert.deepEqual(await rows(setSql({ rule, limit: 251, note, now: NOW })), [row(251, note, NOW)]);
  assert.deepEqual(await rows(setSql({ rule, limit: 5, now: NOW + 1, createOnly: true })), [
    row(251, note, NOW),
  ]);
  assert.deepEqual(await rows(setSql({ rule, limit: 0, now: NOW + 2 })), [row(0, null, NOW + 2)]);
  assert.deepEqual(await rows(deleteSql(rule)), [{ r: "deleted", n: 1 }]);
  assert.deepEqual(await rows(deleteSql(rule)), [{ r: "deleted", n: 0 }]);

  // At QUOTA_RULE_LIMIT rows a new rule is refused, and an existing one still updates.
  const insert = db.sqlite.prepare(
    "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('domain', ?, 1, 1)",
  );
  for (let i = 0; i < shared.QUOTA_RULE_LIMIT; i++) insert.run(`d${i}.example`);
  assert.deepEqual(await rows(setSql({ rule, limit: 9, now: NOW })), []);
  const existing = { kind: "domain", value: "d0.example" };
  assert.equal((await rows(setSql({ rule: existing, limit: 9, now: NOW })))[0].page_limit, 9);
});

// --- Arguments ----------------------------------------------------------------

test("arguments are validated before anything is built", () => {
  assert.deepEqual(parseArgs(["set", "email", " A@Example.com ", "251", "--note", "hi"]), {
    command: "set",
    target: "page10",
    sshHost: undefined,
    dryRun: false,
    rule: { kind: "email", value: "a@example.com" },
    limit: 251,
    note: "hi",
    createOnly: false,
  });
  assert.deepEqual(
    parseArgs([
      "--target=page10",
      "--ssh-host",
      "root@lab1",
      "--dry-run",
      "delete",
      "domain",
      "x.io",
    ]),
    {
      command: "delete",
      target: "page10",
      sshHost: "root@lab1",
      dryRun: true,
      rule: { kind: "domain", value: "x.io" },
    },
  );
  assert.equal(
    parseArgs(["get", "email", "--", "-lead@example.com"]).rule.value,
    "-lead@example.com",
  );
  assert.equal(parseLimit("0"), 0);
  assert.equal(parseLimit("10000"), 10_000);
  for (const limit of ["-1", "1e3", "12.5", " 5", "0x10", "+5", "", "10001", "ten", undefined])
    assert.throws(() => parseLimit(limit), UsageError, String(limit));
  for (const argv of [
    [],
    ["drop"],
    ["check", "extra"],
    ["get", "email"],
    ["set", "email", "a@example.com"],
    ["set", "phone", "555", "1"],
    ["set", "email", "not an email", "1"],
    ["set", "domain", "@example.com", "1"],
    ["set", "email", "a@example.com", "-1"],
    ["set", "email", "a@example.com", "1", "--note", "x".repeat(201)],
    ["set", "email", "a@example.com", "1", "--note", "nul\0"],
    ["get", "email", "a@example.com", "--note", "x"],
    ["delete", "email", "a@example.com", "--create-only"],
    ["list", "--sql", "SELECT 1"],
    ["list", "--dry-run=yes"],
    ["list", "--target"],
  ])
    assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
  assert.equal(
    parseArgs(["set", "email", "a@example.com", "1", "--note", "☕".repeat(200)]).note.length,
    200,
  );
});

test("targets and SSH hosts come from the profile or a validated override", async () => {
  assert.equal(config.host, "lab1");
  assert.equal(config.service, "nteract-page10");
  assert.equal(config.runtime, "/opt/nteract-page10/celld");
  assert.equal(config.bucket, "s3://nteract-celld-lab-621741996708/standalone/page10");
  assert.equal(config.d1, AUTH_D1);
  assert.equal(deploymentProfile("page10").d1.database_id, "pages-next-auth");
  assert.equal(targetConfig("page10", "root@lab1").host, "root@lab1");
  for (const host of ["-oProxyCommand=sh", "lab1;id", "lab 1", ""])
    assert.throws(() => targetConfig("page10", host), UsageError, host);
  const { err, io } = capture();
  const refuse = async () => {
    throw new Error("transport must not run");
  };
  assert.equal(await main(["--target", "page9", "list"], { transport: refuse, ...io }), 2);
  assert.match(err.join("\n"), /page9 has no Page quotas/);
  assert.equal(await main(["--target", "nope", "list"], { transport: refuse, ...io }), 2);
  assert.equal(
    await main(["--ssh-host", "-oProxyCommand=x", "list"], { transport: refuse, ...io }),
    2,
  );
});

// --- Remote command and dry run -----------------------------------------------

test("the remote command depends only on the profile", () => {
  const command = remoteCommand(config);
  const args = sshArgs(config);
  assert.deepEqual(args.slice(0, -1), [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=20",
    "--",
    "lab1",
  ]);
  assert.equal(args.at(-1), command);
  assert.equal(remoteCommand(targetConfig("page10", "root@lab1")), command);
  const script = remoteScript(config);
  for (const expected of [
    "set -euo pipefail",
    'celld() { sudo -n -u nteract-page10 /opt/nteract-page10/celld "$@"; }',
    "grep -qxF 'celld 0.6.3'",
    `celld cell list __D1Database --bucket s3://nteract-celld-lab-621741996708/standalone/page10 --region us-east-1 --all --json`,
    `grep -qF '"scope":"${AUTH_D1.cell}"'`,
    `exit ${EXIT_CELL_MISSING}`,
    `'{"name":"quota-rules","d1_databases":[{"binding":"DB","database_name":"pages-next-auth","database_id":"pages-next-auth"}]}'`,
    'cat >"$d/stmt.sql"',
    'celld d1 execute pages-next-auth --file "$d/stmt.sql" "$d" --bucket s3://nteract-celld-lab-621741996708/standalone/page10 --region us-east-1 --json',
  ])
    assert.ok(script.includes(expected), expected);
  // The cell check comes before stdin is read or any SQL runs.
  assert.ok(script.indexOf("cell list") < script.indexOf("cat >"));
  assert.ok(script.indexOf("cat >") < script.indexOf("d1 execute"));
});

test("--dry-run prints the remote command and the SQL, and sends nothing", async () => {
  const { out, io } = capture();
  const refuse = async () => {
    throw new Error("transport must not run");
  };
  const argv = ["--dry-run", "set", "email", "O'Brien@Example.com", "251", "--note", "it's ☕"];
  assert.equal(await main(argv, { transport: refuse, ...io }), 0);
  const text = out.join("\n");
  const args = parseArgs(argv);
  assert.equal(text, dryRun(args, config, NOW));
  assert.ok(text.startsWith("Dry run: nothing was sent.\n"));
  assert.ok(
    text.includes(
      'Each step runs `ssh -T -o BatchMode=yes -o ConnectTimeout=20 -- lab1 "bash -c <script>"`',
    ),
  );
  assert.ok(text.includes(`The remote script:\n\n${remoteScript(config)}\n`));
  assert.ok(text.includes(`-- preflight\n${checkSql(args.rule).trimEnd()}`));
  assert.ok(text.includes(`-- write\n${setSql({ ...args, now: NOW }).trimEnd()}`));
  assert.ok(text.endsWith("The write runs only if the preflight passes."));
  assert.ok(!text.includes("o'brien") && !text.includes("it's"));

  const list = capture();
  assert.equal(await main(["list", "--dry-run"], { transport: refuse, ...list.io }), 0);
  assert.ok(list.out.join("\n").endsWith(`-- list\n${listSql().trimEnd()}`));
  const remove = capture();
  assert.equal(
    await main(["--dry-run", "delete", "domain", "x.io"], { transport: refuse, ...remove.io }),
    0,
  );
  assert.match(remove.out.join("\n"), /-- preflight\n[^]*-- write\nDELETE FROM pages_quota_rules/);
});

// --- Commands over a stubbed transport ------------------------------------------

test("set preflights, writes once and reports the rule", async (t) => {
  const db = await quotaDb(t);
  const { transport, calls } = sqliteTransport(db);
  const { out, io } = capture();
  assert.equal(
    await main(["set", "email", "Lead@Example.com", "251", "--note", "test"], { transport, ...io }),
    0,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0], checkSql({ kind: "email", value: "lead@example.com" }));
  assert.ok(isWrite(calls[1]));
  assert.equal(out[0], "Set email rule for lead@example.com: limit 251 (was no rule).");
  assert.match(out.at(-1), /within 5 minutes/);

  const paused = capture();
  assert.equal(
    await main(["set", "email", "lead@example.com", "0"], { transport, ...paused.io }),
    0,
  );
  assert.equal(paused.out[0], "Set email rule for lead@example.com: limit 0 (was limit 251).");
  assert.match(paused.out.at(-1), /Limit 0 pauses Page creation/);

  const listed = capture();
  assert.equal(await main(["list"], { transport, ...listed.io }), 0);
  assert.deepEqual(listed.out, [
    "kind\tvalue\tlimit\tupdated",
    `email\tlead@example.com\t0\t${new Date(NOW).toISOString()}`,
  ]);
});

test("--create-only never replaces a rule", async (t) => {
  const db = await quotaDb(t);
  const { transport, calls } = sqliteTransport(db);
  assert.equal(
    await main(["set", "email", "a@example.com", "300"], { transport, ...capture().io }),
    0,
  );
  const { err, io } = capture();
  const before = calls.length;
  assert.equal(
    await main(["set", "email", "a@example.com", "251", "--create-only"], { transport, ...io }),
    1,
  );
  assert.equal(calls.length, before + 1, "only the preflight ran");
  assert.match(err.join("\n"), /already exists \(limit 300\)/);
});

test("nothing is written when a table or the database cell is missing", async (t) => {
  const db = sqliteD1(t, "quota-empty-").open();
  const empty = sqliteTransport(db);
  const { err, io } = capture();
  assert.equal(
    await main(["set", "email", "a@example.com", "251"], { transport: empty.transport, ...io }),
    1,
  );
  assert.equal(empty.calls.length, 1);
  assert.match(err.join("\n"), /pages_quota_rules is missing[^]*this script never does/);
  assert.deepEqual(db.rows("SELECT name FROM sqlite_master WHERE type = 'table'"), []);

  const noCell = async () => ({
    code: EXIT_CELL_MISSING,
    stdout: "",
    stderr: `<jemalloc>: noise\nquota-rules: ${AUTH_D1.cell} is not in s3://x\n`,
  });
  const cell = capture();
  assert.equal(
    await main(["delete", "email", "a@example.com"], { transport: noCell, ...cell.io }),
    1,
  );
  assert.match(
    cell.err.join("\n"),
    /is not in s3:\/\/nteract-celld-lab-621741996708\/standalone\/page10\. Nothing ran\./,
  );
});

test("after a write error the rule is read back, and the write is never re-sent", async (t) => {
  const rule = ["email", "a@example.com"];
  const failWrite = (result, sql) =>
    isWrite(sql) ? { code: 1, stdout: "", stderr: "Error: request timed out\n" } : undefined;

  // The write committed but reported an error.
  const committed = sqliteTransport(await quotaDb(t), { after: failWrite });
  const landed = capture();
  assert.equal(
    await main(["set", ...rule, "251"], { transport: committed.transport, ...landed.io }),
    0,
  );
  assert.equal(committed.calls.length, 3);
  assert.equal(committed.calls.filter(isWrite).length, 1);
  assert.equal(committed.calls[2], getSql({ kind: "email", value: "a@example.com" }));
  assert.match(
    landed.err.join("\n"),
    /request timed out[^]*does not prove nothing was written[^]*The set landed\. Don't run it again\./,
  );

  // The write did not commit.
  const lost = sqliteTransport(await quotaDb(t), {
    before: (sql) =>
      isWrite(sql) ? { code: 255, stdout: "", stderr: "Connection reset\n" } : undefined,
  });
  const notLanded = capture();
  assert.equal(
    await main(["set", ...rule, "251"], { transport: lost.transport, ...notLanded.io }),
    1,
  );
  assert.equal(lost.calls.filter(isWrite).length, 1);
  assert.match(notLanded.err.join("\n"), /did not land\. Running the same command again is safe\./);

  // A delete that committed, then the read-back itself fails.
  const db = await quotaDb(t);
  const seed = sqliteTransport(db);
  await main(["set", ...rule, "251"], { transport: seed.transport, ...capture().io });
  const blind = sqliteTransport(db, {
    after: (result, sql, n) =>
      n >= 2
        ? { code: 255, stdout: "", stderr: "ssh: connect to host lab1: timed out\n" }
        : undefined,
  });
  const unknown = capture();
  assert.equal(await main(["delete", ...rule], { transport: blind.transport, ...unknown.io }), 1);
  assert.equal(blind.calls.filter(isWrite).length, 1);
  assert.match(
    unknown.err.join("\n"),
    /read-back failed too[^]*state is unknown\. Run `get email a@example.com`/,
  );
  assert.deepEqual(db.rows("SELECT * FROM pages_quota_rules"), []);
});

test("delete and get report an absent rule without writing", async (t) => {
  const db = await quotaDb(t);
  const { transport, calls } = sqliteTransport(db);
  const gone = capture();
  assert.equal(await main(["delete", "domain", "x.io"], { transport, ...gone.io }), 0);
  assert.deepEqual(gone.out, ["No domain rule for x.io. Nothing to delete."]);
  assert.equal(calls.filter(isWrite).length, 0);
  const got = capture();
  assert.equal(await main(["get", "domain", "X.IO"], { transport, ...got.io }), 0);
  assert.deepEqual(got.out, ["No domain rule for x.io."]);

  await main(["set", "domain", "x.io", "40"], { transport, ...capture().io });
  const removed = capture();
  assert.equal(await main(["delete", "domain", "x.io"], { transport, ...removed.io }), 0);
  assert.equal(removed.out[0], "Deleted domain rule for x.io (was limit 40).");
  assert.match(removed.out[1], /fall back to email rules or the default, 250\.$/);
});

test("check reports the tables, schema version and rule count", async (t) => {
  const db = await quotaDb(t);
  const { transport } = sqliteTransport(db);
  const { out, io } = capture();
  assert.equal(await main(["check"], { transport, ...io }), 0);
  assert.deepEqual(out.slice(1), [
    `D1 pages-next-auth: ${AUTH_D1.cell}`,
    "Tables: pages_quota_rules, pages_quota_schema (schema version 1)",
    "Rules: 0 of 1000. Default limit: 250.",
  ]);
  db.sqlite.exec(
    "INSERT INTO pages_quota_schema (version, name, applied_at) VALUES (2, 'future', 'x')",
  );
  const newer = capture();
  assert.equal(await main(["set", "email", "a@example.com", "1"], { transport, ...newer.io }), 1);
  assert.match(newer.err.join("\n"), /version 2, newer than this script knows/);
});

test("list flags hand-written values the Worker reads differently", async (t) => {
  const db = await quotaDb(t);
  db.sqlite
    .exec(`INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES
    ('domain', 'Example.COM', 3, ${NOW}), ('email', 'not an email', 4, ${NOW})`);
  const { out, io } = capture();
  assert.equal(await main(["list"], { transport: sqliteTransport(db).transport, ...io }), 0);
  assert.match(out[1], /^domain\tExample\.COM\t3\t.*\(matches as example\.com\)$/);
  assert.match(out[2], /^email\tnot an email\t4\t.*\(never matches\)$/);
});

// --- SSH transport ----------------------------------------------------------------

function fakeSpawn(behave) {
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      child.killed = signal;
      setImmediate(() => child.emit("close", null, signal));
    };
    let input = "";
    child.stdin.on("data", (chunk) => (input += chunk));
    child.stdin.on("end", () => behave(child, input));
    spawned.push({ file, args, options, child });
    return child;
  };
  return { spawned, spawnImpl };
}

test("the SSH transport sends SQL on stdin to the fixed command, with no shell", async () => {
  const { spawned, spawnImpl } = fakeSpawn((child, input) => {
    child.stdout.end(`{"r":"echo","sql":${JSON.stringify(input)}}\n`);
    child.stderr.end("<jemalloc>: x\nExecuted 1 statement(s) in 0ms\n");
    setImmediate(() => child.emit("close", 0));
  });
  const send = sshTransport(config, { spawnImpl });
  const sql = getSql({ kind: "email", value: "a@example.com" });
  const result = await send(sql);
  assert.equal(result.code, 0);
  assert.deepEqual(parseRows(result.stdout), [{ r: "echo", sql }]);
  assert.equal(cleanStderr(result.stderr), "Executed 1 statement(s) in 0ms");
  assert.equal(spawned[0].file, "ssh");
  assert.deepEqual(spawned[0].args, sshArgs(config));
  assert.equal(spawned[0].options.shell, undefined);

  const failing = fakeSpawn((child) => child.emit("error", new Error("spawn ssh ENOENT")));
  const missing = await sshTransport(config, { spawnImpl: failing.spawnImpl })("SELECT 1;\n");
  assert.equal(missing.code, null);
  assert.match(missing.stderr, /ENOENT/);

  const hanging = fakeSpawn(() => {});
  const slow = await sshTransport(config, { spawnImpl: hanging.spawnImpl, timeoutMs: 10 })(
    "SELECT 1;\n",
  );
  assert.equal(slow.code, null);
  assert.equal(hanging.spawned[0].child.killed, "SIGTERM");
  assert.match(slow.stderr, /timed out/);
});
