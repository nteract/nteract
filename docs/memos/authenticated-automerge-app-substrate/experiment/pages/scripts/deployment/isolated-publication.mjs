// Each isolated target owns its tunnel and connector. Never modify frozen neighbors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  SLOTS,
  connectorTransition,
  parseConnectorState,
  serializeConnectorState,
  settleConnector,
} from "./connector-slots.mjs";
import { deploymentProfile, stageTarget, verifyDeployment } from "./profiles.mjs";
import { routesFor, imagePaths, indexPaths, siftPaths } from "./routes.mjs";

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
    connectorPath: directory + "/tunnel-connector.json",
    unitPath: "/etc/systemd/system/" + profile.tunnelService,
  };
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
// A ready slot keeps overlapping the live one this long before the live one
// stops, so the edge has picked up the new connections first.
const CONNECTOR_SETTLE_MS = 5_000;
const READY_ATTEMPTS = 30;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
  // Type=notify: cloudflared reports ready once its first edge connection
  // registers, so `systemctl start` returns after that. A slot also serves
  // /ready on its own metrics listener and stops within a bounded grace period.
  const unitFor = (slot) => `[Unit]
Description=Isolated ${target} Cloudflare Tunnel${slot ? " connector " + slot.name : ""}
After=network-online.target ${deployment.service}.service
Wants=network-online.target

[Service]
Type=notify
User=root
ExecStart=/usr/bin/cloudflared --no-autoupdate --config ${configPath} tunnel${slot ? " --metrics " + slot.metrics + " --grace-period 10s" : ""} run
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
  const unit = unitFor(null);
  const profile = deploymentProfile(target);
  // `unit` stays the single connector unit: on a slotted target it is the
  // legacy unit publication migrates from.
  const slots = profile.tunnelSlots
    ? SLOTS.map((name) => {
        const slot = { name, ...profile.tunnelSlots[name] };
        return { ...slot, unitPath: "/etc/systemd/system/" + slot.service, unit: unitFor(slot) };
      })
    : null;
  return {
    config,
    unit,
    configPath,
    unitPath,
    service,
    slots,
    unitSha256: hash(slots ? slots.map((slot) => slot.unit).join("") : unit),
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
export function publishIsolated(
  stage,
  { filesystem = fs, run = runCommand, sleep = sleepSync } = {},
) {
  const target = stageTarget(stage);
  const profile = deploymentProfile(target);
  const { directory, service, configPath, credentialsPath, connectorPath, unitPath } =
    publicationPaths(target);
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
  const slotted = plan.slots !== null;
  const receiptFor = (config, unitSha256 = plan.unitSha256, extra = {}) =>
    JSON.stringify({
      schema: 1,
      tunnel_id: plan.tunnelId,
      config_sha256: hash(config),
      unit_sha256: unitSha256,
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
              ? plan.config.replace(indexPaths, "")
              : target === "page10" || target === "pages"
                ? plan.config.replace(siftPaths, "")
                : null;
  // Each predecessor is an exact (config, units) pair this run may migrate
  // from. A slotted target also migrates from its legacy single unit, with or
  // without a route change. Its pending receipt names the units to roll back to.
  const predecessors = [];
  const predecessor = (config, legacy) => {
    const unitSha256 = legacy ? hash(plan.unit) : plan.unitSha256;
    if (config === plan.config && unitSha256 === plan.unitSha256) return;
    predecessors.push({
      config,
      legacy,
      sealed: receiptFor(config, unitSha256),
      pending: receiptFor(plan.config, plan.unitSha256, {
        previous_config_sha256: hash(config),
        ...(slotted ? { previous_unit_sha256: unitSha256 } : {}),
      }),
    });
  };
  if (previousConfig !== null) predecessor(previousConfig, false);
  if (slotted) {
    if (previousConfig !== null) {
      predecessor(previousConfig, true);
      // The pending receipt a release before slots leaves when interrupted
      // between its config rename and its connector restart.
      predecessors.push({
        ...predecessors.at(-1),
        pending: receiptFor(plan.config, hash(plan.unit), {
          previous_config_sha256: hash(previousConfig),
        }),
      });
    }
    predecessor(plan.config, true);
  }
  const exactly = (file, contents) => filesystem.existsSync(file) && read(file) === contents;
  const slotUnitsInstalled = () => plan.slots.every((slot) => exactly(slot.unitPath, slot.unit));
  const unitsInstalled = (legacy) =>
    !slotted || legacy ? exactly(unitPath, plan.unit) : slotUnitsInstalled();
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
  let migration = null;
  if (filesystem.existsSync(installation)) {
    const installed = read(installation);
    if (installed !== receipt) {
      migration =
        predecessors.find(({ sealed, pending }) => installed === sealed || installed === pending) ??
        null;
      if (!migration)
        throw new Error("Dedicated tunnel installation differs; inspect before retrying");
      const current = read(configPath);
      if (
        !unitsInstalled(migration.legacy) ||
        (current !== migration.config &&
          (installed !== migration.pending || current !== plan.config))
      )
        throw new Error("Dedicated tunnel migration requires exact previous files");
      // Validate the new bytes before changing the active file. The pending
      // receipt survives a crash on either side of the atomic config rename;
      // retries must bring up a connector with these bytes before sealing the
      // final receipt.
      const next = candidate(configPath, plan.config);
      validateRoutes(next);
      if (
        read(configPath) !== current ||
        !unitsInstalled(migration.legacy) ||
        read(installation) !== installed
      )
        throw new Error("Dedicated tunnel changed during migration validation");
      if (installed === migration.sealed) replace(installation, migration.pending);
      filesystem.renameSync(next, configPath);
      upgrading = true;
    }
  } else {
    const units = [{ service, unitPath }, ...(plan.slots ?? [])];
    if (
      filesystem.existsSync(configPath) ||
      filesystem.existsSync(connectorPath) ||
      units.some(
        (unit) =>
          filesystem.existsSync(unit.unitPath) ||
          run("systemctl", ["show", unit.service, "--property=LoadState", "--value"]) !==
            "not-found",
      )
    )
      throw new Error("Unowned dedicated tunnel configuration or service already exists");
    filesystem.writeFileSync(installation, receipt, { mode: 0o600, flag: "wx" });
  }
  // A crash may leave only part of our installation. Fill missing exact files;
  // never overwrite a modified file or adopt another service's unit. A slotted
  // target's legacy unit is never written; one installed earlier stays until
  // its connector hands off, then remains stopped and disabled.
  for (const [file, contents, mode] of [
    [configPath, plan.config, 0o600],
    ...(slotted
      ? plan.slots.map((slot) => [slot.unitPath, slot.unit, 0o644])
      : [[unitPath, plan.unit, 0o644]]),
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
    const shell = profile.viewerAssets === true;
    const projects = profile.projectLinks === true;
    const index = profile.indexRoutes === true;
    const sift = profile.siftTables === true;
    const uuid = "08c583e5-d29e-4f1e-b06b-333965254e94";
    const assets = "/api/pages/" + uuid + "/assets";
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
      ["/app-ABCDEFGH.js", shell ? plan.listen : "http_status:404"],
      ["/app-ABCDEFGH.css", shell ? plan.listen : "http_status:404"],
      ["/theme-ABCDEFGH.js", shell ? plan.listen : "http_status:404"],
      ["/mermaid-ABCDEFGH.js", shell ? plan.listen : "http_status:404"],
      ["/automerge-ABCDEFGH.wasm", shell ? plan.listen : "http_status:404"],
      ["/subduction-ABCDEFGH.wasm", shell ? plan.listen : "http_status:404"],
      ["/sift-ABCDEFGH.wasm", sift ? plan.listen : "http_status:404"],
      ["/sift-ABCDEFGH.js", "http_status:404"],
      ["/sift-abcdefgh.wasm", "http_status:404"],
      ["/sift-ABCDEFGH.wasm/private", "http_status:404"],
      ["/app-abcdefgh.js", "http_status:404"],
      ["/app-ABCDEFGHI.js", "http_status:404"],
      ["/app-ABCDEFGH.wasm", "http_status:404"],
      ["/theme-ABCDEFGH.css", "http_status:404"],
      ["/automerge-ABCDEFGH.js", "http_status:404"],
      ["/connect-ABCDEFGH.js", "http_status:404"],
      ["/app-ABCDEFGH.js/private", "http_status:404"],
      ["/project/prj_" + uuid, projects ? plan.listen : "http_status:404"],
      ["/project/prj_" + uuid + "/", projects ? plan.listen : "http_status:404"],
      ["/project/sp_" + uuid, projects ? plan.listen : "http_status:404"],
      ["/s/sp_" + uuid, projects ? plan.listen : "http_status:404"],
      ["/s/prj_" + uuid, projects ? plan.listen : "http_status:404"],
      ["/project/" + uuid, "http_status:404"],
      ["/project/prj_not-a-project", "http_status:404"],
      ["/project/prj_" + uuid.toUpperCase(), "http_status:404"],
      ["/project/pg_" + uuid, "http_status:404"],
      ["/project/prj_" + uuid + "/private", "http_status:404"],
      ["/projects/prj_" + uuid, "http_status:404"],
      ["/project/", "http_status:404"],
      ["/s/" + uuid, "http_status:404"],
      ["/projects", index ? plan.listen : "http_status:404"],
      ["/projects/", index ? plan.listen : "http_status:404"],
      ["/pages", index ? plan.listen : "http_status:404"],
      ["/pages/", index ? plan.listen : "http_status:404"],
      ["/pages?q=roadmap", index ? plan.listen : "http_status:404"],
      ["/projects//", "http_status:404"],
      ["/pages//", "http_status:404"],
      ["/projects/private", "http_status:404"],
      ["/pages/private", "http_status:404"],
      ["/pages/" + uuid, "http_status:404"],
      ["/projectsX", "http_status:404"],
      ["/pagesX", "http_status:404"],
      ["/page", "http_status:404"],
      ["/Pages", "http_status:404"],
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
  for (const file of slotted ? plan.slots.map((slot) => slot.unitPath) : [unitPath])
    run("systemd-analyze", ["verify", file]);
  run("systemctl", ["daemon-reload"]);
  const connector = slotted ? handOffConnector() : restartConnector();

  // A single connector unit restarts in place. The edge has no connector
  // while it stops, so only frozen targets without slots take this path.
  function restartConnector() {
    run("systemctl", ["enable", service]);
    try {
      run("systemctl", [upgrading ? "restart" : "start", service]);
      if (run("systemctl", ["is-active", service]) !== "active")
        throw new Error("Dedicated tunnel connector is not active");
    } catch (error) {
      if (upgrading) {
        if (read(configPath) !== plan.config || read(installation) !== migration.pending)
          throw new Error("Dedicated tunnel changed during restart; pending migration retained");
        replace(configPath, migration.config);
        run("systemctl", ["restart", service]);
        if (run("systemctl", ["is-active", service]) !== "active")
          throw new Error("Dedicated tunnel rollback is not active; pending migration retained");
        replace(installation, migration.sealed);
      }
      throw error;
    }
    return null;
  }

  // Bring up the idle slot with the config on disk and stop the live unit only
  // after the new one holds an edge connection (connector-slots.mjs).
  function handOffConnector() {
    const slotNamed = (name) => plan.slots.find((slot) => slot.name === name);
    const unitOf = (name) => (name === "legacy" ? service : slotNamed(name).service);
    const active = (name) => run("systemctl", ["is-active", unitOf(name)]) === "active";
    const persist = (state) => replace(connectorPath, serializeConnectorState(state));
    const start = (name) => {
      const slot = slotNamed(name);
      // A resumed start can find the slot up with older routes: restart it.
      // The live unit still serves meanwhile.
      run("systemctl", [active(name) ? "restart" : "start", slot.service]);
      if (!active(name)) throw new Error("Tunnel connector " + slot.service + " is not active");
      awaitReady(slot);
      run("systemctl", ["enable", slot.service]);
      sleep(CONNECTOR_SETTLE_MS);
    };
    const stop = (name) => {
      run("systemctl", ["stop", unitOf(name)]);
      run("systemctl", ["disable", unitOf(name)]);
      if (active(name)) throw new Error("Tunnel connector " + unitOf(name) + " is still active");
    };
    let state;
    if (filesystem.existsSync(connectorPath)) state = parseConnectorState(read(connectorPath));
    else if (migration?.legacy)
      state = { phase: "serving", live: "legacy", config: hash(migration.config) };
    else {
      // Without a record or a legacy unit, nothing may already serve this
      // tunnel; a slot left running would keep serving routes no one tracks.
      if (plan.slots.some((slot) => active(slot.name)))
        throw new Error("Tunnel connector state is missing while a slot is active; inspect");
      state = { phase: "absent" };
    }
    const effects = { persist, start, stop };
    // The unit that served when this run began. A retry first finishes the
    // step an interrupted run left in flight.
    const servedBefore = state.phase === "stopping" ? state.previous : state.live;
    let { state: settled, failure } = settleConnector(state, effects);
    const want = hash(plan.config);
    if (
      !failure &&
      (settled.phase === "absent" || settled.live === "legacy" || settled.config !== want)
    ) {
      const swap = connectorTransition(settled, { type: "swap", config: want });
      persist(swap);
      ({ state: settled, failure } = settleConnector(swap, effects));
    }
    const handoff = !failure && settled.live !== servedBefore;
    if (failure) {
      if (upgrading) {
        if (read(configPath) !== plan.config || read(installation) !== migration.pending)
          throw new Error("Dedicated tunnel changed during handoff; pending migration retained");
        // The live unit never stopped and still serves these bytes.
        replace(configPath, migration.config);
        if (settled.phase === "serving" && !active(settled.live)) {
          run("systemctl", ["start", unitOf(settled.live)]);
          if (!active(settled.live))
            throw new Error("Dedicated tunnel rollback is not active; pending migration retained");
        }
        replace(installation, migration.sealed);
      }
      throw failure;
    }
    const live = slotNamed(settled.live);
    // A handoff just brought this slot up. Otherwise make sure it still runs.
    if (!handoff) {
      run("systemctl", ["enable", live.service]);
      run("systemctl", ["start", live.service]);
    }
    if (!active(live.name)) throw new Error("Dedicated tunnel connector is not active");
    return { slot: live, handoff };
  }

  // cloudflared's /ready answers 200 once the connector holds an edge
  // connection, and 503 until then.
  function awaitReady(slot) {
    for (let attempt = 1; ; attempt++) {
      try {
        const ready = JSON.parse(
          run("curl", [
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "2",
            "http://" + slot.metrics + "/ready",
          ]),
        );
        if (ready.status === 200 && ready.readyConnections >= 1) return;
      } catch {
        // Not ready yet, or the metrics listener is still starting.
      }
      if (attempt >= READY_ATTEMPTS)
        throw new Error("Tunnel connector " + slot.service + " reported no edge connection");
      sleep(1_000);
    }
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
      !unitsInstalled(false) ||
      read(installation) !== migration.pending
    )
      throw new Error(
        "Dedicated tunnel changed before completing migration; pending receipt retained",
      );
    replace(installation, receipt);
  }
  return {
    published: true,
    routesUpdated: upgrading && migration.config !== plan.config,
    hostname: plan.hostname,
    tunnelId: plan.tunnelId,
    service: connector ? connector.slot.service : service,
    ...(connector
      ? { connectorSlot: connector.slot.name, connectorHandoff: connector.handoff }
      : {}),
    dnsConfigured: false,
    sharedTunnelUnchanged: true,
    ...(profile.frozenTargets ? { frozenTargetsUnchanged: profile.frozenTargets } : {}),
  };
}
