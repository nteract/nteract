#!/usr/bin/env node
// Read and change Page quota rules (`pages_quota_rules` in the target's D1)
// from an operator machine. See "Changing quota rules" in DEPLOYMENT.md.
//
// The SQL is built here from validated values and sent over SSH stdin to one
// fixed remote command per target. That command runs `celld d1 execute` on the
// target's host as the service user, after checking the celld version and that
// the database's cell already exists. No argument reaches a shell or the SQL
// text: match values and notes travel as hex literals, limits as digits.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  QUOTA_RULE_LIMIT,
  RULE_KINDS,
  normalizeRuleMatch,
  validPageLimit,
} from "../worker/quota-rule-match.mjs";
import { AUTH_D1, deploymentProfile } from "./deployment/profiles.mjs";

export const DEFAULT_TARGET = "page10";
/** The newest `pages_quota_schema` version this script knows: the last entry
 * of QUOTA_MIGRATIONS in worker/page-quota.mjs. A newer schema may change the
 * columns, so the script refuses to write until it is updated. */
export const QUOTA_SCHEMA_VERSION = 1;
export const NOTE_LIMIT = 200;
/** pageQuotaBounds.rulesMs in worker/page-quota.mjs. */
export const RULE_CACHE_MINUTES = 5;
export const SSH_TIMEOUT_MS = 120_000;
/** The most rows of one kind a scan reads. The Worker reads at most
 * QUOTA_RULE_LIMIT in all, so a larger table is already broken. */
export const SCAN_LIMIT = 10_000;
/** Exit codes of the remote guard, which run before any SQL is sent. */
export const EXIT_CELL_MISSING = 3;
export const EXIT_RUNTIME_MISMATCH = 4;

export const USAGE = `Usage:
  node scripts/quota-rules.mjs [options] check
  node scripts/quota-rules.mjs [options] list
  node scripts/quota-rules.mjs [options] get    email|domain VALUE
  node scripts/quota-rules.mjs [options] set    email|domain VALUE LIMIT [--note TEXT] [--create-only]
  node scripts/quota-rules.mjs [options] delete email|domain VALUE

Options:
  --target NAME     Deployment profile (default ${DEFAULT_TARGET})
  --ssh-host HOST   SSH destination (default: the profile's host)
  --dry-run         Print the remote script and the SQL; write nothing. delete
                    runs its read-only preflight to show the rows it would remove
  --note TEXT       set: a note stored with the rule (at most ${NOTE_LIMIT} characters)
  --create-only     set: refuse if the rule already exists

LIMIT is a whole number from 0 to 10000. 0 pauses Page creation for the match.
Changes take effect within ${RULE_CACHE_MINUTES} minutes.`;

export class UsageError extends Error {
  name = "UsageError";
}
export class QuotaRulesError extends Error {
  name = "QuotaRulesError";
}
/** A remote run that exited non-zero. `notRun` is true only when the remote
 * guard stopped before celld received any SQL. */
export class ExecError extends Error {
  name = "ExecError";
  constructor(message, { code, notRun = false } = {}) {
    super(message);
    this.code = code;
    this.notRun = notRun;
  }
}

const COMMANDS = Object.freeze({ check: 0, list: 0, get: 2, set: 3, delete: 2 });
const FLAGS = new Set(["--dry-run", "--create-only", "--help", "-h"]);
const VALUED = new Set(["--target", "--ssh-host", "--note"]);

/** A rule match from the command line, normalized as the Worker compares it. */
export function parseRule(kind, value) {
  if (!RULE_KINDS.includes(kind))
    throw new UsageError(`The rule kind is "email" or "domain", not ${JSON.stringify(kind)}`);
  if (typeof value !== "string" || !value.isWellFormed())
    throw new UsageError(`The ${kind} is not well-formed text`);
  const normalized = normalizeRuleMatch(kind, value);
  if (!normalized)
    throw new UsageError(
      `${JSON.stringify(value)} is not a valid ${kind}, so no account could ever match it`,
    );
  return { kind, value: normalized };
}

