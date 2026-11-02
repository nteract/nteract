import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import * as pageQuota from "../worker/page-quota.mjs";
import * as shared from "../worker/quota-rule-match.mjs";
import { AUTH_D1, deploymentProfile } from "./deployment/profiles.mjs";
import {
  DEFAULT_TARGET,
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
    deleteSql(rule, [
      { match_kind: "email", match_value: rule.value, updated_at: NOW },
      { match_kind: "email", match_value: " O'Brien+X@Example.com", updated_at: 1 },
    ]),
  ];
  for (const sql of sqls) {
    assert.ok(!/o'brien/i.test(sql) && !sql.includes("it's"), sql);
    for (const [literal] of sql.replaceAll(/X'[0-9a-f]*'/g, "X").matchAll(/'[^']*'/g))
      assert.ok(fixed.has(literal), `${literal} in ${sql}`);
    // Every statement ends in ";", the last one included.
    assert.ok(sql.endsWith(";\n"), sql);
    for (const statement of sql.split(/;\n/).filter((part) => part.trim()))
      assert.ok(!statement.includes(";"), statement);
  }
  const set = setSql({ rule, limit: 251, note, now: NOW });
  assert.deepEqual(decodeHex(set), [rule.value, note, rule.value]);
  assert.match(set, /FROM pages_quota_rules WHERE match_kind = 'email' ORDER BY match_value/);
  assert.match(
    sqls.at(-1),
    new RegExp(
      `^DELETE FROM pages_quota_rules WHERE match_kind = 'email' AND \\(\\(match_value = CAST\\(X'[0-9a-f]+' AS TEXT\\) AND updated_at = ${NOW}\\) OR \\(match_value = CAST\\(X'[0-9a-f]+' AS TEXT\\) AND updated_at = 1\\)\\);\n`,
    ),
  );
  assert.throws(() => deleteSql(rule, []), TypeError);
  assert.throws(
    () => deleteSql(rule, [{ match_kind: "domain", match_value: "x.io", updated_at: 1 }]),
    TypeError,
  );
  assert.throws(
    () => deleteSql(rule, [{ match_kind: "email", match_value: rule.value, updated_at: "1" }]),
    /no integer updated_at/,
  );
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
  // The delete is fenced by updated_at: a stale fence deletes nothing.
  const stale = { match_kind: "email", match_value: rule.value, updated_at: NOW };
  assert.deepEqual(await rows(deleteSql(rule, [stale])), [
    { r: "deleted", n: 0 },
    row(0, null, NOW + 2),
  ]);
  const fresh = { ...stale, updated_at: NOW + 2 };
  assert.deepEqual(await rows(deleteSql(rule, [fresh])), [{ r: "deleted", n: 1 }]);
  assert.deepEqual(await rows(deleteSql(rule, [fresh])), [{ r: "deleted", n: 0 }]);

  // At QUOTA_RULE_LIMIT rows a new rule is refused, and an existing one still updates.
  const insert = db.sqlite.prepare(
    "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('domain', ?, 1, 1)",
  );
  for (let i = 0; i < shared.QUOTA_RULE_LIMIT; i++) insert.run(`d${i}.example`);
  assert.deepEqual(await rows(setSql({ rule, limit: 9, now: NOW })), []);
  const existing = { kind: "domain", value: "d0.example" };
  const updated = await rows(setSql({ rule: existing, limit: 9, now: NOW }));
  assert.equal(updated.length, shared.QUOTA_RULE_LIMIT);
  assert.equal(updated.find((r) => r.match_value === "d0.example").page_limit, 9);
});

// --- Arguments ----------------------------------------------------------------

