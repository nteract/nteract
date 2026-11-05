// ONE-SHOT MIGRATION client transport: delete with the operator script
// (scripts/record-storage-operator.mjs).
//
// One SSH command per operator call to the target host. It reads the
// root-only operator secret the installer wrote and posts to the Worker's
// operator route on the public listener's loopback address, as the service
// user (the listener's firewall admits only root and that user). The routes
// live only where the secret is configured, and refuse anything the
// Cloudflare edge forwarded (worker/operator-gate.mjs).
import { spawn } from "node:child_process";
import { deploymentProfile } from "./deployment/profiles.mjs";

const SAFE = /^[A-Za-z0-9._:/@+-]+$/;
const SSH_TIMEOUT_MS = 150_000;

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
export function callScript(config, route) {
  const url = `http://${config.listen}${route}`;
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
export function sshTransport(config, route) {
  return {
    async call(body) {
      const { code, stdout, stderr } = await sshRun(
        config,
        callScript(config, route),
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