export function parseLimit(text) {
  const limit = /^\d{1,6}$/.test(text ?? "") ? Number(text) : NaN;
  if (!validPageLimit(limit))
    throw new UsageError(
      `The limit is a whole number from 0 to 10000, not ${JSON.stringify(text ?? "")}`,
    );
  return limit;
}

export function parseNote(text) {
  if (text === undefined || text === "") return null;
  if (!text.isWellFormed() || text.includes("\0"))
    throw new UsageError("The note must be well-formed text without NUL characters");
  if ([...text].length > NOTE_LIMIT)
    throw new UsageError(`The note is longer than ${NOTE_LIMIT} characters`);
  return text;
}

export function parseArgs(argv) {
  const options = { target: DEFAULT_TARGET, sshHost: undefined, dryRun: false };
  let note;
  let createOnly = false;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    let value;
    if (VALUED.has(name)) {
      if (equals !== -1) value = arg.slice(equals + 1);
      else if (i + 1 < argv.length) value = argv[++i];
      else throw new UsageError(`${name} needs a value`);
    } else if (!FLAGS.has(name) || equals !== -1) {
      throw new UsageError(`Unknown option ${arg}`);
    }
    if (name === "--help" || name === "-h") return { command: "help" };
    if (name === "--target") options.target = value;
    else if (name === "--ssh-host") options.sshHost = value;
    else if (name === "--note") note = value;
    else if (name === "--dry-run") options.dryRun = true;
    else if (name === "--create-only") createOnly = true;
  }
  const [command, ...rest] = positional;
  if (!command) throw new UsageError("Name a command: check, list, get, set or delete");
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`Unknown command ${command}`);
  if (rest.length !== COMMANDS[command])
    throw new UsageError(
      COMMANDS[command]
        ? `${command} takes email|domain VALUE${command === "set" ? " LIMIT" : ""}`
        : `${command} takes no arguments`,
    );
  if (command !== "set" && (note !== undefined || createOnly))
    throw new UsageError("--note and --create-only apply only to set");
  const args = { command, ...options };
  if (COMMANDS[command]) args.rule = parseRule(rest[0], rest[1]);
  if (command === "set") {
    args.limit = parseLimit(rest[2]);
    args.note = parseNote(note);
    args.createOnly = createOnly;
  }
  return args;
}

const SAFE = /^[A-Za-z0-9 ._:/-]+$/;

/** Where the target's D1 lives, from its deployment profile. */
export function targetConfig(target, sshHost) {
  let profile;
  try {
    profile = deploymentProfile(target);
  } catch {
    throw new UsageError(`Unknown target ${JSON.stringify(target)}`);
  }
  if (!profile.d1 || profile.pageQuota === undefined)
    throw new UsageError(`${target} has no Page quotas: its profile names no quota database`);
  // The profile must name the database the build binds as DB; any other
  // database_id would open a different, empty database.
  if (JSON.stringify(profile.d1) !== JSON.stringify(AUTH_D1))
    throw new QuotaRulesError(
      `${target}'s D1 database ${JSON.stringify(profile.d1.database_id)} is not the one builds bind (${AUTH_D1.database_id})`,
    );
  const host = sshHost ?? profile.deployment.host;
  if (typeof host !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._@-]*$/.test(host))
    throw new UsageError(`--ssh-host takes an SSH destination such as lab1 or root@lab1`);
  const { service, bucket, prefix, region, requiredVersion } = profile.deployment;
  const config = {
    target,
    host,
    service,
    runtime: `/opt/${service}/celld`,
    bucket: `s3://${bucket}/${prefix}`,
    region,
    requiredVersion,
    defaultLimit: Number(profile.pageQuota),
    d1: profile.d1,
  };
  for (const value of [
    service,
    config.runtime,
    config.bucket,
    region,
    requiredVersion,
    config.d1.binding,
    config.d1.database_name,
    config.d1.database_id,
    config.d1.cell,
  ])
    if (typeof value !== "string" || !SAFE.test(value))
      throw new QuotaRulesError(`Unexpected character in ${target}'s profile: ${value}`);
  return config;
}