test("arguments are validated before anything is built", () => {
  assert.deepEqual(parseArgs(["set", "email", " A@Example.com ", "251", "--note", "hi"]), {
    command: "set",
    target: "pages",
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
  // The default target is Pages; Page10 stays reachable with --target.
  const pages = targetConfig(DEFAULT_TARGET);
  assert.equal(DEFAULT_TARGET, "pages");
  assert.equal(pages.service, "nteract-pages-live");
  assert.equal(pages.runtime, "/opt/nteract-pages-live/celld");
  assert.equal(pages.bucket, "s3://nteract-celld-lab-621741996708/standalone/pages-live");
  assert.equal(pages.d1, AUTH_D1);
  assert.equal(pages.defaultLimit, 250);
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

test("--dry-run prints the remote command and the SQL, and writes nothing", async (t) => {
  const { out, io } = capture();
  const refuse = async () => {
    throw new Error("transport must not run");
  };
  const argv = ["--dry-run", "set", "email", "O'Brien@Example.com", "251", "--note", "it's ☕"];
  assert.equal(await main(argv, { transport: refuse, ...io }), 0);
  const text = out.join("\n");
  const args = parseArgs(argv);
  // No --target: the default target's profile builds the script.
  const defaults = targetConfig(DEFAULT_TARGET);
  assert.equal(text, dryRun(args, defaults, NOW));
  assert.ok(text.startsWith("Dry run: nothing was sent.\n"));
  assert.ok(
    text.includes(
      'Each step runs `ssh -T -o BatchMode=yes -o ConnectTimeout=20 -- lab1 "bash -c <script>"`',
    ),
  );
  assert.ok(text.includes(`The remote script:\n\n${remoteScript(defaults)}\n`));
  assert.ok(text.includes(`-- preflight\n${checkSql(args.rule).trimEnd()}`));
  assert.ok(text.includes(`-- write\n${setSql({ ...args, now: NOW }).trimEnd()}`));
  assert.ok(text.endsWith("The write runs only if the preflight passes."));
  assert.ok(!text.includes("o'brien") && !text.includes("it's"));

  const list = capture();
  assert.equal(await main(["list", "--dry-run"], { transport: refuse, ...list.io }), 0);
  assert.ok(list.out.join("\n").endsWith(`-- list\n${listSql().trimEnd()}`));

  // A delete reads its rows with the preflight, shows them, and writes nothing.
  const db = await quotaDb(t);
  db.sqlite
    .exec(`INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES
    ('domain', 'x.io', 40, ${NOW}), ('domain', ' X.IO', 3, ${NOW - 1}), ('domain', 'y.io', 9, 1)`);
  const { transport, calls } = sqliteTransport(db);
  const remove = capture();
  assert.equal(
    await main(["--dry-run", "delete", "domain", "X.io"], { transport, ...remove.io }),
    0,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0], checkSql({ kind: "domain", value: "x.io" }));
  const plan = remove.out.join("\n");
  assert.ok(
    plan.startsWith("Dry run: only the read-only preflight was sent. Nothing was written.\n"),
  );
  assert.match(
    plan,
    /The delete would remove these stored rows:\n {2}domain\t" X\.IO"\t3\t.*not canonical: the Worker reads it as x\.io; shadowed by a newer row\)\n {2}domain\t"x\.io"\t40\t[^\n(]*\n\n-- write\nDELETE FROM pages_quota_rules WHERE match_kind = 'domain' AND \(\(match_value = CAST\(X'20582e494f' AS TEXT\) AND updated_at = 1799999999999\) OR \(match_value = CAST\(X'782e696f' AS TEXT\) AND updated_at = 1800000000000\)\);/,
  );
  assert.ok(!plan.includes("y.io"));
  assert.equal(db.rows("SELECT * FROM pages_quota_rules").length, 3);

  const nothing = capture();
  assert.equal(
    await main(["--dry-run", "delete", "domain", "z.io"], { transport, ...nothing.io }),
    0,
  );
  assert.ok(
    nothing.out
      .join("\n")
      .endsWith("No domain rule for z.io is stored. The delete would send nothing."),
  );
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
    "kind\tstored value\tlimit\tupdated",
    `email\t"lead@example.com"\t0\t${new Date(NOW).toISOString()}`,
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
  assert.match(
    err.join("\n"),
    /already exists\. --create-only left it unchanged:\nemail\t"a@example\.com"\t300\t/,
  );

  // A stored row the Worker reads as the same email counts as existing.
  db.sqlite.exec(
    "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('email', ' B@Example.com', 5, 1)",
  );
  const other = capture();
  assert.equal(
    await main(["set", "email", "b@example.com", "251", "--create-only"], {
      transport,
      ...other.io,
    }),
    1,
  );
  assert.match(other.err.join("\n"), /" B@Example\.com"\t5\t.*not canonical/);
  assert.equal(calls.filter(isWrite).length, 1);
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
    /is not in s3:\/\/nteract-celld-lab-621741996708\/standalone\/pages-live\. Nothing ran\./,
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
    /request timed out[^]*does not prove nothing was written[^]*Requested state observed: the set landed\. Don't run it again\./,
  );

  // The write did not commit. The script still doesn't promise a retry is safe.
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
  const lostText = notLanded.err.join("\n");
  assert.match(
    lostText,
    /Requested state not observed\. Current state:\n {2}no email rule for a@example\.com\n/,
  );
  assert.match(lostText, /Reconcile before running anything again/);
  assert.doesNotMatch(lostText, /safe/);

  // The write committed, lost its response, and a newer change replaced it
  // before the read-back. A retry would clobber that change.
  const raced = await quotaDb(t);
  const overwritten = sqliteTransport(raced, {
    after: (result, sql) => {
      if (!isWrite(sql)) return undefined;
      raced.sqlite.exec(
        `UPDATE pages_quota_rules SET page_limit = 900, updated_at = ${NOW + 5} WHERE match_value = 'a@example.com'`,
      );
      return { code: 1, stdout: "", stderr: "Error: request timed out\n" };
    },
  });
  const replaced = capture();
  assert.equal(
    await main(["set", ...rule, "251"], { transport: overwritten.transport, ...replaced.io }),
    1,
  );
  assert.equal(overwritten.calls.filter(isWrite).length, 1);
  assert.match(
    replaced.err.join("\n"),
    /Requested state not observed\. Current state:\n {2}email\t"a@example\.com"\t900\t[^]*committed and a newer change replaced it[^]*could overwrite their change/,
  );

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
    /read-back failed too[^]*state is unknown\. Run `get email a@example.com` and reconcile/,
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
  assert.equal(removed.out[0], "Deleted the domain rule for x.io:");
  assert.match(removed.out[1], /^ {2}domain\t"x\.io"\t40\t/);
  assert.match(removed.out[2], /fall back to email rules or the default, 250\.$/);
});

test("rules stored in a noncanonical form are found, flagged and deleted", async (t) => {
  const db = await quotaDb(t);
  // Rows written by hand. The Worker reads all three as example.com, and the
  // newest valid one wins.
  db.sqlite
    .exec(`INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES
    ('domain', 'Example.COM', 0, ${NOW}),
    ('domain', ' example.com ', 7, ${NOW - 10}),
    ('domain', 'example.org', 9, 1),
    ('email', 'Lead@Example.com', 11, 1)`);
  const { transport, calls } = sqliteTransport(db);
  const env = { DB: db };
  const identity = {
    principal: "user:test:x",
    credentialKind: "api-key",
    canWrite: true,
    expiresAt: NOW + 60_000,
    verifiedEmail: "someone@example.com",
  };
  assert.deepEqual(await pageQuota.resolvePageQuota(env, identity, NOW), {
    limit: 0,
    source: "domain",
  });
  pageQuota.resetPageQuotaCache(db);

  const got = capture();
  assert.equal(await main(["get", "domain", "example.com"], { transport, ...got.io }), 0);
  assert.equal(got.out.length, 2);
  assert.match(
    got.out[0],
    /^domain\t" example\.com "\t7\t.*\(not canonical: the Worker reads it as example\.com; shadowed by a newer row\)$/,
  );
  assert.match(
    got.out[1],
    /^domain\t"Example\.COM"\t0\t.*\(not canonical: the Worker reads it as example\.com\)$/,
  );

  const listed = capture();
  assert.equal(await main(["list"], { transport, ...listed.io }), 0);
  assert.match(listed.out.join("\n"), /" example\.com "\t7\t.*shadowed by a newer row/);
  assert.match(
    listed.out.join("\n"),
    /"Lead@Example\.com"\t11\t.*not canonical: the Worker reads it as lead@example\.com\)/,
  );

  // The operator can name the rule in any spelling the Worker accepts.
  const removed = capture();
  assert.equal(await main(["delete", "domain", "Example.COM"], { transport, ...removed.io }), 0);
  assert.equal(removed.out[0], "Deleted 2 stored rows for the domain rule for example.com:");
  assert.equal(calls.filter(isWrite).length, 1);
  assert.deepEqual(
    db.rows("SELECT match_kind, match_value FROM pages_quota_rules ORDER BY match_value"),
    [
      { match_kind: "email", match_value: "Lead@Example.com" },
      { match_kind: "domain", match_value: "example.org" },
    ],
  );
  assert.deepEqual(await pageQuota.resolvePageQuota(env, identity, NOW), {
    limit: 250,
    source: "default",
  });
});

test("a row changed after the preflight survives the delete and is reported", async (t) => {
  const db = await quotaDb(t);
  db.sqlite.exec(
    `INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('domain', 'x.io', 40, ${NOW})`,
  );
  const { transport } = sqliteTransport(db, {
    before: (sql) => {
      if (isWrite(sql))
        db.sqlite.exec(
          `UPDATE pages_quota_rules SET page_limit = 80, updated_at = ${NOW + 1} WHERE match_value = 'x.io'`,
        );
    },
  });
  const { err, io } = capture();
  assert.equal(await main(["delete", "domain", "x.io"], { transport, ...io }), 1);
  assert.match(
    err.join("\n"),
    /Requested state not observed\. Current state:\n {2}domain\t"x\.io"\t80\t[^]*changed after the preflight read it[^]*Reconcile before running anything again/,
  );
  assert.equal(db.rows("SELECT page_limit FROM pages_quota_rules")[0].page_limit, 80);
});

test("set reports older rows that match the same rule", async (t) => {
  const db = await quotaDb(t);
  db.sqlite.exec(
    "INSERT INTO pages_quota_rules (match_kind, match_value, page_limit, updated_at) VALUES ('domain', 'X.IO', 3, 1)",
  );
  const { transport } = sqliteTransport(db);
  const { out, io } = capture();
  assert.equal(await main(["set", "domain", "x.io", "40"], { transport, ...io }), 0);
  assert.equal(out[0], "Set domain rule for x.io: limit 40 (was limit 3).");
  assert.match(out[1], /^domain\t"X\.IO"\t3\t.*shadowed by a newer row\)$/);
  assert.match(out[2], /^domain\t"x\.io"\t40\t[^(]*$/);
  assert.match(out[3], /no longer apply\. `delete domain x\.io` removes all of them\./);
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
  assert.match(
    out[1],
    /^domain\t"Example\.COM"\t3\t.*\(not canonical: the Worker reads it as example\.com\)$/,
  );
  assert.match(out[2], /^email\t"not an email"\t4\t.*\(never matches\)$/);
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
