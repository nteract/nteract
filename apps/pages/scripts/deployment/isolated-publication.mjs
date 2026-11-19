// Each isolated target owns its tunnel and connector. Never modify frozen neighbors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  MIN_CONNECTIONS,
  SLOTS,
  connectorTransition,
  parseConnectorState,
  readyVerdict,
  serializeConnectorState,
  settleConnector,
} from "./connector-slots.mjs";
import { deploymentProfile, stageTarget, verifyDeployment } from "./profiles.mjs";
import { routesFor, strippableSlots } from "./routes.mjs";

const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
// Publication recognizes an installed config by regenerating every
// combination of the target's strippable route groups. Past this many, mark
// long-established groups `settled` in routes.mjs.
const MAX_KNOWN_CONFIGS = 2 ** 16;
const tunnelConfig = (tunnelId, credentialsPath, routes) => `tunnel: ${tunnelId}
credentials-file: ${credentialsPath}
ingress:
${routes}  - service: http_status:404
`;
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

// Every config this tool generates for `target`, by sha256: each strippable
// route group present with its current string, present with one of its
// `earlier` strings, or absent.
export function knownTunnelConfigs(target, tunnelId) {
  const { credentialsPath } = publicationPaths(target);
  const groups = strippableSlots(target);
  const choices = groups.map((entry) => [null, entry.paths, ...entry.earlier]);
  const count = choices.reduce((total, options) => total * options.length, 1);
  if (count > MAX_KNOWN_CONFIGS)
    throw new Error(
      "Too many tunnel route combinations (" +
        count +
        "); mark long-established route groups settled in routes.mjs",
    );
  const known = new Map();
  for (let index = 0; index < count; index++) {
    const omit = [],
      use = {};
    let rest = index;
    groups.forEach((entry, position) => {
      const options = choices[position];
      const pick = options[rest % options.length];
      rest = Math.floor(rest / options.length);
      if (pick === null) omit.push(entry.name);
      else if (pick !== entry.paths) use[entry.name] = pick;
    });
    const config = tunnelConfig(tunnelId, credentialsPath, routesFor(target, { omit, use }));
    known.set(hash(config), config);
  }
  return known;
}
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
  target,
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
  // `sharedConfig` is null only on a host without a shared connector, which
  // the profile must declare with `sharedTunnel: false`.
  if (sharedConfig === null && deploymentProfile(target).sharedTunnel !== false)
    throw new Error("The shared tunnel configuration is required on " + deployment.host);
  for (const config of [...(sharedConfig === null ? [] : [sharedConfig]), ...frozenTunnelConfigs]) {
    const existingId = /^tunnel:\s*["']?([a-f0-9-]{36})["']?\s*$/m.exec(config)?.[1];
    if (!existingId || existingId === tunnelId)
      throw new Error("Isolated targets must use a different tunnel from frozen connectors");
  }
  const config = tunnelConfig(tunnelId, credentialsPath, routesFor(target));
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

export function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // Keep the exit status: callers such as `unitActive` read it.
    throw Object.assign(
      new Error(command + " failed (status " + error.status + "); inspect restricted server logs"),
      { status: error.status },
    );
  }
}