export const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The bash script the target host runs. It depends only on the profile. */
export function remoteScript(config) {
  const { service, runtime, bucket, region, requiredVersion, d1 } = config;
  const storage = `--bucket ${bucket} --region ${region}`;
  const project = JSON.stringify({
    name: "quota-rules",
    d1_databases: [
      { binding: d1.binding, database_name: d1.database_name, database_id: d1.database_id },
    ],
  });
  return [
    "set -euo pipefail",
    // The service's loopback firewall resets connections from any other uid
    // but root, so celld runs as the service user.
    `celld() { sudo -n -u ${service} ${runtime} "$@"; }`,
    `version=$(celld --version 2>/dev/null || true)`,
    `if ! grep -qxF ${shellQuote(requiredVersion)} <<<"$version"; then`,
    `  echo "quota-rules: ${runtime} is not ${requiredVersion}" >&2; exit ${EXIT_RUNTIME_MISMATCH}`,
    "fi",
    // d1 execute creates a database it can't find, so the cell must exist first.
    `cells=$(celld cell list __D1Database ${storage} --all --json)`,
    `if ! grep -qF ${shellQuote(`"scope":"${d1.cell}"`)} <<<"$cells"; then`,
    `  echo "quota-rules: ${d1.cell} is not in ${bucket}" >&2; exit ${EXIT_CELL_MISSING}`,
    "fi",
    `d=$(mktemp -d /tmp/quota-rules.XXXXXX)`,
    `trap 'rm -rf "$d"' EXIT`,
    `printf '%s' ${shellQuote(project)} >"$d/wrangler.json"`,
    `cat >"$d/stmt.sql"`,
    `chmod 755 "$d"; chmod 644 "$d/wrangler.json" "$d/stmt.sql"`,
    `celld d1 execute ${d1.database_name} --file "$d/stmt.sql" "$d" ${storage} --json`,
  ].join("\n");
}

export const remoteCommand = (config) => `bash -c ${shellQuote(remoteScript(config))}`;

export const sshArgs = (config) => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=20",
  "--",
  config.host,
  remoteCommand(config),
];

// --- SQL --------------------------------------------------------------------

const COLUMNS = "match_kind, match_value, page_limit, note, updated_at";

