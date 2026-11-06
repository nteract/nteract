// ONE-SHOT MIGRATION client: delete with worker/comments-migration.mjs,
// scripts/operator-ssh.mjs and worker/operator-gate.mjs.
//
// Run the comments migration for every account on a celld lab target, from an
// operator machine over SSH. Each call is one SSH command to the target host
// that reads the root-only operator secret the installer wrote and posts to
// the Worker's operator route on the public listener's loopback address, as
// the service user (the listener's firewall admits only root and that user).
// The route lives only where the secret is configured, and refuses anything
// the Cloudflare edge forwarded (worker/comments-migration.mjs, worker/operator-gate.mjs).
//
// The run: list the accounts (the D1 catalog projection), drive each
// account's Catalog through `dry_run` or `apply` until it has covered every
// Page, then diff the cells the runs reached against `celld cell list Page`
// and probe each one no run reached, so it can be passed to its owner's run.
// Every response is appended to a JSON-lines log as it arrives; a failure
// still prints the report so far.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { operatorConfig, sshTransport } from "./operator-ssh.mjs";
import { drive } from "./comments-migration.mjs";

export {
  callScript,
  cellsScript,
  operatorConfig,
  shellQuote,
  sshTransport,
} from "./operator-ssh.mjs";

export const USAGE = `Usage:
  node scripts/comments-migration-operator.mjs --target pages --mode dry_run
  node scripts/comments-migration-operator.mjs --target pages --mode apply

Options:
  --target NAME         Required: pages or page10 (profiles with operatorMigration).
  --mode MODE           Required: dry_run or apply.
  --principal P         Run only this account (repeatable). Default: every
                        account the catalog projection lists.
  --include-connected   Apply to Pages with live sockets instead of skipping them.
  --limit N             Pages per call, 1–25 (default 10).
  --log PATH            Append each response as one JSON line (default
                        comments-migration-operator-<target>-<mode>-<time>.jsonl).
  --no-cells            Skip the celld cell list diff and probes.
  --ssh-host HOST       SSH destination; the profile's host (lab1) by default.
  --max-calls N         Stop one account after N calls (default 100).`;

const PROBE_BATCH = 100;

export function parseArgs(argv) {
  const args = {
    target: undefined,
    mode: undefined,
    principals: [],
    includeConnected: false,
    limit: 10,
    log: undefined,
    cells: true,
    sshHost: undefined,
    maxCalls: 100,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--include-connected") args.includeConnected = true;
    else if (flag === "--no-cells") args.cells = false;
    else {
      const value = argv[++i];
      if (value === undefined) throw Error(`${flag} needs a value\n${USAGE}`);
      if (flag === "--target") args.target = value;
      else if (flag === "--mode") args.mode = value;
      else if (flag === "--principal") args.principals.push(value);
      else if (flag === "--limit") args.limit = Number(value);
      else if (flag === "--log") args.log = value;
      else if (flag === "--ssh-host") args.sshHost = value;
      else if (flag === "--max-calls") args.maxCalls = Number(value);
      else throw Error(`Unknown argument ${flag}\n${USAGE}`);
    }
  }
  if (!args.target || !["dry_run", "apply"].includes(args.mode)) throw Error(USAGE);
  args.log ??= `comments-migration-operator-${args.target}-${args.mode}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.jsonl`;
  return args;
}

/**
 * The whole operator run. `transport` is `{ call(body) -> { status, text },
 * cells() -> [cell id] }`; `log(record)` sees every response. Returns the
 * report; a failure throws with the report so far as `error.report`.
 */
export async function operatorRun({
  mode,
  principals = [],
  includeConnected = false,
  limit = 10,
  maxCalls = 100,
  cells = true,
  transport,
  log = () => {},
}) {
  const report = { mode, accounts: [], reached: 0, page_cells: null, unreached: null };
  const post = async (body) => {
    const { status, text } = await transport.call(body);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { error: text.slice(0, 200) };
    }
    if (status !== 200) {
      log({ request: body.action, principal: body.principal, status, refusal: value });
      throw Error(`${status} ${JSON.stringify(value)}`);
    }
    return value;
  };
  const reached = new Set();
  try {
    let list = principals;
    if (!list.length) {
      const accounts = await post({ action: "accounts" });
      log({ request: "accounts", ...accounts });
      list = accounts.principals;
      report.account_source = accounts.source;
    }
    for (const principal of list) {
      const account = { principal };
      report.accounts.push(account);
      try {
        const result = await drive({
          mode,
          limit,
          maxCalls,
          includeConnected,
          call: (body) => post({ action: "run", principal, ...body }),
          onResponse: (body) => {
            log({ request: "run", principal, ...body });
            for (const page of body.pages ?? []) if (page.cell_id) reached.add(page.cell_id);
          },
        });
        Object.assign(account, {
          calls: result.calls,
          visited: result.visited.length,
          totals: result.totals,
          progress: result.progress,
        });
      } catch (error) {
        Object.assign(account, error.report ?? {}, { error: error.message });
        throw error;
      }
    }
    report.reached = reached.size;
    if (cells) {
      const ids = await transport.cells();
      report.page_cells = ids.length;
      const missing = ids.filter((id) => !reached.has(id));
      report.unreached = [];
      for (let at = 0; at < missing.length; at += PROBE_BATCH) {
        const probed = await post({
          action: "probe",
          cell_ids: missing.slice(at, at + PROBE_BATCH),
        });
        log({ request: "probe", ...probed });
        report.unreached.push(...probed.cells);
      }
    }
    return report;
  } catch (error) {
    report.reached = reached.size;
    throw Object.assign(error, { report });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = operatorConfig(args.target, args.sshHost);
  const log = (record) =>
    appendFileSync(args.log, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  process.stderr.write(`${args.mode} on ${config.target} (${config.bucket}); log ${args.log}\n`);
  try {
    const report = await operatorRun({ ...args, transport: sshTransport(config), log });
    process.stdout.write(`${JSON.stringify({ target: config.target, ...report }, null, 2)}\n`);
  } catch (error) {
    if (error.report)
      process.stdout.write(
        `${JSON.stringify({ target: config.target, ...error.report }, null, 2)}\n`,
      );
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