// `systemctl is-active` prints the unit's state and exits 0 only for
// `active`: 3 for inactive or failed, 4 for a unit systemd doesn't know.
// Those two exits mean not active. Any other failure, such as exit 1 for a
// bus error or an invalid unit name, or no exit status because systemctl
// couldn't run, says nothing about the unit and throws.
export function unitActive(service, run = runCommand) {
  try {
    return run("systemctl", ["is-active", service]) === "active";
  } catch (error) {
    if (error?.status === 3 || error?.status === 4) return false;
    throw error;
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
  // lab1 runs a shared connector beside the isolated ones, and publication
  // must leave it untouched. A host declared without one (`sharedTunnel:
  // false`) checks it the same way if it exists, and otherwise that it stays absent.
  const sharedConfigPath = "/etc/cloudflared/config.yml";
  const shared = profile.sharedTunnel !== false || filesystem.existsSync(sharedConfigPath);
  const sharedConfig = shared ? read(sharedConfigPath) : null;
  const sharedPid = shared
    ? run("systemctl", ["show", "cloudflared.service", "--property=MainPID", "--value"])
    : null;
  const frozenConfigs = new Map(),
    frozenPids = new Map();
  const frozenTunnelConfigs = [];
  for (const frozenTarget of profile.frozenTargets ?? []) {
    const frozen = deploymentProfile(frozenTarget);
    const connectors = frozen.tunnelSlots
      ? Object.values(frozen.tunnelSlots).map((slot) => slot.service)
      : [frozen.tunnelService];
    for (const name of [frozen.deployment.service, ...connectors].filter(Boolean)) {
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
      if (frozen.tunnelSlots)
        for (const name of ["tunnel-installation.json", "tunnel-connector.json"])
          frozenConfigs.set(
            "/etc/" + frozen.deployment.service + "/" + name,
            read("/etc/" + frozen.deployment.service + "/" + name),
          );
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
  if (!unitActive(profile.deployment.service, run))
    throw new Error("Isolated Pages service " + profile.deployment.service + " is not active");
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
  const receiptWith = (configSha256, unitSha256, extra = {}) =>
    JSON.stringify({
      schema: 1,
      tunnel_id: plan.tunnelId,
      config_sha256: configSha256,
      unit_sha256: unitSha256,
      ...extra,
    }) + "\n";
  const receiptFor = (config, unitSha256 = plan.unitSha256, extra = {}) =>
    receiptWith(hash(config), unitSha256, extra);
  const receipt = receiptFor(plan.config);
  // The pending receipt toward plan.config from an installation of `config`
  // on the units `unitSha256` names. It names what to roll back to.
  const pendingFrom = (config, unitSha256) =>
    receiptFor(plan.config, plan.unitSha256, {
      previous_config_sha256: hash(config),
      ...(slotted ? { previous_unit_sha256: unitSha256 } : {}),
    });
  // Reads an installed receipt and returns the migration it leaves: the exact
  // config and units to migrate from (and roll back to), and the sealed and
  // pending receipts for that step. The receipt must be one publication
  // writes, byte for byte, and every hash it names one this tool generates for
  // this target. Anything else is an installation to inspect, not to adopt.
  function recognizeInstallation(installed) {
    const differs = () =>
      new Error("Dedicated tunnel installation differs; inspect before retrying");
    let parsed;
    try {
      parsed = JSON.parse(installed);
    } catch {
      throw differs();
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw differs();
    const {
      config_sha256: configSha256,
      unit_sha256: unitSha256,
      previous_config_sha256: previousConfigSha256,
      previous_unit_sha256: previousUnitSha256,
    } = parsed;
    // A sealed receipt, or a pending one naming the previous config and, on a
    // slotted target, the previous units.
    const pending = previousConfigSha256 !== undefined;
    if (
      (previousUnitSha256 !== undefined && (!pending || !slotted)) ||
      installed !==
        receiptWith(configSha256, unitSha256, {
          ...(pending ? { previous_config_sha256: previousConfigSha256 } : {}),
          ...(previousUnitSha256 !== undefined ? { previous_unit_sha256: previousUnitSha256 } : {}),
        })
    )
      throw differs();
    const known = knownTunnelConfigs(target, plan.tunnelId);
    const legacyUnit = hash(plan.unit);
    const knownUnit = (unit) => unit === legacyUnit || unit === plan.unitSha256;
    const installedConfig = known.get(configSha256);
    if (installedConfig === undefined || !knownUnit(unitSha256)) throw differs();
    if (!pending)
      return {
        config: installedConfig,
        legacy: slotted && unitSha256 === legacyUnit,
        sealed: installed,
        pending: pendingFrom(installedConfig, unitSha256),
      };
    // A pending receipt from before slots has no previous_unit_sha256: its
    // units are the ones unit_sha256 names.
    const previousUnit = previousUnitSha256 ?? unitSha256;
    const previousConfig = known.get(previousConfigSha256);
    if (previousConfig === undefined || !knownUnit(previousUnit)) throw differs();
    const legacy = slotted && previousUnit === legacyUnit;
    if (installedConfig === plan.config) {
      // Interrupted on the way to this plan: roll back to the previous files.
      // Only the two pending forms publication writes: this release's, and on
      // a slotted target the one from before slots, on the legacy unit with no
      // previous_unit_sha256.
      const preSlot = slotted && previousUnitSha256 === undefined && unitSha256 === legacyUnit;
      if (
        (previousConfig === plan.config && previousUnit === plan.unitSha256) ||
        (installed !== pendingFrom(previousConfig, previousUnit) && !preSlot)
      )
        throw differs();
      return {
        config: previousConfig,
        legacy,
        sealed: receiptFor(previousConfig, previousUnit),
        pending: installed,
      };
    }
    // Interrupted on the way to another config. Its config file must be exactly
    // one of the two the receipt names: migrate from that one, and roll back
    // to this receipt.
    const current = read(configPath);
    if (current !== installedConfig && current !== previousConfig)
      throw new Error("Dedicated tunnel migration requires exact previous files");
    return {
      config: current,
      legacy,
      sealed: installed,
      pending: pendingFrom(current, previousUnit),
    };
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
  let installed = null;
  let current = null;
  const fresh = !filesystem.existsSync(installation);
  if (!fresh) {
    installed = read(installation);
    if (installed !== receipt) {
      migration = recognizeInstallation(installed);
      current = read(configPath);
      if (
        !unitsInstalled(migration.legacy) ||
        (current !== migration.config &&
          (installed !== migration.pending || current !== plan.config))
      )
        throw new Error("Dedicated tunnel migration requires exact previous files");
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
  }
  // Everything the handoff depends on is checked before the first write.
  const connectorState = slotted ? loadConnectorState() : null;
  if (upgrading) {
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
  } else if (fresh) filesystem.writeFileSync(installation, receipt, { mode: 0o600, flag: "wx" });

  // Reads only. Slot units must be absent or exact, and the record must parse.
  // The record is written before any slot starts, so without one no slot may
  // run: one left running would keep serving routes no record tracks.
  function loadConnectorState() {
    for (const slot of plan.slots)
      if (filesystem.existsSync(slot.unitPath) && read(slot.unitPath) !== slot.unit)
        throw new Error("Dedicated tunnel file differs; inspect before retrying");
    if (filesystem.existsSync(connectorPath)) return parseConnectorState(read(connectorPath));
    if (plan.slots.some((slot) => unitActive(slot.service, run)))
      throw new Error("Tunnel connector state is missing while a slot is active; inspect");
    return migration?.legacy
      ? { phase: "serving", live: "legacy", config: hash(migration.config) }
      : { phase: "absent" };
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
    const uuid = "08c583e5-d29e-4f1e-b06b-333965254e94";
    const tags = "/api/pages/" + uuid + "/tags";
    run("/usr/bin/cloudflared", ["--config", file, "tunnel", "ingress", "validate"]);
    // The Pages hostname admits every path but routes.mjs refusedPaths, so
    // these probe the refusals and an admitted path of each kind. The Worker
    // answers or refuses every admitted path itself.
    for (const [pathname, expected] of [
      ["/", plan.listen],
      ["/mcp", plan.listen],
      ["/api/sync", plan.listen],
      ["/api/pages?tags=status%3Adone&limit=1", plan.listen],
      // A tag's encoded `/` must still reach the Worker.
      [tags + "/repo%3Aorg%2Fname", plan.listen],
      ["/chunks/ABCDEFGH.js", plan.listen],
      ["/sift-ABCDEFGH.wasm", plan.listen],
      ["/p/" + uuid + "/meta.json", plan.listen],
      ["/internal", plan.listen],
      ["/internal/", "http_status:404"],
      ["/internal/create", "http_status:404"],
      ["/dev/oidc", "http_status:404"],
      ["/dev/oidc/token", "http_status:404"],
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
  // while it stops, so only targets without slots take this path.
  function restartConnector() {
    run("systemctl", ["enable", service]);
    try {
      run("systemctl", [upgrading ? "restart" : "start", service]);
      if (!unitActive(service, run)) throw new Error("Dedicated tunnel connector is not active");
    } catch (error) {
      if (upgrading) {
        if (read(configPath) !== plan.config || read(installation) !== migration.pending)
          throw new Error("Dedicated tunnel changed during restart; pending migration retained");
        replace(configPath, migration.config);
        run("systemctl", ["restart", service]);
        if (!unitActive(service, run))
          throw new Error("Dedicated tunnel rollback is not active; pending migration retained");
        replace(installation, migration.sealed);
      }
      throw error;
    }
    return null;
  }

  // Bring up the idle slot with the config on disk and stop the live unit only
  // after the new one holds edge connections (connector-slots.mjs).
  function handOffConnector() {
    const slotNamed = (name) => plan.slots.find((slot) => slot.name === name);
    const unitOf = (name) => (name === "legacy" ? service : slotNamed(name).service);
    const active = (name) => unitActive(unitOf(name), run);
    const effects = {
      persist: (state) => replace(connectorPath, serializeConnectorState(state)),
      active,
      launch: (name, mode) => {
        const unit = unitOf(name);
        if (mode !== "adopt") run("systemctl", [mode, unit]);
        if (!active(name)) throw new Error("Tunnel connector " + unit + " is not active");
      },
      // Only slots serve /ready. A legacy unit that systemd runs counts as
      // serving; it never had a metrics listener.
      ready: (name) => {
        if (name !== "legacy") awaitReady(slotNamed(name));
      },
      serving: (name) =>
        active(name) &&
        (name === "legacy" || readyVerdict(probeReady(slotNamed(name)), true) === "ready"),
      promote: (name) => {
        run("systemctl", ["enable", unitOf(name)]);
        sleep(CONNECTOR_SETTLE_MS);
      },
      stop: (name) => {
        run("systemctl", ["stop", unitOf(name)]);
        run("systemctl", ["disable", unitOf(name)]);
        if (active(name)) throw new Error("Tunnel connector " + unitOf(name) + " is still active");
      },
    };
    // The unit that served when this run began. A retry first finishes the
    // step an interrupted run left in flight.
    const servedBefore =
      connectorState.phase === "stopping" ? connectorState.previous : connectorState.live;
    let { state: settled, failure } = settleConnector(connectorState, effects);
    const want = hash(plan.config);
    if (
      !failure &&
      (settled.phase === "absent" || settled.live === "legacy" || settled.config !== want)
    ) {
      const swap = connectorTransition(settled, { type: "swap", config: want });
      effects.persist(swap);
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

  // cloudflared's /ready answers 200 with `readyConnections` once the
  // connector holds an edge connection, and 503 until then. `readyVerdict`
  // decides how many connections are enough.
  function probeReady(slot) {
    try {
      return JSON.parse(
        run("curl", [
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "2",
          "http://" + slot.metrics + "/ready",
        ]),
      );
    } catch {
      // Not ready yet, or the metrics listener is still starting.
      return null;
    }
  }
  function awaitReady(slot) {
    for (let attempt = 1; ; attempt++) {
      const report = probeReady(slot);
      const verdict = readyVerdict(report, attempt >= READY_ATTEMPTS);
      if (verdict === "ready") return;
      if (verdict === "fail")
        throw new Error(
          "Tunnel connector " +
            slot.service +
            " reported fewer than " +
            MIN_CONNECTIONS +
            " edge connections",
        );
      sleep(1_000);
    }
  }
  if (
    shared
      ? read(sharedConfigPath) !== sharedConfig ||
        run("systemctl", ["show", "cloudflared.service", "--property=MainPID", "--value"]) !==
          sharedPid
      : filesystem.existsSync(sharedConfigPath)
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
    ...(shared ? { sharedTunnelUnchanged: true } : { sharedTunnelAbsent: true }),
    ...(profile.frozenTargets ? { frozenTargetsUnchanged: profile.frozenTargets } : {}),
  };
}