/** A TEXT literal whose SQL carries only hex digits. */
export function hexText(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0"))
    throw new TypeError("hexText takes well-formed text without NUL");
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function kindLiteral(kind) {
  if (!RULE_KINDS.includes(kind)) throw new TypeError(`Unknown rule kind ${kind}`);
  return `'${kind}'`;
}

const whereRule = ({ kind, value }) =>
  `match_kind = ${kindLiteral(kind)} AND match_value = ${hexText(value)}`;

/** Every stored row of one kind, in the order the Worker reads them. The
 * Worker normalizes stored values again, so a row stored as `Example.COM`
 * still matches `example.com`; only a scan finds every row that matches. */
const selectKind = (kind) =>
  `SELECT 'rule' AS r, ${COLUMNS} FROM pages_quota_rules WHERE match_kind = ${kindLiteral(kind)} ORDER BY match_value LIMIT ${SCAN_LIMIT + 1};`;

// celld --json prints every statement's rows as one stream, so each SELECT
// tags its rows with `r`. Every statement ends in ";": celld reports any
// error in an unterminated last statement as an incomplete statement.
const statements = (...lines) => lines.join("\n") + "\n";

/** Both tables, the schema version and the rule count; with `rule`, every
 * stored row of its kind. A missing table fails the run with "no such table". */
export function checkSql(rule) {
  return statements(
    "SELECT 'table' AS r, name FROM sqlite_master WHERE type = 'table' AND name IN ('pages_quota_rules', 'pages_quota_schema') ORDER BY name;",
    "SELECT 'count' AS r, count(*) AS n FROM pages_quota_rules;",
    "SELECT 'schema' AS r, max(version) AS version FROM pages_quota_schema;",
    ...(rule ? [selectKind(rule.kind)] : []),
  );
}

export function listSql() {
  return statements(
    `SELECT 'rule' AS r, ${COLUMNS} FROM pages_quota_rules ORDER BY match_kind, match_value LIMIT ${QUOTA_RULE_LIMIT + 1};`,
  );
}

export const getSql = (rule) => statements(selectKind(rule.kind));

/** Upsert one rule and read it back in the same transaction. A new rule is
 * added only while the table holds fewer than QUOTA_RULE_LIMIT rows, because
 * the Worker ignores every rule past that. */
export function setSql({ rule, limit, note = null, now, createOnly = false }) {
  if (!validPageLimit(limit)) throw new TypeError("Invalid page limit");
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("Invalid timestamp");
  const conflict = createOnly
    ? "ON CONFLICT (match_kind, match_value) DO NOTHING;"
    : "ON CONFLICT (match_kind, match_value) DO UPDATE SET page_limit = excluded.page_limit, note = excluded.note, updated_at = excluded.updated_at;";
  return statements(
    `INSERT INTO pages_quota_rules (${COLUMNS})`,
    `SELECT ${kindLiteral(rule.kind)}, ${hexText(rule.value)}, ${limit}, ${note === null ? "NULL" : hexText(note)}, ${now}`,
    `WHERE (SELECT count(*) FROM pages_quota_rules) < ${QUOTA_RULE_LIMIT} OR EXISTS (SELECT 1 FROM pages_quota_rules WHERE ${whereRule(rule)})`,
    conflict,
    selectKind(rule.kind),
  );
}

/** Delete exactly the stored `rows` (from matchingRows), each fenced by the
 * `updated_at` the preflight read, so a row changed since then survives and
 * shows up in the read-back. */
export function deleteSql(rule, rows) {
  if (!rows?.length) throw new TypeError("deleteSql needs the stored rows to delete");
  const fences = rows.map((row) => {
    if (row.match_kind !== rule.kind || typeof row.match_value !== "string")
      throw new TypeError("deleteSql takes rows of the rule's kind");
    if (!Number.isSafeInteger(row.updated_at))
      throw new QuotaRulesError(
        `The row stored as ${JSON.stringify(row.match_value)} has no integer updated_at, so it can't be deleted safely; fix it by hand`,
      );
    return `(match_value = ${hexText(row.match_value)} AND updated_at = ${row.updated_at})`;
  });
  return statements(
    `DELETE FROM pages_quota_rules WHERE match_kind = ${kindLiteral(rule.kind)} AND (${fences.join(" OR ")});`,
    "SELECT 'deleted' AS r, changes() AS n;",
    selectKind(rule.kind),
  );
}

/** The stored rows the Worker resolves as `rule`, in the order it applies
 * them (worker/page-quota.mjs ruleSet): by updated_at, the last one winning. */
export function matchingRows(rows, rule) {
  return rows
    .filter(
      (row) =>
        row.match_kind === rule.kind &&
        normalizeRuleMatch(row.match_kind, row.match_value) === rule.value,
    )
    .sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0));
}

/** The row whose limit the Worker uses, or null. */
export function effectiveRow(matches) {
  return (
    matches.findLast((row) => Number.isSafeInteger(row.page_limit) && row.page_limit >= 0) ?? null
  );
}

// --- Transport --------------------------------------------------------------

/** Send `sql` to the target over SSH stdin. Resolves `{ code, stdout, stderr }`;
 * `code` is null when ssh couldn't start or was killed. */
