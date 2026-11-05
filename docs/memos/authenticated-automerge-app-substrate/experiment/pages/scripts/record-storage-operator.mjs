// ONE-SHOT MIGRATION client: delete with worker/record-storage-operator.mjs.
//
// Convert Subduction Pages to plain Automerge sync on a celld lab target,
// from an operator machine over SSH (scripts/operator-ssh.mjs), without
// waiting for their tabs to close. Each conversion runs in its Page host:
// the host closes its native sockets with a transient code, converts in
// place and resets; tabs reconnect, find plain storage and ask for a reload.
//
// Scope: `--page-id` (repeatable), `--principal` (that account's Catalog:
// its Pages, Project content and Trash), or `--all` (every `Page` cell from
// `celld cell list Page`, cross-checked against every account's Catalog).
// `--mode status` only reads. `--mode convert` reads every target's status,
// converts each one its host says it can, then reads them all again.
// Every request and response is appended to a JSON-lines log as it arrives.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { operatorConfig, sshTransport } from "./operator-ssh.mjs";

export const ROUTE = "/api/operator/record-storage";
export const USAGE = `Usage:
  node scripts/record-storage-operator.mjs --target pages --mode status --all
  node scripts/record-storage-operator.mjs --target pages --mode convert --page-id ID [--page-id ID ...]
  node scripts/record-storage-operator.mjs --target pages --mode convert --principal P
  node scripts/record-storage-operator.mjs --target pages --mode convert --all

Options:
  --target NAME     Required: a profile with operatorMigration (pages, page10).
  --mode MODE       Required: status (read-only) or convert.
  --page-id ID      Only this Page (repeatable).
  --principal P     Only this account's Catalog (repeatable).
  --all             Every Page cell on the target.
  --max N           Convert at most N Pages this run (a canary).
  --pause-ms N      Wait between conversions (default 500).
  --log PATH        Append each response as one JSON line (default
                    record-storage-operator-<target>-<mode>-<time>.jsonl).
  --ssh-host HOST   SSH destination; the profile's host (lab1) by default.`;

const STATUS_BATCH = 100;
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validPageId = (id) => typeof id === "string" && PAGE_ID.test(id);

export function parseArgs(argv) {
  const args = {
    target: undefined,
    mode: undefined,
    pageIds: [],
    principals: [],
    all: false,
    max: Infinity,
    pauseMs: 500,
    log: undefined,
    sshHost: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--all") {
      args.all = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--target") args.target = value;
    else if (flag === "--mode") args.mode = value;
    else if (flag === "--page-id") args.pageIds.push(value);
    else if (flag === "--principal") args.principals.push(value);
    else if (flag === "--max") args.max = Number(value);
    else if (flag === "--pause-ms") args.pauseMs = Number(value);
    else if (flag === "--log") args.log = value;
    else if (flag === "--ssh-host") args.sshHost = value;
    else throw Error(`Unknown argument ${flag}\n${USAGE}`);
  }
  const scopes = [args.pageIds.length > 0, args.principals.length > 0, args.all].filter(Boolean);
  if (!args.target || !["status", "convert"].includes(args.mode) || scopes.length !== 1)
    throw Error(`Choose a target, a mode and one scope\n${USAGE}`);
  if (args.pageIds.some((id) => !validPageId(id))) throw Error("--page-id takes a Page UUID");
  if (!(args.max >= 1) || !(Number.isSafeInteger(args.max) || args.max === Infinity))
    throw Error("--max takes a positive integer");
  if (!Number.isSafeInteger(args.pauseMs) || args.pauseMs < 0)
    throw Error("--pause-ms takes a non-negative integer");
  args.log ??= `record-storage-operator-${args.target}-${args.mode}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.jsonl`;
  return args;
}

/** Whether a status says the host would convert now. */
const convertible = (status) =>
  validPageId(status?.page_id) && status.refusal === null && !status.error;
/** Whether a status leaves the Page on Subduction for good. */
const remains = (status) =>
  !status?.error &&
  ["active", "trashed"].includes(status?.state) &&
  status?.record_storage !== "automerge";

