// Each isolated target owns its tunnel and connector. Never modify frozen neighbors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { deploymentProfile, stageTarget, verifyDeployment } from "./profiles.mjs";
import { routesFor, chunkPaths, imagePaths } from "./routes.mjs";

const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
function publicationPaths(target) {
  const profile = deploymentProfile(target);
  if (!profile.tunnelService) throw new Error("A dedicated tunnel target is required");
  const directory = "/etc/" + profile.deployment.service;
  return {
    directory,
    service: profile.tunnelService,
    configPath: directory + "/tunnel.yml",
    credentialsPath: directory + "/tunnel.json",
    unitPath: "/etc/systemd/system/" + profile.tunnelService,
  };
}
const hash = (text) => createHash("sha256").update(text).digest("hex");

export function isolatedPublicationPlan({
  manifest,
  ownership,
  credentials,
  tunnelReceipt,
  sharedConfig,
  frozenTunnelConfigs = [],
  target = "page3",
}) {
  const deployment = verifyDeployment(manifest, target);
  const { service, configPath, credentialsPath, unitPath } = publicationPaths(target);
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
    tunnelReceipt.name !== deployment.service ||
    tunnelReceipt.config_src !== "local"
  )
    throw new Error(
      "Dedicated " + target + " tunnel credentials and provisioning receipt required",
    );
  for (const config of [sharedConfig, ...frozenTunnelConfigs]) {
    const existingId = /^tunnel:\s*["']?([a-f0-9-]{36})["']?\s*$/m.exec(config)?.[1];
    if (!existingId || existingId === tunnelId)
      throw new Error("Isolated targets must use a different tunnel from frozen connectors");
  }
  const config = `tunnel: ${tunnelId}
credentials-file: ${credentialsPath}
ingress:
${routesFor(target)}  - service: http_status:404
`;
  const unit = `[Unit]
Description=Isolated ${target} Cloudflare Tunnel
After=network-online.target ${deployment.service}.service
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
  const target = stageTarget(stage);
  const profile = deploymentProfile(target);
  const { directory, service, configPath, credentialsPath, unitPath } = publicationPaths(target);
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
  const frozenConfigs = new Map(),
    frozenPids = new Map();
  const frozenTunnelConfigs = [];
  for (const frozenTarget of profile.frozenTargets ?? []) {
    const frozen = deploymentProfile(frozenTarget);
    for (const name of [frozen.deployment.service, frozen.tunnelService].filter(Boolean)) {
      const unit = name.endsWith(".service") ? name : name + ".service";
      frozenPids.set(unit, run("systemctl", ["show", unit, "--property=MainPID", "--value"]));
      const unitPath = "/etc/systemd/system/" + unit;
      frozenConfigs.set(unitPath, read(unitPath));
    }
    if (frozen.tunnelService) {
      const config = "/etc/" + frozen.deployment.service + "/tunnel.yml";
      const contents = read(config);
      frozenConfigs.set(config, contents);
      frozenTunnelConfigs.push(contents);
    }
  }
  const manifest = readJson(stage + "/manifest.json");
  const plan = isolatedPublicationPlan({
    manifest,
    ownership: readJson(directory + "/ownership.json"),
    credentials: readJson(credentialsPath, true),
    tunnelReceipt: readJson(directory + "/tunnel-provisioning.json"),
    sharedConfig,
    frozenTunnelConfigs,
    target,
  });
  if (run("systemctl", ["is-active", profile.deployment.service]) !== "active")
    throw new Error("Isolated Pages service is not active");
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
    throw new Error("Unexpected local Pages health response");
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
  // Only the exact known predecessor for this target may migrate. Other targets
  // and arbitrary local edits still require inspection instead of adoption.
  const previousConfig =
    target === "page3"
      ? plan.config.replace("|mermaid[.]js|", "|")
      : target === "page5"
        ? plan.config.replace("|connect|connect[.]js|", "|")
        : target === "page7"
          ? plan.config.replace(imagePaths, "")
          : target === "page8"
            ? plan.config.replace("|theme[.]js|", "|")
            : target === "page9"
              ? plan.config.replace("|" + chunkPaths, "|")
              : null;
  const previousReceipt = previousConfig === null ? null : receiptFor(previousConfig);
  const pendingReceipt =
    previousConfig === null
      ? null
      : receiptFor(plan.config, { previous_config_sha256: hash(previousConfig) });
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
      if (
        previousConfig === null ||
        (installed !== previousReceipt && installed !== pendingReceipt)
      )
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
    const sharing = profile.sharing === true;
    const oauth = profile.oauth === true;
    const chunks = profile.viewerChunks === true;
    const assets = "/api/pages/08c583e5-d29e-4f1e-b06b-333965254e94/assets";
    run("/usr/bin/cloudflared", ["--config", file, "tunnel", "ingress", "validate"]);
    for (const [pathname, expected] of [
      ["/", plan.listen],
      ["/mcp", plan.listen],
      ["/connect", sharing ? plan.listen : "http_status:404"],
      ["/connect.js", sharing ? plan.listen : "http_status:404"],
      ["/connect/private", "http_status:404"],
      ["/connect.js/private", "http_status:404"],
      ["/connectXjs", "http_status:404"],
      ["/mermaid.js", plan.listen],
      ["/mermaid.js/private", "http_status:404"],
      ["/mermaidXjs", "http_status:404"],
      ["/theme.js", profile.theme ? plan.listen : "http_status:404"],
      ["/theme.js/private", "http_status:404"],
      ["/themeXjs", "http_status:404"],
      ["/theme.js/", "http_status:404"],
      ["/chunks/ABCDEFGH.js", chunks ? plan.listen : "http_status:404"],
      ["/chunks/abcdefgh.js", "http_status:404"],
      ["/chunks/ABCDEFGH.js/private", "http_status:404"],
      ["/chunks/ABCDEFGH.css", "http_status:404"],
      ["/chunks/ABCDEFGHI.js", "http_status:404"],
      ["/chunks/", "http_status:404"],
      ["/api/sync", plan.listen],
      ["/api/access", sharing ? plan.listen : "http_status:404"],
      ["/api/access/private", "http_status:404"],
      ["/llms.txt", plan.listen],
      ["/oidc", plan.listen],
      ["/oauth/authorize", oauth ? plan.listen : "http_status:404"],
      ["/oauth/token", oauth ? plan.listen : "http_status:404"],
      ["/oauth/revoke", oauth ? plan.listen : "http_status:404"],
      ["/.well-known/oauth-protected-resource/mcp", oauth ? plan.listen : "http_status:404"],
      ["/.well-known/oauth-protected-resource", oauth ? plan.listen : "http_status:404"],
      ["/.well-known/oauth-authorization-server", oauth ? plan.listen : "http_status:404"],
      ["/oauth/test/callback", "http_status:404"],
      ["/oauth/token/private", "http_status:404"],
      ["/.well-known/oauth-protected-resource/private", "http_status:404"],
      [assets, oauth ? plan.listen : "http_status:404"],
      [assets + "/" + "a".repeat(64), oauth ? plan.listen : "http_status:404"],
      ["/api/pages/arbitrary/assets", "http_status:404"],
      [assets + "/private", "http_status:404"],
      [assets + "/" + "a".repeat(64) + "/private", "http_status:404"],
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
  for (const [file, contents] of frozenConfigs)
    if (read(file) !== contents)
      throw new Error("Frozen Pages configuration changed during publication");
  for (const [unit, pid] of frozenPids)
    if (run("systemctl", ["show", unit, "--property=MainPID", "--value"]) !== pid)
      throw new Error("Frozen Pages service changed during publication");
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
    ...(profile.frozenTargets ? { frozenTargetsUnchanged: profile.frozenTargets } : {}),
  };
}
