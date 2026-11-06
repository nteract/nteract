// ONE-SHOT MIGRATION client: delete with worker/page-records-sweep.mjs.
//
// Clear the old PageRecords object of every Page converted from `buffered`
// Subduction storage, on a celld lab target, from an operator machine over
// SSH (scripts/operator-ssh.mjs). The run lists the target's Page cells with
// `celld cell list Page` and sends them to the operator route
// `/api/operator/page-records` in batches. Each Page host decides from its
// own record whether it has a PageRecords object and whether it may be
// cleared. Every response is appended to a JSON-lines log as it arrives; a
// failure still prints the report so far.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { operatorConfig, sshTransport } from "./operator-ssh.mjs";
import { SWEEP_BATCH, sweepTotals } from "../worker/page-records-sweep.mjs";

export const ROUTE = "/api/operator/page-records";

export const USAGE = `Usage:
  node scripts/page-records-sweep-operator.mjs --target pages --mode dry_run
  node scripts/page-records-sweep-operator.mjs --target pages --mode apply

Options:
  --target NAME     Required: pages or page10 (profiles with operatorMigration).
  --mode MODE       Required: dry_run or apply.
  --log PATH        Append each response as one JSON line (default
                    page-records-sweep-<target>-<mode>-<time>.jsonl).
  --ssh-host HOST   SSH destination; the profile's host (lab1) by default.`;

export function parseArgs(argv) {
  const args = { target: undefined, mode: undefined, log: undefined, sshHost: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--target") args.target = value;
    else if (flag === "--mode") args.mode = value;
    else if (flag === "--log") args.log = value;
    else if (flag === "--ssh-host") args.sshHost = value;
    else throw Error(`Unknown argument ${flag}\n${USAGE}`);
  }
  if (!args.target || !["dry_run", "apply"].includes(args.mode)) throw Error(USAGE);
  args.log ??= `page-records-sweep-${args.target}-${args.mode}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.jsonl`;
  return args;
}

/**
 * The whole sweep. `transport` is `{ call(body) -> { status, text },
 * cells() -> [cell id] }`; `log(record)` sees every response. Returns
 * `{ mode, page_cells, totals, pages }`; a failure throws with the report so
 * far as `error.report`.
 */
export async function sweepRun({ mode, transport, log = () => {} }) {
  const report = { mode, page_cells: 0, totals: sweepTotals([]), pages: [] };
  try {
    const cells = await transport.cells();
    report.page_cells = cells.length;
    for (let at = 0; at < cells.length; at += SWEEP_BATCH) {
      const body = { mode, cell_ids: cells.slice(at, at + SWEEP_BATCH) };
      const { status, text } = await transport.call(body);
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = { error: text.slice(0, 200) };
      }
      log({ request: "sweep", status, ...value });
      if (status !== 200) throw Error(`${status} ${JSON.stringify(value)}`);
      report.pages.push(...value.pages);
      report.totals = sweepTotals(report.pages);
    }
    return report;
  } catch (error) {
    throw Object.assign(error, { report });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = operatorConfig(args.target, args.sshHost);
  const log = (record) =>
    appendFileSync(args.log, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  process.stderr.write(`${args.mode} on ${config.target} (${config.bucket}); log ${args.log}\n`);
  const print = (report) =>
    process.stdout.write(`${JSON.stringify({ target: config.target, ...report }, null, 2)}\n`);
  try {
    print(await sweepRun({ mode: args.mode, transport: sshTransport(config, ROUTE), log }));
  } catch (error) {
    if (error.report) print(error.report);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
