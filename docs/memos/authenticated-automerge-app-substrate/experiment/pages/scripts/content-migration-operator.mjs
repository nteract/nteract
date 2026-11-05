// ONE-SHOT MIGRATION client: delete with worker/content-migration.mjs.
//
// Run the content migration for every account on a celld lab target, from an
// operator machine over SSH. Each call is one SSH command to the target host
// that reads the root-only operator secret the installer wrote and posts to
// the Worker's operator route on the public listener's loopback address, as
// the service user (the listener's firewall admits only root and that user).
// The route lives only where the secret is configured, and refuses anything
// the Cloudflare edge forwarded (worker/content-migration.mjs).
//
// The run: list the accounts (the D1 catalog projection), drive each
// account's Catalog through `dry_run` or `apply` until it has covered every
// Page, then diff the cells the runs reached against `celld cell list Page`
// and probe each one no run reached, so it can be passed to its owner's run.
// Every response is appended to a JSON-lines log as it arrives; a failure
// still prints the report so far.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deploymentProfile } from "./deployment/profiles.mjs";
import { drive } from "./content-migration.mjs";

export const USAGE = `Usage:
  node scripts/content-migration-operator.mjs --target pages --mode dry_run
  node scripts/content-migration-operator.mjs --target pages --mode apply

Options:
  --target NAME         Required: pages or page10 (profiles with operatorMigration).
  --mode MODE           Required: dry_run or apply.
  --principal P         Run only this account (repeatable). Default: every
                        account the catalog projection lists.
  --include-connected   Apply to Pages with live sockets instead of skipping them.
  --limit N             Pages per call, 1–25 (default 10).
  --log PATH            Append each response as one JSON line (default
                        content-migration-operator-<target>-<mode>-<time>.jsonl).
  --no-cells            Skip the celld cell list diff and probes.
  --ssh-host HOST       SSH destination; the profile's host (lab1) by default.
  --max-calls N         Stop one account after N calls (default 100).`;

const SAFE = /^[A-Za-z0-9._:/@+-]+$/;
const SSH_TIMEOUT_MS = 150_000;
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
  args.log ??= `content-migration-operator-${args.target}-${args.mode}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.jsonl`;
  return args;
}

/** What the remote commands need from the target's profile. */
export function operatorConfig(target, sshHost) {
  const profile = deploymentProfile(target);
  if (!profile.operatorMigration)
    throw Error(`${target} has no operator route: its profile doesn't set operatorMigration`);
  const { host, service, listen, bucket, prefix, region } = profile.deployment;
  const config = {
    target,
    host: sshHost ?? host,
    service,
    listen,
    runtime: `/opt/${service}/celld`,
    bucket: `s3://${bucket}/${prefix}`,
    region,
  };
  for (const value of Object.values(config))
    if (typeof value !== "string" || !SAFE.test(value))
      throw Error(`Unexpected character in ${target}'s profile: ${value}`);
  return config;
}

export const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The bash script the target host runs for one operator call: the JSON body
 * on stdin, the response body then its HTTP status on the last line. The
 * secret travels to curl in its config on stdin, never on a command line.
 */
export function callScript(config) {
  const url = `http://${config.listen}/api/operator/content-migration`;
  return [
    "set -euo pipefail",
    `secret=$(sudo -n cat /etc/${config.service}/operator-secret 2>/dev/null || true)`,
    'if [ -z "$secret" ]; then echo "operator secret missing: install a build with operatorMigration" >&2; exit 3; fi',
    "body=$(cat)",
    "esc=${body//\\\\/\\\\\\\\}",
    'esc=${esc//\\"/\\\\\\"}',
    "{",
    `  printf '%s\\n' 'url = "${url}"' 'request = "POST"' 'header = "content-type: application/json"'`,
    `  printf 'header = "x-pages-operator-secret: %s"\\n' "$secret"`,
    `  printf 'data-raw = "%s"\\n' "$esc"`,
    `  printf '%s\\n' 'silent' 'show-error' 'max-time = 140' 'write-out = "\\\\n%{http_code}"'`,
    `} | sudo -n -u ${config.service} curl -K -`,
  ].join("\n");
}

/** The bash script that lists the target's Page cells (read-only). */
export function cellsScript(config) {
  return [
    "set -euo pipefail",
    `sudo -n -u ${config.service} ${config.runtime} cell list Page --bucket ${config.bucket} --region ${config.region} --all --json`,
  ].join("\n");
}

function sshRun(config, script, input) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        "--",
        config.host,
        `bash -c ${shellQuote(script)}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), SSH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** The two remote operations over SSH: `call(body)` and `cells()`. */
export function sshTransport(config) {
  return {
    async call(body) {
      const { code, stdout, stderr } = await sshRun(
        config,
        callScript(config),
        JSON.stringify(body),
      );
      if (code !== 0) throw Error(`ssh exited ${code}: ${stderr.trim()}`);
      const cut = stdout.lastIndexOf("\n");
      return { status: Number(stdout.slice(cut + 1)), text: stdout.slice(0, cut) };
    },
    async cells() {
      const { code, stdout, stderr } = await sshRun(config, cellsScript(config));
      if (code !== 0) throw Error(`celld cell list exited ${code}: ${stderr.trim()}`);
      return stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line).id);
    },
  };
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
          ...(result.tombstones && { tombstones: result.tombstones }),
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