export function sshTransport(config, { spawnImpl = spawn, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  return (sql) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawnImpl("ssh", sshArgs(config), { stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: `${stderr}${error.message}\n` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code: timedOut ? null : code,
          stdout,
          stderr: timedOut ? `${stderr}ssh timed out after ${timeoutMs / 1000} s\n` : stderr,
        });
      });
      // The remote guard can exit before reading stdin.
      child.stdin.on("error", () => {});
      child.stdin.end(sql);
    });
}

/** celld's own messages, without allocator diagnostics. */
export function cleanStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter(
      (line) => line.trim() && !line.startsWith("<jemalloc>") && !line.includes("celld::memory"),
    )
    .join("\n");
}

/** Rows from `celld d1 execute --json`: one JSON object per line. */
export function parseRows(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new QuotaRulesError(`Unexpected output from celld: ${line}`);
      }
    });
}

function tagged(rows) {
  const groups = {};
  for (const { r, ...row } of rows) (groups[r] ??= []).push(row);
  return groups;
}

async function execute(transport, config, sql) {
  const result = await transport(sql);
  if (result.code === 0) return tagged(parseRows(result.stdout));
  const detail = cleanStderr(result.stderr ?? "");
  if (result.code === EXIT_CELL_MISSING)
    throw new ExecError(
      `${config.d1.cell} (${config.d1.database_id}) is not in ${config.bucket}. Nothing ran. Check the target and its profile; never point the script at another database_id.`,
      { code: result.code, notRun: true },
    );
  if (result.code === EXIT_RUNTIME_MISMATCH)
    throw new ExecError(
      `${config.runtime} on ${config.host} is not ${config.requiredVersion}. Nothing ran.`,
      {
        code: result.code,
        notRun: true,
      },
    );
  throw new ExecError(detail || `ssh ${config.host} exited with ${result.code ?? "no status"}`, {
    code: result.code,
  });
}

const missingTable = (error) =>
  /no such table: (pages_quota_(?:rules|schema))\b/.exec(error?.message ?? "")?.[1];

// --- Commands ---------------------------------------------------------------

const describe = ({ kind, value }) => `${kind} rule for ${value}`;

/** One stored row, flagged when the Worker reads it differently. */
export function formatRule(row, { shadowed = false } = {}) {
  const note = row.note === null || row.note === undefined ? "" : `  note: ${row.note}`;
  const at = Number.isSafeInteger(row.updated_at) ? new Date(row.updated_at).toISOString() : "?";
  const normalized = normalizeRuleMatch(row.match_kind, row.match_value);
  const flags = [];
  if (normalized === null) flags.push("never matches");
  else if (normalized !== row.match_value)
    flags.push(`not canonical: the Worker reads it as ${normalized}`);
  if (shadowed) flags.push("shadowed by a newer row");
  const caveat = flags.length ? `  (${flags.join("; ")})` : "";
  return `${row.match_kind}\t${JSON.stringify(row.match_value)}\t${row.page_limit}\t${at}${note}${caveat}`;
}

