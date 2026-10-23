// Narrow tunnel change only. DNS is a separate operation after route validation.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deploymentProfile, stageTarget, verifyDeployment } from "./profiles.mjs";
import { routesFor } from "./routes.mjs";
export { routesFor } from "./routes.mjs";
export const legacyRoutes = routesFor("pages-next", true);
export const routes = routesFor();

export function insertRoutes(before, target = "pages-next") {
  if (deploymentProfile(target).frozenTargets)
    throw new Error("This target requires its dedicated tunnel publisher");
  const { hostname } = deploymentProfile(target).deployment;
  const updated = routesFor(target);
  if (before.includes(hostname)) {
    for (const known of [updated, routesFor(target, true)]) {
      const parts = before.split(known);
      if (
        parts.length === 2 &&
        !parts.join("").includes(hostname) &&
        (!parts[0] || parts[0].endsWith("\n")) &&
        (!parts[1] || parts[1].startsWith("  - "))
      )
        return parts.join(updated);
    }
    throw new Error("Conflicting Pages routes for " + hostname);
  }
  const anchor = '  - hostname: "*.runtimed.run"\n';
  if (before.split(anchor).length !== 2) throw new Error("Tunnel wildcard layout changed");
  return before.replace(anchor, updated + anchor);
}

// An earlier publication's backup must survive. A failed attempt can reuse only
// the exact same regular file; exclusive creation never follows a symlink.
export function backupRoutes(before, sourceSha, directory = "/etc/nteract-pages-next") {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("Invalid prepared source");
  const digest = createHash("sha256").update(before).digest("hex");
  const file = path.join(directory, "cloudflared." + sourceSha + "." + digest + ".before.yml");
  try {
    writeFileSync(file, before, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!lstatSync(file).isFile() || readFileSync(file, "utf8") !== before)
      throw new Error("Existing tunnel backup differs; inspect before retrying");
  }
  return file;
}
const configHash = (text) => createHash("sha256").update(text).digest("hex");
const pendingPath = (directory) => path.join(directory, "cloudflared.pending.json");
function readRegular(file) {
  if (!lstatSync(file).isFile()) throw new Error("Publication state must be a regular file");
  return readFileSync(file, "utf8");
}
function restartWithConfig(config, expectedHash, restart) {
  if (configHash(readRegular(config)) !== expectedHash)
    throw new Error("Concurrent tunnel update; pending reload retained");
  if (restart() !== "active") throw new Error("Tunnel service is not active after restart");
  if (configHash(readRegular(config)) !== expectedHash)
    throw new Error("Concurrent tunnel update; pending reload retained");
}