function summarize(statuses) {
  const counts = {};
  for (const status of statuses) {
    const key = status.error ? "error" : `${status.state}/${status.record_storage ?? "none"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const brief = ({ cell_id, page_id, owner, state, record_storage, refusal, error }) => ({
  cell_id,
  page_id,
  owner,
  state,
  record_storage,
  ...(refusal && { refusal }),
  ...(error && { error }),
});

/**
 * The whole run. `transport` is `{ call(body) -> { status, text },
 * cells() -> [cell id] }`; `log(record)` sees every response; `sleep(ms)`
 * paces conversions. Returns the report; a failed call throws with the
 * report so far as `error.report`.
 */
export async function operatorRun({
  mode,
  pageIds = [],
  principals = [],
  all = false,
  max = Infinity,
  pauseMs = 500,
  transport,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const report = {
    mode,
    scope: all ? "all" : principals.length ? "principals" : "page_ids",
    targets: 0,
    before: null,
    converted: [],
    failed: [],
    not_converted: [],
    after: null,
    remaining: null,
  };
  const post = async (body) => {
    const { status, text } = await transport.call(body);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { error: text.slice(0, 200) };
    }
    log({ request: body.action, ...(body.page_id && { page_id: body.page_id }), status, ...value });
    if (status !== 200) throw Error(`${body.action}: ${status} ${JSON.stringify(value)}`);
    return value;
  };
  /** Statuses for `{ pageIds, cellIds }`, in batches. */
  const statuses = async ({ pageIds: pages = [], cellIds = [] }) => {
    const out = [];
    for (let at = 0; at < pages.length; at += STATUS_BATCH)
      out.push(
        ...(await post({ action: "status", page_ids: pages.slice(at, at + STATUS_BATCH) })).cells,
      );
    for (let at = 0; at < cellIds.length; at += STATUS_BATCH)
      out.push(
        ...(await post({ action: "status", cell_ids: cellIds.slice(at, at + STATUS_BATCH) })).cells,
      );
    return out;
  };
  try {
    let scope;
    if (all) {
      const cellIds = [...new Set(await transport.cells())];
      scope = { cellIds };
      // Cross-check: every Page an account's Catalog names should be a cell.
      const accounts = await post({ action: "accounts" });
      principals = accounts.principals;
      report.accounts = principals.length;
    } else if (principals.length) scope = { pageIds: [] };
    else scope = { pageIds: [...new Set(pageIds)] };
    const listed = new Set();
    for (const principal of principals)
      for (const { page_id } of (await post({ action: "targets", principal })).pages ?? [])
        listed.add(page_id);
    if (!all && principals.length) scope.pageIds = [...listed].sort();
    const before = await statuses(scope);
    report.targets = before.length;
    report.before = summarize(before);
    if (all) {
      const named = new Set(before.map((status) => status.page_id).filter(Boolean));
      report.catalog_only = [...listed].filter((id) => !named.has(id)).sort();
    }
    if (mode === "status") {
      report.remaining = before.filter(remains).map(brief);
      return report;
    }
    if (before.some((status) => status.refusal === "switch_off"))
      throw Error(
        "The target's Page hosts don't have PAGES_RECORD_STORAGE=automerge: install a release " +
          "whose profile sets recordStorage automerge first",
      );
    let done = 0;
    for (const status of before) {
      if (!convertible(status)) {
        if (remains(status)) report.not_converted.push(brief(status));
        continue;
      }
      if (done >= max) {
        report.not_converted.push({ ...brief(status), refusal: "max_reached" });
        continue;
      }
      if (done > 0 && pauseMs) await sleep(pauseMs);
      done++;
      const result = await post({
        action: "convert",
        page_id: status.page_id,
        ...(status.owner && { owner: status.owner }),
      });
      if (result.status?.record_storage === "automerge") report.converted.push(status.page_id);
      else
        report.failed.push({
          page_id: status.page_id,
          outcome: result.outcome,
          status: result.status,
        });
    }
    const after = await statuses(scope);
    report.after = summarize(after);
    report.remaining = after.filter(remains).map(brief);
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
  try {
    const report = await operatorRun({ ...args, transport: sshTransport(config, ROUTE), log });
    process.stdout.write(`${JSON.stringify({ target: config.target, ...report }, null, 2)}\n`);
    if (report.failed.length) process.exitCode = 2;
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