/** Rows that share a normalized match with a newer row the Worker prefers. */
function shadowedRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const value = normalizeRuleMatch(row.match_kind, row.match_value);
    if (value === null) continue;
    const key = `${row.match_kind}\u0000${value}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const shadowed = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = effectiveRow(
      matchingRows(group, {
        kind: group[0].match_kind,
        value: normalizeRuleMatch(group[0].match_kind, group[0].match_value),
      }),
    );
    for (const row of group) if (row !== winner) shadowed.add(row);
  }
  return shadowed;
}

function formatMatches(matches) {
  const winner = effectiveRow(matches);
  return matches.map((row) => formatRule(row, { shadowed: matches.length > 1 && row !== winner }));
}

function kindRows(groups) {
  const rows = groups.rule ?? [];
  if (rows.length > SCAN_LIMIT)
    throw new QuotaRulesError(
      `More than ${SCAN_LIMIT} stored rules of one kind: too many to search safely. Trim the table by hand.`,
    );
  return rows;
}

/** Tables, schema and rule count, and every stored row matching `rule`.
 * Runs before every write; it never creates anything. */
async function preflight(transport, config, rule) {
  let groups;
  try {
    groups = await execute(transport, config, checkSql(rule));
  } catch (error) {
    const table = missingTable(error);
    if (!table) throw error;
    throw new QuotaRulesError(
      `${table} is missing from ${config.d1.database_name} on ${config.target}. The Worker creates it on first use, and this script never does. Deploy a build with Page quotas, call list_pages once, then run check again.`,
    );
  }
  const tables = (groups.table ?? []).map((row) => row.name);
  const version = groups.schema?.[0]?.version ?? 0;
  if (version < QUOTA_SCHEMA_VERSION)
    throw new QuotaRulesError(
      `pages_quota_schema is at version ${version}; the Worker hasn't finished creating pages_quota_rules`,
    );
  if (version > QUOTA_SCHEMA_VERSION)
    throw new QuotaRulesError(
      `pages_quota_schema is at version ${version}, newer than this script knows (${QUOTA_SCHEMA_VERSION}). Update the script first.`,
    );
  return {
    tables,
    version,
    count: groups.count?.[0]?.n ?? 0,
    matches: rule ? matchingRows(kindRows(groups), rule) : [],
  };
}

async function check({ transport, config, out }) {
  const state = await preflight(transport, config);
  out(`Target ${config.target}: ssh ${config.host}, ${config.service}, ${config.bucket}`);
  out(`D1 ${config.d1.database_name}: ${config.d1.cell}`);
  out(`Tables: ${state.tables.join(", ")} (schema version ${state.version})`);
  out(`Rules: ${state.count} of ${QUOTA_RULE_LIMIT}. Default limit: ${config.defaultLimit}.`);
  if (state.count > QUOTA_RULE_LIMIT) {
    out(`The table holds more than ${QUOTA_RULE_LIMIT} rules, so the Worker ignores all of them.`);
    return 1;
  }
  return 0;
}

async function list({ transport, config, out }) {
  let groups;
  try {
    groups = await execute(transport, config, listSql());
  } catch (error) {
    if (missingTable(error))
      throw new QuotaRulesError(`${missingTable(error)} is missing. Run check.`);
    throw error;
  }
  const rows = (groups.rule ?? []).slice(0, QUOTA_RULE_LIMIT);
  if (!rows.length) {
    out(`No rules. Every account gets the default, ${config.defaultLimit}.`);
    return 0;
  }
  const shadowed = shadowedRows(rows);
  out("kind\tstored value\tlimit\tupdated");
  for (const row of rows) out(formatRule(row, { shadowed: shadowed.has(row) }));
  if ((groups.rule ?? []).length > QUOTA_RULE_LIMIT) {
    out(
      `More than ${QUOTA_RULE_LIMIT} rules: the Worker ignores all of them until the table is trimmed.`,
    );
    return 1;
  }
  return 0;
}

/** Every stored row the Worker resolves as `rule`. */
async function readMatches(transport, config, rule) {
  try {
    return matchingRows(kindRows(await execute(transport, config, getSql(rule))), rule);
  } catch (error) {
    if (missingTable(error))
      throw new QuotaRulesError(`${missingTable(error)} is missing. Run check.`);
    throw error;
  }
}

async function get({ transport, config, args, out }) {
  const matches = await readMatches(transport, config, args.rule);
  if (!matches.length) out(`No ${describe(args.rule)}.`);
  for (const line of formatMatches(matches)) out(line);
  return 0;
}

/** After a failed write: read the rule back once and report what is there.
 * An error is not proof that nothing committed, and a state that differs from
 * the request is not proof that the write failed: it may have committed and
 * been replaced since. Only the requested state, observed, ends the run
 * cleanly. Nothing is ever re-sent. */
