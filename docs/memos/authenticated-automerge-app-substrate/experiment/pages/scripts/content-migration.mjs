// ONE-SHOT MIGRATION client: delete with worker/content-migration.mjs.
//
// Drive the owner's content migration over HTTP until it has covered every
// Page, and print one JSON report. `dry_run` follows `next` until the end;
// `apply` calls until the run is `done` or `incomplete`. Each response is
// appended to a JSON-lines log as it arrives, so apply's per-block detail
// survives a failed call; a failure prints the report so far. It only calls
// `/api/admin/content-migration` with the caller's own credential, so it can
// only reach that account's Pages.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const USAGE = `Usage:
  PAGES_API_KEY=... node scripts/content-migration.mjs --origin https://pages.example --mode dry_run
  PAGES_API_KEY=... node scripts/content-migration.mjs --origin https://pages.example --mode apply

Options:
  --origin URL      Required. The Pages origin.
  --mode MODE       Required: dry_run or apply.
  --limit N         Pages per call, 1–25 (default 10).
  --page-id ID      Also visit this Page (repeatable): a Page cell no Catalog
                    key names. Its host checks that you own it.
  --max-calls N     Stop after N calls (default 100).
  --log PATH        Append each response as one JSON line (default
                    content-migration-<mode>-<time>.jsonl).

The credential is an API key with write access in PAGES_API_KEY.`;

export function parseArgs(argv) {
  const args = {
    origin: undefined,
    mode: undefined,
    limit: 10,
    pageIds: [],
    maxCalls: 100,
    log: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--origin") args.origin = value;
    else if (flag === "--mode") args.mode = value;
    else if (flag === "--limit") args.limit = Number(value);
    else if (flag === "--page-id") args.pageIds.push(value);
    else if (flag === "--max-calls") args.maxCalls = Number(value);
    else if (flag === "--log") args.log = value;
    else throw Error(`Unknown argument ${flag}\n${USAGE}`);
    i++;
  }
  if (!args.origin || !["dry_run", "apply"].includes(args.mode)) throw Error(USAGE);
  args.log ??= `content-migration-${args.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  return args;
}

const add = (into, from) => {
  for (const [key, value] of Object.entries(from ?? {}))
    into[key] = typeof value === "number" ? (into[key] ?? 0) + value : add(into[key] ?? {}, value);
  return into;
};

/** Call the endpoint until the mode has covered every Page. `call(body)`
 * answers the parsed JSON response or throws; `onResponse(body)` sees each
 * response first. Returns the aggregate; a failure throws with the aggregate
 * so far as `error.report`. */
export async function drive({ mode, limit, pageIds = [], maxCalls = 100, call, onResponse }) {
  const report = { mode, calls: 0, pages: [], visited: [], totals: {}, progress: null };
  let after = null;
  for (;;) {
    let body;
    try {
      if (report.calls >= maxCalls) throw Error(`Stopped after ${maxCalls} calls`);
      body = await call({
        mode,
        limit,
        ...(pageIds.length && { page_ids: pageIds }),
        ...(after && { after }),
      });
      onResponse?.(body);
    } catch (error) {
      throw Object.assign(error, { report });
    }
    report.calls++;
    report.pages.push(...body.pages);
    report.visited.push(...body.visited);
    add(report.totals, body.totals);
    report.progress = body.progress;
    if (mode === "dry_run") {
      report.targets = body.targets;
      report.tombstones = body.tombstones;
      if (!body.next) return report;
      after = body.next;
    } else if (["done", "incomplete"].includes(body.progress?.phase)) return report;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.PAGES_API_KEY;
  if (!token) throw Error("Set PAGES_API_KEY");
  const call = async (body) => {
    const response = await fetch(new URL("/api/admin/content-migration", args.origin), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      log({ status: response.status, refusal: value });
      throw Error(`${response.status} ${JSON.stringify(value)}`);
    }
    return value;
  };
  const log = (body) =>
    appendFileSync(args.log, `${JSON.stringify({ at: new Date().toISOString(), ...body })}\n`);
  const onResponse = log;
  process.stderr.write(`Logging each response to ${args.log}\n`);
  try {
    const report = await drive({ ...args, call, onResponse });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (error.report) process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
