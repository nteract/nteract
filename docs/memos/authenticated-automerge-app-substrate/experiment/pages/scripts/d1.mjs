// Run SQL against a celld target's D1 database from an operator machine.
//
// The lab targets (`pages`, `page10`) are test deployments, so reads and
// writes by hand are allowed. The SQL goes over SSH stdin to the same fixed
// remote command quota-rules.mjs uses: it checks the celld version, refuses
// to run unless the database's cell already exists (celld creates an empty
// database for an id it hasn't seen), and runs `celld d1 execute` as the
// service user, through the database's live owner, in one transaction.
//
// Rows print as one JSON object per line on stdout. The target and its
// storage prefix print on stderr, so a command rerun from history says where
// it ran.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  EXIT_CELL_MISSING,
  EXIT_RUNTIME_MISMATCH,
  QuotaRulesError,
  UsageError,
  cleanStderr,
  parseRows,
  sshTransport,
  targetConfig,
} from "./quota-rules.mjs";

export const USAGE = `Usage:
  node scripts/d1.mjs --target pages "SELECT name FROM sqlite_master WHERE type = 'table'"
  node scripts/d1.mjs --target page10 --file query.sql
  echo "SELECT 1" | node scripts/d1.mjs --target pages -

Options:
  --target NAME     Required: pages or page10.
  --file PATH       Read the SQL from a file. "-" as the SQL reads stdin.
  --ssh-host HOST   SSH destination; the profile's host (lab1) by default.

The database also holds the auth and OIDC tables. A failed write may still
have committed: read the row back before running it again.`;

export function parseArgs(argv) {
  const args = { target: undefined, sshHost: undefined, file: undefined, sql: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--target" || arg === "--ssh-host" || arg === "--file") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      args[{ "--target": "target", "--ssh-host": "sshHost", "--file": "file" }[arg]] = value;
    } else if (arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}`);
    else if (args.sql !== undefined) throw new UsageError("Give the SQL as one argument");
    else args.sql = arg;
  }
  if (!args.target) throw new UsageError("--target is required");
  if ((args.sql === undefined) === (args.file === undefined))
    throw new UsageError("Give the SQL as an argument, with --file, or as - for stdin");
  return args;
}

function readSql(args, stdin) {
  const sql =
    args.file !== undefined
      ? readFileSync(args.file, "utf8")
      : args.sql === "-"
        ? stdin()
        : args.sql;
  if (!sql.trim()) throw new UsageError("The SQL is empty");
  return sql;
}

export async function main(
  argv,
  { transport, stdin = () => readFileSync(0, "utf8"), out = console.log, err = console.error } = {},
) {
  let config;
  let sql;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      out(USAGE);
      return 0;
    }
    config = targetConfig(args.target, args.sshHost);
    sql = readSql(args, stdin);
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof QuotaRulesError)) throw error;
    err(error.message);
    if (error instanceof UsageError) err(`\n${USAGE}`);
    return 2;
  }
  const where = `${config.d1.database_name} on ${config.target} (${config.bucket})`;
  const result = await (transport ?? sshTransport(config))(sql);
  if (result.code === EXIT_CELL_MISSING) {
    err(`${config.d1.cell} is not in ${config.bucket}. Nothing ran.`);
    return 1;
  }
  if (result.code === EXIT_RUNTIME_MISMATCH) {
    err(`${config.runtime} on ${config.host} is not ${config.requiredVersion}. Nothing ran.`);
    return 1;
  }
  if (result.code !== 0) {
    err(
      `${where}: ${cleanStderr(result.stderr ?? "") || `exited with ${result.code ?? "no status"}`}`,
    );
    err("A write that reports an error may still have committed. Read it back before rerunning.");
    return 1;
  }
  const rows = parseRows(result.stdout);
  for (const row of rows) out(JSON.stringify(row));
  err(`${where}: ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  return 0;
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