async function afterWriteError({ transport, config, args, err, error, landed, command }) {
  err(`The ${command} failed: ${error.message}`);
  if (!error.notRun) err("An error does not prove nothing was written. Reading the rule back.");
  let matches;
  try {
    matches = await readMatches(transport, config, args.rule);
  } catch (readError) {
    err(`The read-back failed too: ${readError.message}`);
    err(
      `The rule's state is unknown. Run \`get ${args.rule.kind} ${args.rule.value}\` and reconcile before running anything again.`,
    );
    return 1;
  }
  if (landed(matches)) {
    err(`Requested state observed: the ${command} landed. Don't run it again.`);
    for (const line of formatMatches(matches)) err(line);
    return 0;
  }
  return notObserved(err, args.rule, matches, command);
}

function notObserved(
  err,
  rule,
  matches,
  command,
  reason = `The ${command} may not have committed, or it committed and a newer change replaced it.`,
) {
  err("Requested state not observed. Current state:");
  if (!matches.length) err(`  no ${describe(rule)}`);
  for (const line of formatMatches(matches)) err(`  ${line}`);
  err(
    `${reason} Reconcile before running anything again: find out who else changed this rule, and decide from the current state. Running the ${command} again could overwrite their change.`,
  );
  return 1;
}

async function set({ transport, config, args, now, out, err }) {
  const { rule, limit, note, createOnly } = args;
  const before = await preflight(transport, config, rule);
  const current = effectiveRow(before.matches);
  if (createOnly && before.matches.length)
    throw new QuotaRulesError(
      `An ${describe(rule)} already exists. --create-only left it unchanged:\n${formatMatches(before.matches).join("\n")}`,
    );
  const canonical = before.matches.some((row) => row.match_value === rule.value);
  if (!canonical && before.count >= QUOTA_RULE_LIMIT)
    throw new QuotaRulesError(
      `The table already holds ${before.count} rules, the most the Worker reads. Delete one first.`,
    );
  const at = now();
  const ours = (row) =>
    row?.match_value === rule.value &&
    row.page_limit === limit &&
    (row.note ?? null) === note &&
    row.updated_at === at;
  const landed = (matches) => ours(effectiveRow(matches));
  let groups;
  try {
    groups = await execute(transport, config, setSql({ rule, limit, note, now: at, createOnly }));
  } catch (error) {
    return afterWriteError({ transport, config, args, err, error, landed, command: "set" });
  }
  const matches = matchingRows(kindRows(groups), rule);
  if (!matches.some((row) => row.match_value === rule.value))
    throw new QuotaRulesError(
      `The rule was not added: the table reached ${QUOTA_RULE_LIMIT} rules during the write.`,
    );
  if (!landed(matches)) {
    if (createOnly)
      throw new QuotaRulesError(
        `An ${describe(rule)} was added by someone else first and was left unchanged:\n${formatMatches(matches).join("\n")}`,
      );
    return notObserved(err, rule, matches, "set");
  }
  const was = current ? `limit ${current.page_limit}` : "no rule";
  out(`Set ${describe(rule)}: limit ${limit} (was ${was}).`);
  for (const line of formatMatches(matches)) out(line);
  if (matches.length > 1)
    out(
      `Older rows that match the same ${rule.kind} stay stored but no longer apply. \`delete ${rule.kind} ${rule.value}\` removes all of them.`,
    );
  out(
    `Takes effect within ${RULE_CACHE_MINUTES} minutes: each Worker isolate caches the rules.${limit === 0 ? " Limit 0 pauses Page creation for this match." : ""}`,
  );
  return 0;
}

