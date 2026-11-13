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
import {
  accountPaths,
  cardImagePaths,
  linkPreviewPaths,
  pageSlugPaths,
  projectAssetPaths,
  restPaths,
  routesFor,
  siftPaths,
  whoamiPaths,
} from "./routes.mjs";

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
  const receiptFor = (config, unitSha256 = plan.unitSha256, extra = {}) =>
    JSON.stringify({
      schema: 1,
      tunnel_id: plan.tunnelId,
      config_sha256: hash(config),
      unit_sha256: unitSha256,
      ...extra,
    }) + "\n";
  const receipt = receiptFor(plan.config);
  // The route sets earlier releases sealed, newest first. Each strips one
  // group from this one, so every history keeps its exact bytes and migrates
  // straight to plan.config:
  // - beforeSlugs: without the Page slug routes (pageSlugPaths), what a
  //   target that published between the REST routes and the slugs sealed;
  // - beforeRest: without the REST routes (restPaths) either, what the last
  //   package release sealed. A set with the slugs and without REST was never
  //   published, so it is no predecessor.
  // The route set before link previews, card images and Project assets
  // (linkPreviewPaths, cardImagePaths, projectAssetPaths) strips those from
  // beforeRest. A target without those flags keeps beforeRest.
  const beforeSlugs = plan.config.replace(pageSlugPaths, "");
  const beforeRest = beforeSlugs.replace(restPaths, "");
  const linkPreviews = profile.linkPreviews === true;
  const cardImages = profile.cardImages === true;
  const projectAssets = profile.projectAssets === true;
  const sealedRoutes = [
    [linkPreviews, linkPreviewPaths],
    [cardImages, cardImagePaths],
    [projectAssets, projectAssetPaths],
  ].reduce(
    (config, [enabled, group]) => (enabled ? config.replace(group, "") : config),
    beforeRest,
  );
  // The route set before the account routes (accountPaths). Every history
  // below is stated against it, so those predecessors keep their exact bytes,
  // and each one migrates straight to plan.config.
  const accountRoutes = profile.accountRoutes === true;
  const base = accountRoutes ? sealedRoutes.replace(accountPaths, "") : sealedRoutes;
  // Only the exact known predecessor for this target may migrate. Other targets
  // and arbitrary local edits still require inspection instead of adoption.
  const previousConfig =
    target === "page10" || target === "pages" ? base.replace(whoamiPaths, "") : null;
  // Each predecessor is an exact (config, units) pair this run may migrate
  // from. A slotted target also migrates from its legacy single unit, with or
  // without a route change. Its pending receipt names the units to roll back to.
  const predecessors = [];
  const predecessor = (config, legacy) => {
    const unitSha256 = legacy ? hash(plan.unit) : plan.unitSha256;
    if (config === plan.config && unitSha256 === plan.unitSha256) return;
    const entry = {
      config,
      legacy,
      sealed: receiptFor(config, unitSha256),
      pending: receiptFor(plan.config, plan.unitSha256, {
        previous_config_sha256: hash(config),
        ...(slotted ? { previous_unit_sha256: unitSha256 } : {}),
      }),
    };
    predecessors.push(entry);
    return entry;
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
  // A target that served /whoami from its first release (pages2) has no
  // earlier route set, so none of these histories apply to it.
  if (profile.whoami === true && previousConfig !== null) {
    // The prior release also handed unchanged Sift routes from legacy to slots.
    // That pending receipt can only accompany the exact Sift config.
    predecessors.push({
      ...predecessor(previousConfig, true),
      sealed: receiptFor(previousConfig, plan.unitSha256, {
        previous_config_sha256: hash(previousConfig),
        previous_unit_sha256: hash(plan.unit),
      }),
    });
    const beforeSift = previousConfig.replace(siftPaths, "");
    for (const legacy of [false, true]) {
      // An interrupted Sift rollout can leave either exact config on disk.
      // Recognize only its historical receipt and unit layout, not arbitrary
      // hashes supplied by the installed receipt.
      const unit = legacy ? hash(plan.unit) : plan.unitSha256;
      const historical = [
        receiptFor(previousConfig, plan.unitSha256, {
          previous_config_sha256: hash(beforeSift),
          previous_unit_sha256: unit,
        }),
        ...(legacy
          ? [receiptFor(previousConfig, unit, { previous_config_sha256: hash(beforeSift) })]
          : []),
      ];
      for (const config of [beforeSift, previousConfig]) {
        const entry = predecessor(config, legacy);
        for (const sealed of historical) predecessors.push({ ...entry, sealed });
      }
    }
  }
  if (accountRoutes) {
    // The installation the last release sealed: the same route set without
    // the account routes, on slot units. A target still on its legacy unit at
    // that route set migrates too. Nothing else changes: units and every
    // other route stay byte-identical.
    predecessor(base, false);
    if (slotted) predecessor(base, true);
  }
  // The installations the last two releases sealed, on slot units. A target
  // still on its legacy unit at either route set migrates too. Units and
  // every other route stay byte-identical.
  for (const config of [beforeSlugs, beforeRest]) {
    predecessor(config, false);
    if (slotted) predecessor(config, true);
  }
  if (sealedRoutes !== beforeRest) {
    // The installation the release before it sealed: the account route set,
    // without link previews, card images and Project assets, on slot units.
    // A target still on its legacy unit at that route set migrates too.
    // Units and every other route stay byte-identical.
    predecessor(sealedRoutes, false);
    if (slotted) predecessor(sealedRoutes, true);
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
      const matches = predecessors.filter(
        ({ sealed, pending }) => installed === sealed || installed === pending,
      );
      current = matches.length ? read(configPath) : null;
      migration = matches.find(({ config }) => config === current) ?? matches[0] ?? null;
      if (!migration)
        throw new Error("Dedicated tunnel installation differs; inspect before retrying");
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
    const sharing = profile.sharing === true;
    const oauth = profile.oauth === true;
    const chunks = profile.viewerChunks === true;
    const shell = profile.viewerAssets === true;
    const projects = profile.projectLinks === true;
    const index = profile.indexRoutes === true;
    const sift = profile.siftTables === true;
    const uuid = "08c583e5-d29e-4f1e-b06b-333965254e94";
    const assets = "/api/pages/" + uuid + "/assets";
    const cardImage = "/api/pages/" + uuid + "/card-image";
    const tags = "/api/pages/" + uuid + "/tags";
    const projectAssetRoute = "/api/projects/prj_" + uuid + "/assets";
    const imageHash = "a".repeat(64);
    run("/usr/bin/cloudflared", ["--config", file, "tunnel", "ingress", "validate"]);
    for (const [pathname, expected] of [
      ["/", plan.listen],
      ["/mcp", plan.listen],
      ["/whoami", profile.whoami === true ? plan.listen : "http_status:404"],
      ["/whoami?probe=1", profile.whoami === true ? plan.listen : "http_status:404"],
      ["/whoami/", "http_status:404"],
      ["/whoami/private", "http_status:404"],
      ["/whoamiX", "http_status:404"],
      ["/Whoami", "http_status:404"],
      ["/api/whoami", "http_status:404"],
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
      ["/api/auth/logout", plan.listen],
      ["/api/auth/session", plan.listen],
      ["/api/auth/logout-all", accountRoutes ? plan.listen : "http_status:404"],
      ["/api/auth/grants", accountRoutes ? plan.listen : "http_status:404"],
      [
        `/api/auth/grants/${"A".repeat(43)}/revoke`,
        accountRoutes ? plan.listen : "http_status:404",
      ],
      ["/api/auth/grants/", "http_status:404"],
      [`/api/auth/grants/${"A".repeat(42)}/revoke`, "http_status:404"],
      [`/api/auth/grants/${"A".repeat(43)}`, "http_status:404"],
      [`/api/auth/grants/${"A".repeat(43)}/revoke/private`, "http_status:404"],
      ["/api/auth/logout-all/private", "http_status:404"],
      ["/api/auth/other", "http_status:404"],
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
      // The REST routes. cloudflared matches the decoded path, so the encoded
      // tag is the probe that shows `repo:org/name` reaches the Worker.
      ["/api/pages", plan.listen],
      ["/api/pages?tags=status%3Adone&limit=1", plan.listen],
      [tags + "/status", plan.listen],
      [tags + "/repo%3Aorg%2Fname", plan.listen],
      ["/api/pages/", "http_status:404"],
      [tags, "http_status:404"],
      [tags + "/", "http_status:404"],
      [tags + "/a;b", "http_status:404"],
      ["/api/pages/arbitrary/tags/status", "http_status:404"],
      ["/api/projects/prj_" + uuid + "/tags/status", "http_status:404"],
      ["/p/" + uuid + "/meta.json", linkPreviews ? plan.listen : "http_status:404"],
      ["/p/" + uuid + "/card.json", linkPreviews ? plan.listen : "http_status:404"],
      ["/project/prj_" + uuid + "/meta.json", linkPreviews ? plan.listen : "http_status:404"],
      ["/project/sp_" + uuid + "/card.json", linkPreviews ? plan.listen : "http_status:404"],
      ["/p/" + uuid + "/Some-Title", plan.listen],
      ["/p/" + uuid + "/Some-Title/", plan.listen],
      ["/p/" + uuid + "/Some.Title", "http_status:404"],
      ["/p/" + uuid + "/Some-Title/more", "http_status:404"],
      ["/p/" + uuid + "/" + "a".repeat(81), "http_status:404"],
      ["/p/" + uuid + "/meta.json/", "http_status:404"],
      ["/p/" + uuid + "/other.json", "http_status:404"],
      ["/p/" + uuid.toUpperCase() + "/meta.json", "http_status:404"],
      ["/project/" + uuid + "/meta.json", "http_status:404"],
      ["/s/sp_" + uuid + "/meta.json", "http_status:404"],
      [cardImage, cardImages ? plan.listen : "http_status:404"],
      [
        cardImage + "?hash=" + imageHash + "&theme=dark",
        cardImages ? plan.listen : "http_status:404",
      ],
      [cardImage + "/" + imageHash + "-light.webp", cardImages ? plan.listen : "http_status:404"],
      [cardImage + "/" + imageHash + "-dark.png", cardImages ? plan.listen : "http_status:404"],
      [cardImage + "/" + imageHash + "-light.jpg", cardImages ? plan.listen : "http_status:404"],
      [cardImage + "/", "http_status:404"],
      [cardImage + "/" + "a".repeat(63) + "-light.webp", "http_status:404"],
      [cardImage + "/" + imageHash + "-sepia.webp", "http_status:404"],
      [cardImage + "/" + imageHash + "-light.gif", "http_status:404"],
      [cardImage + "/" + imageHash + "-light.webp/private", "http_status:404"],
      [projectAssetRoute, projectAssets ? plan.listen : "http_status:404"],
      [projectAssetRoute + "/" + imageHash, projectAssets ? plan.listen : "http_status:404"],
      ["/api/projects/" + uuid + "/assets", "http_status:404"],
      [projectAssetRoute + "/private", "http_status:404"],
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