// Resolve an interrupted publication before the unchanged-config fast path.
export function resumePublication({
  config,
  candidate,
  sourceSha,
  directory,
  restart,
  target = "pages-next",
}) {
  const pending = pendingPath(directory);
  if (!existsSync(pending)) return false;
  const receipt = JSON.parse(readRegular(pending));
  if (
    receipt.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(sourceSha ?? "") ||
    receipt.source_sha !== sourceSha ||
    !/^[a-f0-9]{64}$/.test(receipt.before_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(receipt.after_sha256 ?? "")
  )
    throw new Error("Conflicting pending tunnel reload; inspect before retrying");
  const backup = path.join(
    directory,
    "cloudflared." + sourceSha + "." + receipt.before_sha256 + ".before.yml",
  );
  const before = readRegular(backup);
  const updated = insertRoutes(before, target);
  if (
    before === updated ||
    configHash(before) !== receipt.before_sha256 ||
    configHash(updated) !== receipt.after_sha256
  )
    throw new Error("Pending tunnel reload does not match its backup");
  const current = configHash(readRegular(config));
  if (current === receipt.after_sha256) {
    restartWithConfig(config, current, restart);
    unlinkSync(pending);
    return true;
  }
  if (current !== receipt.before_sha256)
    throw new Error("Concurrent tunnel update; pending reload retained");
  // Interrupted before rename (or during rollback): disk still needs migration.
  // Remove only this attempt's exact candidate, then revalidate normally.
  if (existsSync(candidate)) {
    if (readRegular(candidate) !== updated) throw new Error("Existing candidate differs");
    unlinkSync(candidate);
  }
  unlinkSync(pending);
  return false;
}

export function applyPublication({
  config,
  candidate,
  before,
  updated,
  sourceSha,
  directory,
  restart,
}) {
  backupRoutes(before, sourceSha, directory);
  if (readRegular(config) !== before || readRegular(candidate) !== updated)
    throw new Error("Concurrent tunnel update; retry after inspection");
  const pending = pendingPath(directory);
  writeFileSync(
    pending,
    JSON.stringify({
      schema: 1,
      source_sha: sourceSha,
      before_sha256: configHash(before),
      after_sha256: configHash(updated),
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  // The receipt must exist before replacing disk configuration: a killed
  // process cannot let the next run mistake these bytes for a completed reload.
  renameSync(candidate, config);
  try {
    restartWithConfig(config, configHash(updated), restart);
  } catch (error) {
    if (readRegular(config) !== updated) throw error;
    writeFileSync(config, before, { mode: 0o600 });
    restartWithConfig(config, configHash(before), restart);
    unlinkSync(pending);
    throw error;
  }
  unlinkSync(pending);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, apply, extra] = process.argv.slice(2);
  if (process.getuid() !== 0 || apply !== "--apply" || extra)
    throw new Error("Explicit root publication with prepared stage required");
  const target = stageTarget(stage);
  if (deploymentProfile(target).tunnelService) {
    const { publishIsolated } = await import("./isolated-publication.mjs");
    console.log(JSON.stringify(publishIsolated(stage)));
    process.exit(0);
  }
  const manifest = JSON.parse(readFileSync(stage + "/manifest.json"));
  const deployment = verifyDeployment(manifest, target);
  const directory = "/etc/" + deployment.service;
  const ownership = JSON.parse(readFileSync(directory + "/ownership.json"));
  if (
    ownership.hostname !== deployment.hostname ||
    ownership.prefix !== deployment.prefix ||
    manifest.deployment.hostname !== ownership.hostname
  )
    throw new Error("Unexpected publication target");
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
  if (run("systemctl", ["is-active", deployment.service]) !== "active")
    throw new Error("Prototype service is not active");
  const health = JSON.parse(
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "http://" + deployment.listen + "/health",
    ]),
  );
  if (health.ok !== true || health.prototype !== "pages-celld-native")
    throw new Error("Unexpected local prototype health response");
  const config = "/etc/cloudflared/config.yml";
  const candidate = "/etc/cloudflared/" + target + "-candidate.yml";
  const publication = {
    config,
    candidate,
    sourceSha: manifest.source_sha,
    directory,
    target,
    restart: () => {
      run("systemctl", ["restart", "cloudflared.service"]);
      return run("systemctl", ["is-active", "cloudflared.service"]);
    },
  };
  if (resumePublication(publication)) {
    console.log(
      JSON.stringify({
        published: true,
        changed: false,
        reloaded: true,
        hostname: ownership.hostname,
      }),
    );
    process.exit(0);
  }
  const before = readFileSync(config, "utf8");
  const updated = insertRoutes(before, target);
  if (updated === before) {
    console.log(JSON.stringify({ published: true, changed: false, hostname: ownership.hostname }));
    process.exit(0);
  }
  if (existsSync(candidate)) throw new Error("Existing candidate requires inspection");
  writeFileSync(candidate, updated, { mode: 0o600, flag: "wx" });
  try {
    run("/usr/bin/cloudflared", ["--config", candidate, "tunnel", "ingress", "validate"]);
    const origin = "https://" + deployment.hostname;
    const checks = [
      [origin + "/", deployment.listen],
      [origin + "/api/sync?page=test", deployment.listen],
      [origin + "/mcp", deployment.listen],
      [origin + "/llms.txt", deployment.listen],
      [origin + "/p/12345678-1234-4123-8123-123456789abc", deployment.listen],
      [origin + "/p/12345678-1234-4123-8123-123456789abc/", deployment.listen],
      [origin + "/api/pages/register", deployment.listen],
      [origin + "/p/not-a-page", "http_status:404"],
      [origin + "/llms.txt/private", "http_status:404"],
      [origin + "/state", "http_status:404"],
      [origin + "/internal/create", "http_status:404"],
      [origin + "/internal/register", "http_status:404"],
      [origin + "/dev/oidc/authorize", "http_status:404"],
    ];
    for (const [url, expected] of checks)
      if (
        !run("/usr/bin/cloudflared", [
          "--config",
          candidate,
          "tunnel",
          "ingress",
          "rule",
          url,
        ]).includes(expected)
      )
        throw new Error("New route validation failed for " + url);
    // Compare current routing itself, rather than assuming older fleet ports.
    for (const url of [
      "https://m.runtimed.run/",
      "https://m.runtimed.run/api/sync?page=test",
      "https://main.runtimed.run/",
      "https://deploy.runtimed.run/operator",
      ...(target === "page3"
        ? ["https://pages-next.runtimed.run/", "https://pages-next.runtimed.run/api/sync?page=test"]
        : ["https://page3.runtimed.run/", "https://page3.runtimed.run/api/sync?page=test"]),
    ]) {
      const current = run("/usr/bin/cloudflared", [
        "--config",
        config,
        "tunnel",
        "ingress",
        "rule",
        url,
      ]);
      const next = run("/usr/bin/cloudflared", [
        "--config",
        candidate,
        "tunnel",
        "ingress",
        "rule",
        url,
      ]);
      const service = /service:\s*(\S+)/.exec(current)?.[1];
      if (!service || !next.includes("service: " + service))
        throw new Error("Existing hostname routing changed");
    }
    applyPublication({ ...publication, before, updated });
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
  console.log(
    JSON.stringify({
      published: true,
      changed: true,
      hostname: ownership.hostname,
      dnsConfigured: false,
    }),
  );
}