async function remove({ transport, config, args, out, err }) {
  const { rule } = args;
  const before = await preflight(transport, config, rule);
  if (!before.matches.length) {
    out(`No ${describe(rule)}. Nothing to delete.`);
    return 0;
  }
  const landed = (matches) => matches.length === 0;
  let groups;
  try {
    groups = await execute(transport, config, deleteSql(rule, before.matches));
  } catch (error) {
    return afterWriteError({ transport, config, args, err, error, landed, command: "delete" });
  }
  const remaining = matchingRows(kindRows(groups), rule);
  if (!landed(remaining))
    return notObserved(
      err,
      rule,
      remaining,
      "delete",
      "A stored row changed after the preflight read it, so the delete left that row in place.",
    );
  const count = before.matches.length;
  out(
    count === 1
      ? `Deleted the ${describe(rule)}:`
      : `Deleted ${count} stored rows for the ${describe(rule)}:`,
  );
  for (const line of formatMatches(before.matches)) out(`  ${line}`);
  const fallback =
    rule.kind === "email" ? "its domain's rule or the default" : "email rules or the default";
  out(
    `Within ${RULE_CACHE_MINUTES} minutes, matching accounts fall back to ${fallback}, ${config.defaultLimit}.`,
  );
  return 0;
}

/**
 * What a run would send, without writing. A delete removes exactly the stored
 * rows its preflight finds, so its plan takes those `matches`; main reads them
 * with the read-only preflight. Every other plan is built offline.
 */
export function dryRun(args, config, at, matches) {
  const plan = [];
  if (args.command === "check") plan.push(["check", checkSql()]);
  if (args.command === "list") plan.push(["list", listSql()]);
  if (args.command === "get") plan.push(["get", getSql(args.rule)]);
  if (args.command === "set")
    plan.push(
      ["preflight", checkSql(args.rule)],
      [
        "write",
        setSql({
          rule: args.rule,
          limit: args.limit,
          note: args.note,
          now: at,
          createOnly: args.createOnly,
        }),
      ],
    );
  const lines = [
    args.command === "delete"
      ? "Dry run: only the read-only preflight was sent. Nothing was written."
      : "Dry run: nothing was sent.",
    "",
    `Each step runs \`${["ssh", ...sshArgs(config).slice(0, -1)].join(" ")} "bash -c <script>"\``,
    "with the step's SQL on stdin. The remote script:",
    "",
    remoteScript(config),
  ];
  if (args.command === "delete") {
    lines.push("", "-- preflight", checkSql(args.rule).trimEnd(), "");
    if (!matches?.length) {
      lines.push(`No ${describe(args.rule)} is stored. The delete would send nothing.`);
      return lines.join("\n");
    }
    lines.push(`The delete would remove these stored rows:`);
    for (const line of formatMatches(matches)) lines.push(`  ${line}`);
    plan.push(["write", deleteSql(args.rule, matches)]);
  }
  for (const [name, sql] of plan) lines.push("", `-- ${name}`, sql.trimEnd());
  if (plan.some(([name]) => name === "write"))
    lines.push("", "The write runs only if the preflight passes.");
  return lines.join("\n");
}

const HANDLERS = { check, list, get, set, delete: remove };

export async function main(
  argv,
  { transport, now = Date.now, out = console.log, err = console.error } = {},
) {
  let args;
  let config;
  try {
    args = parseArgs(argv);
    if (args.command === "help") {
      out(USAGE);
      return 0;
    }
    config = targetConfig(args.target, args.sshHost);
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof QuotaRulesError)) throw error;
    err(error.message);
    if (error instanceof UsageError) err(`\n${USAGE}`);
    return 2;
  }
  const send = () => transport ?? sshTransport(config);
  try {
    if (args.dryRun) {
      const matches =
        args.command === "delete"
          ? (await preflight(send(), config, args.rule)).matches
          : undefined;
      out(dryRun(args, config, now(), matches));
      return 0;
    }
    return await HANDLERS[args.command]({ transport: send(), config, args, now, out, err });
  } catch (error) {
    if (!(error instanceof QuotaRulesError || error instanceof ExecError)) throw error;
    err(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
