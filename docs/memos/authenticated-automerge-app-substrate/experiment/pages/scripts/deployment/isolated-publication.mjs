// Page3 owns a separate tunnel and connector. Never modify shared cloudflared.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { verifyDeployment } from "./profiles.mjs";
import { routesFor } from "./routes.mjs";

const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
const directory = "/etc/nteract-page3";
const service = "cloudflared-page3.service";
const configPath = directory + "/tunnel.yml";
const credentialsPath = directory + "/tunnel.json";
const unitPath = "/etc/systemd/system/" + service;
const hash = (text) => createHash("sha256").update(text).digest("hex");

export function isolatedPublicationPlan({
  manifest,
  ownership,
  credentials,
  tunnelReceipt,
  sharedConfig,
}) {
  const deployment = verifyDeployment(manifest, "page3");
  const tunnelId = credentials.TunnelID;
  if (
    ownership.hostname !== deployment.hostname ||
    ownership.prefix !== deployment.prefix ||
    credentials.AccountTag !== accountId ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(tunnelId ?? "") ||
    typeof credentials.TunnelSecret !== "string" ||
    Buffer.from(credentials.TunnelSecret, "base64").length !== 32 ||
    Buffer.from(credentials.TunnelSecret, "base64").toString("base64") !==
      credentials.TunnelSecret ||
    tunnelReceipt.schema !== 1 ||
    tunnelReceipt.account_id !== accountId ||
    tunnelReceipt.tunnel_id !== tunnelId ||
    tunnelReceipt.name !== "nteract-page3" ||
    tunnelReceipt.config_src !== "local"
  )
    throw new Error("Dedicated page3 tunnel credentials and provisioning receipt required");
  const sharedId = /^tunnel:\s*["']?([a-f0-9-]{36})["']?\s*$/m.exec(sharedConfig)?.[1];
  if (!sharedId || sharedId === tunnelId)
    throw new Error("Page3 must use a different tunnel from the shared connector");
  const config = `tunnel: ${tunnelId}
credentials-file: ${credentialsPath}
ingress:
${routesFor("page3")}  - service: http_status:404
`;
  const unit = `[Unit]
Description=Isolated page3 Cloudflare Tunnel
After=network-online.target nteract-page3.service
Wants=network-online.target

[Service]
Type=notify
User=root
ExecStart=/usr/bin/cloudflared --no-autoupdate --config ${configPath} tunnel run
Restart=on-failure
RestartSec=5
TimeoutStartSec=60
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
UMask=0077

[Install]
WantedBy=multi-user.target
`;
  return {
    config,
    unit,
    configPath,
    unitPath,
    service,
    tunnelId,
    hostname: deployment.hostname,
    listen: deployment.listen,
  };
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      command + " failed (status " + error.status + "); inspect restricted server logs",
    );
  }
}
export function publishIsolated(stage, { filesystem = fs, run = runCommand } = {}) {
  const read = (file, secret = false) => {
    const stat = filesystem.lstatSync(file);
    if (!stat.isFile() || (secret && (stat.uid !== 0 || stat.mode & 0o077)))
      throw new Error("Tunnel files must be regular; credentials must be private and root-owned");
    return filesystem.readFileSync(file, "utf8");
  };
  const readJson = (file, secret = false) => {
    try {
      return JSON.parse(read(file, secret));
    } catch {
      throw new Error("Invalid or unsafe dedicated tunnel JSON file: " + file);
    }
  };
  const sharedConfig = read("/etc/cloudflared/config.yml");
  const sharedPid = run("systemctl", [
    "show",
    "cloudflared.service",
    "--property=MainPID",
    "--value",
  ]);
  const manifest = readJson(stage + "/manifest.json");
  const plan = isolatedPublicationPlan({
    manifest,
    ownership: readJson(directory + "/ownership.json"),
    credentials: readJson(credentialsPath, true),
    tunnelReceipt: readJson(directory + "/tunnel-provisioning.json"),
    sharedConfig,
  });
  if (run("systemctl", ["is-active", "nteract-page3"]) !== "active")
    throw new Error("Page3 service is not active");
  const health = JSON.parse(
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "http://" + plan.listen + "/health",
    ]),
  );
  if (health.ok !== true || health.prototype !== "pages-celld-native")
    throw new Error("Unexpected local page3 health response");
  const installation = directory + "/tunnel-installation.json";
  const receiptFor = (config, extra = {}) =>
    JSON.stringify({
      schema: 1,
      tunnel_id: plan.tunnelId,
      config_sha256: hash(config),
      unit_sha256: hash(plan.unit),
      ...extra,
    }) + "\n";
  const receipt = receiptFor(plan.config);
  // This is one known migration, not permission to adopt arbitrary tunnel edits.
  const previousConfig = plan.config.replace("|mermaid[.]js|", "|");
  const previousReceipt = receiptFor(previousConfig);
  const pendingReceipt = receiptFor(plan.config, { previous_config_sha256: hash(previousConfig) });
  const candidate = (file, contents) => {
    // Distinct expected byte sequences cannot strand one another after a
    // crash between staging and renaming an upgrade or rollback.
    const next = file + ".next." + hash(contents);
    if (filesystem.existsSync(next)) {
      if (read(next) !== contents) throw new Error("Dedicated tunnel candidate differs");
    } else filesystem.writeFileSync(next, contents, { mode: 0o600, flag: "wx" });
    return next;
  };
  const replace = (file, contents) => filesystem.renameSync(candidate(file, contents), file);
  let upgrading = false;
  if (filesystem.existsSync(installation)) {
    const installed = read(installation);
    if (installed !== receipt) {
      if (installed !== previousReceipt && installed !== pendingReceipt)
        throw new Error("Dedicated tunnel installation differs; inspect before retrying");
      const current = read(configPath);
      if (
        read(unitPath) !== plan.unit ||
        (current !== previousConfig && (installed !== pendingReceipt || current !== plan.config))
      )
        throw new Error("Dedicated tunnel migration requires exact previous files");
      // Validate the new bytes before changing the active file. The pending
      // receipt survives a crash on either side of the atomic config rename;
      // retries must restart this connector before sealing the final receipt.
      const next = candidate(configPath, plan.config);
      validateRoutes(next);
      if (
        read(configPath) !== current ||
        read(unitPath) !== plan.unit ||
        read(installation) !== installed
      )
        throw new Error("Dedicated tunnel changed during migration validation");
      if (installed === previousReceipt) replace(installation, pendingReceipt);
      filesystem.renameSync(next, configPath);
      upgrading = true;
    }
  } else {
    if (
      filesystem.existsSync(configPath) ||
      filesystem.existsSync(unitPath) ||
      run("systemctl", ["show", service, "--property=LoadState", "--value"]) !== "not-found"
    )
      throw new Error("Unowned dedicated tunnel configuration or service already exists");
    filesystem.writeFileSync(installation, receipt, { mode: 0o600, flag: "wx" });
  }
  // A crash may leave only part of our installation. Fill missing exact files;
  // never overwrite a modified file or adopt another service's unit.
  for (const [file, contents, mode] of [
    [configPath, plan.config, 0o600],
    [unitPath, plan.unit, 0o644],
  ]) {
    if (filesystem.existsSync(file)) {
      if (read(file) !== contents)
        throw new Error("Dedicated tunnel file differs; inspect before retrying");
    } else filesystem.writeFileSync(file, contents, { mode, flag: "wx" });
  }
  function validateRoutes(file) {
    run("/usr/bin/cloudflared", ["--config", file, "tunnel", "ingress", "validate"]);
    for (const [pathname, expected] of [
      ["/", plan.listen],
      ["/mcp", plan.listen],
      ["/mermaid.js", plan.listen],
      ["/mermaid.js/private", "http_status:404"],
      ["/mermaidXjs", "http_status:404"],
      ["/api/sync", plan.listen],
      ["/llms.txt", plan.listen],
      ["/oidc", plan.listen],
      ["/state", "http_status:404"],
      ["/internal/create", "http_status:404"],
    ]) {
      const rule = run("/usr/bin/cloudflared", [
        "--config",
        file,
        "tunnel",
        "ingress",
        "rule",
        "https://" + plan.hostname + pathname,
      ]);
      if (
        !rule.includes(
          "service: " + (expected.startsWith("http_status:") ? expected : "http://" + expected),
        )
      )
        throw new Error("Dedicated tunnel route validation failed");
    }
  }
  validateRoutes(configPath);
  run("systemd-analyze", ["verify", unitPath]);
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", service]);
  try {
    run("systemctl", [upgrading ? "restart" : "start", service]);
    if (run("systemctl", ["is-active", service]) !== "active")
      throw new Error("Dedicated tunnel connector is not active");
  } catch (error) {
    if (upgrading) {
      if (read(configPath) !== plan.config || read(installation) !== pendingReceipt)
        throw new Error("Dedicated tunnel changed during restart; pending migration retained");
      replace(configPath, previousConfig);
      run("systemctl", ["restart", service]);
      if (run("systemctl", ["is-active", service]) !== "active")
        throw new Error("Dedicated tunnel rollback is not active; pending migration retained");
      replace(installation, previousReceipt);
    }
    throw error;
  }
  if (
    read("/etc/cloudflared/config.yml") !== sharedConfig ||
    run("systemctl", ["show", "cloudflared.service", "--property=MainPID", "--value"]) !== sharedPid
  )
    throw new Error("Shared tunnel changed during publication; inspect before claiming isolation");
  if (upgrading) {
    if (
      read(configPath) !== plan.config ||
      read(unitPath) !== plan.unit ||
      read(installation) !== pendingReceipt
    )
      throw new Error(
        "Dedicated tunnel changed before completing migration; pending receipt retained",
      );
    replace(installation, receipt);
  }
  return {
    published: true,
    routesUpdated: upgrading,
    hostname: plan.hostname,
    tunnelId: plan.tunnelId,
    service,
    dnsConfigured: false,
    sharedTunnelUnchanged: true,
  };
}
