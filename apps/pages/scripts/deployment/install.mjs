// Root-only installation of one isolated service. Does not publish tunnel/DNS.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  deploymentProfile,
  assertQualifiedDeploymentTarget,
  assertReleaseOpensTargetPages,
  stageTarget,
  verifyDeployment,
  verifyRuntime,
  parseRuntimeVersion,
  unitMemory,
} from "./profiles.mjs";
import {
  awaitServing,
  fingerprint,
  fleetServing,
  liveLeases,
  localServing,
  observedFingerprint,
  parseRunning,
  planActivation,
  runningRecord,
  unitInput,
} from "./activation.mjs";
import { installedRecord, parseKeyring, sessionVars, withSessionVars } from "./session-keys.mjs";
import { metadataEgressQualification } from "./firewall.mjs";
const [stage, apply, ...flags] = process.argv.slice(2);
const target = stageTarget(stage);
assertQualifiedDeploymentTarget(target);
// --restart restarts the service even when nothing it reads at startup changed.
const requested = flags.length === 1 && flags[0] === "--restart";
if (process.getuid() !== 0 || apply !== "--apply" || (flags.length && !requested))
  throw new Error("Explicit root installation with a prepared stage is required");
const profile = deploymentProfile(target);
const run = (command, args) => {
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
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync(stage + "/manifest.json"));
const expected = verifyDeployment(manifest, target);
// /health reports this id once the node serves the release.
const wantBuild = manifest.build_receipt?.build_id;
if (!/^[a-f0-9]{12}$/.test(wantBuild ?? ""))
  throw new Error("Manifest build receipt must carry the 12-hex build id");
function stagedFiles(directory, prefix = "") {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const relative = prefix + name,
        entry = path.join(directory, name),
        stat = lstatSync(entry);
      if (stat.isDirectory()) return stagedFiles(entry, relative + "/");
      if (!stat.isFile()) throw new Error("Special files are forbidden in the stage");
      return [relative];
    });
}
if (
  JSON.stringify(
    stagedFiles(stage)
      .filter((file) => file !== "manifest.json")
      .sort(),
  ) !== JSON.stringify(Object.keys(manifest.files).sort())
)
  throw new Error("Stage file set differs from manifest");
for (const [file, digest] of Object.entries(manifest.files)) {
  if (
    !/^(release\/[A-Za-z0-9_./-]+|(install|activation|firewall|publish|profiles|isolated-publication|connector-slots|routes|session-keys)[.]mjs)$/.test(
      file,
    ) ||
    file.split("/").includes("..")
  )
    throw new Error("Unsafe manifest path");
  const actual = path.join(stage, file);
  if (!lstatSync(actual).isFile() || hash(readFileSync(actual)) !== digest)
    throw new Error("Artifact checksum mismatch");
}
verifyRuntime(manifest.runtime);
const runtime = {
  version: parseRuntimeVersion(run(expected.runtime, ["--version"])),
  sha256: hash(readFileSync(expected.runtime)),
};
verifyRuntime(runtime);
const base = "/opt/" + expected.service,
  configDir = "/etc/" + expected.service,
  state = "/var/lib/" + expected.service;
const unit = "/etc/systemd/system/" + expected.service + ".service";
const owned = existsSync(configDir + "/ownership.json");
const installedRuntime =
  owned && existsSync(base + "/celld") ? hash(readFileSync(base + "/celld")) : null;
if (installedRuntime)
  verifyRuntime(runtime, {
    version: parseRuntimeVersion(run(base + "/celld", ["--version"])),
    sha256: installedRuntime,
  });
if (owned) {
  const ownership = JSON.parse(readFileSync(configDir + "/ownership.json"));
  if (ownership.prefix !== expected.prefix || ownership.hostname !== expected.hostname)
    throw new Error("Existing service has different ownership");
}
// Fleet-wide egress is an operator qualification, not something installing
// one node can establish. The marker lives outside release artifacts and is
// never created by this installer. Missing means metadata fetching stays off.
const metadataEgressPath = configDir + "/oauth-metadata-egress";
const metadataEgressPhase = owned
  ? metadataEgressQualification(metadataEgressPath, { existsSync, lstatSync, readFileSync })
  : "unconfigured";
const metadataEgressQualified = metadataEgressPhase === "public-https";
// A keyring file (written by `deploy.mjs rotate-key`) replaces the single
// session secret in the Worker's vars; rotation moves `session-secret` aside,
// so only one of them is read. Check before anything is written, so a
// malformed keyring or a missing secret stops the installation here.
const keyringPath = configDir + "/session-keys.json";
const secretPath = configDir + "/session-secret";
const activeRecordPath = configDir + "/session-keys-active.json";
const keyringText =
  owned && existsSync(keyringPath) ? readFileSync(keyringPath, "utf8") : undefined;
const keyring = keyringText === undefined ? undefined : parseKeyring(keyringText);
if (owned && !keyring && !existsSync(secretPath))
  throw new Error(
    `Neither ${keyringPath} nor ${secretPath} exists; restore the keyring before installing`,
  );
// The record storage every release installed here was configured to create
// Pages with. With the target's history, it names the Pages this target may
// hold; a release that can't open them is refused before any write.
const releaseStorage = (sha) => {
  const file = base + "/releases/" + sha + "/wrangler.json";
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")).vars?.PAGES_RECORD_STORAGE;
  } catch {
    // A partial copy from an interrupted install has no configured vars yet.
    return undefined;
  }
};
const installedReleases =
  owned && existsSync(base + "/releases")
    ? readdirSync(base + "/releases").filter((name) => /^[a-f0-9]{40}$/.test(name))
    : [];
const observedStorage = installedReleases
  .map((sha) => ({ mode: releaseStorage(sha), release: sha.slice(0, 12) }))
  .filter(({ mode }) => mode);
assertReleaseOpensTargetPages(
  target,
  { ...manifest.build_receipt, source_sha: manifest.source_sha },
  observedStorage,
);
const helpers = ["firewall.mjs", "profiles.mjs"];
const helpersHash = (directory) =>
  hash(helpers.map((helper) => hash(readFileSync(directory + "/" + helper))).join("\n"));
const runningPath = configDir + "/running.json";
const serviceActive = () => {
  try {
    return run("systemctl", ["is-active", expected.service]) === "active";
  } catch {
    // is-active exits non-zero for every state but active.
    return false;
  }
};
// systemd's view of the unit. `--timestamp=unix` needs systemd 248 or later
// (lab1 and pages-node2 run 255); an older systemctl rejects it and the
// installation stops here, before it changes anything.
const serviceProcess = () => {
  const properties = Object.fromEntries(
    run("systemctl", [
      "show",
      expected.service,
      "--property=MainPID",
      "--property=ExecMainStartTimestamp",
      "--property=NeedDaemonReload",
      "--property=DropInPaths",
      "--timestamp=unix",
    ])
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    pid: Number(properties.MainPID),
    startedAtSeconds: Number(/^@(\d+)$/.exec(properties.ExecMainStartTimestamp ?? "")?.[1]),
    needDaemonReload: properties.NeedDaemonReload !== "no",
    dropIns: (properties.DropInPaths ?? "").split(/\s+/).filter(Boolean),
  };
};
// unit_sha256: the fragment and the drop-ins systemd loaded with it.
const unitHash = (fragment, dropIns) =>
  hash(
    unitInput(
      fragment,
      dropIns.map((file) => ({ path: file, text: readFileSync(file, "utf8") })),
    ),
  );
// systemd's view before this installation changes anything.
const before = owned ? serviceProcess() : null;
// What the running process started with. See activation.mjs.
function observeRunning() {
  if (!owned || !serviceActive()) return null;
  const current = before;
  const recorded = existsSync(runningPath)
    ? parseRunning(readFileSync(runningPath, "utf8"), current)
    : null;
  if (recorded) return recorded;
  const { pid, startedAtSeconds } = current;
  const file = (paths, sha256) =>
    paths.every((file) => existsSync(file))
      ? { sha256: sha256(), mtimeMs: Math.max(...paths.map((file) => statSync(file).mtimeMs)) }
      : null;
  // The newest rollout recorded before the process started carries the
  // configured wrangler.json that process deployed.
  const provenance = readdirSync(configDir)
    .filter((name) => /^rollout-[a-f0-9]{40}$/.test(name))
    .map((name) => configDir + "/" + name + "/provenance.json")
    .filter((file) => existsSync(file))
    .map((file) => ({
      sha256: JSON.parse(readFileSync(file)).configured_wrangler_sha256,
      mtimeMs: statSync(file).mtimeMs,
    }))
    .filter(({ mtimeMs }) => mtimeMs < startedAtSeconds * 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return observedFingerprint({
    startedAtSeconds,
    exeSha256:
      Number.isSafeInteger(pid) && pid > 0 ? hash(readFileSync("/proc/" + pid + "/exe")) : null,
    unit: file([unit, ...current.dropIns], () =>
      unitHash(readFileSync(unit, "utf8"), current.dropIns),
    ),
    config: provenance ?? null,
    firewall: file(
      helpers.map((helper) => base + "/" + helper),
      () => helpersHash(base),
    ),
  });
}
const running = observeRunning();
if (!owned) {
  for (const target of [base, configDir, state, unit])
    if (existsSync(target)) throw new Error("An unowned deployment path already exists: " + target);
  let userExists = false;
  try {
    run("id", [expected.service]);
    userExists = true;
  } catch {}
  if (userExists) throw new Error("Dedicated service user already exists without ownership marker");
  if (
    run("ss", ["-H", "-ltn"])
      .split("\n")
      .some((line) =>
        [expected.listen, expected.internalListen].some((listen) =>
          new RegExp(":" + listen.split(":").at(-1) + "\\s").test(line),
        ),
      )
  )
    throw new Error("Proposed listener port is occupied");
  const count = run("/usr/local/bin/aws", [
    "s3api",
    "list-objects-v2",
    "--bucket",
    expected.bucket,
    "--prefix",
    expected.prefix + "/",
    "--max-keys",
    "1",
    "--query",
    "KeyCount",
    "--output",
    "text",
    "--region",
    expected.region,
  ]);
  if (count !== "0") throw new Error("New Pages prefix is not empty");
  const rules = run("/usr/sbin/nft", ["-j", "list", "ruleset"]);
  if (
    rules.includes(profile.firewallTable) ||
    rules.includes(profile.firewallMark) ||
    rules.includes(String(Number(profile.firewallMark)))
  )
    throw new Error("Proposed firewall namespace or mark is occupied");
  run("useradd", [
    "--system",
    "--user-group",
    "--home-dir",
    state,
    "--shell",
    "/usr/sbin/nologin",
    expected.service,
  ]);
  mkdirSync(base, { mode: 0o755 });
  mkdirSync(configDir, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(
    configDir + "/ownership.json",
    JSON.stringify({ prefix: expected.prefix, hostname: expected.hostname }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  // This random secret is created and remains on the target host. Never copied from Pages m.
  writeFileSync(configDir + "/session-secret", randomBytes(48).toString("base64url"), {
    mode: 0o600,
    flag: "wx",
  });
}
const uid = Number(run("id", ["-u", expected.service])),
  gid = Number(run("id", ["-g", expected.service]));
chownSync(state, uid, gid);
const release = `${base}/releases/${manifest.source_sha}`;
const configPath = release + "/wrangler.json",
  config = JSON.parse(readFileSync(stage + "/release/wrangler.json"));
if (config.main !== "index.js" || config.no_bundle !== true || config.build || config.containers)
  throw new Error("Unexpected build configuration");
config.vars = {
  ...(metadataEgressQualified ? { PAGES_OAUTH_METADATA_EGRESS: "public-https" } : {}),
  ...(profile.companyViewDomains ? { PAGES_COMPANY_VIEW_DOMAINS: profile.companyViewDomains } : {}),
  ...(profile.catalogIndex ? { PAGES_CATALOG_INDEX: profile.catalogIndex } : {}),
  ...(profile.pageQuota ? { PAGES_DEFAULT_PAGE_QUOTA: profile.pageQuota } : {}),
  NOTEBOOK_CLOUD_OIDC_FLOW: "server",
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://" + expected.hostname,
  NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://" + expected.hostname + "/oidc",
  NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.anaconda.com/api/auth",
  NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0",
  NOTEBOOK_CLOUD_OIDC_AUDIENCE: "anaconda,1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0",
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "runtimed-pages-next-anaconda",
  NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD: "none",
  NOTEBOOK_CLOUD_OIDC_USERINFO: "true",
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://anaconda.com/api/auth/sessions/whoami",
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "runtimed-pages-next-anaconda",
  ...sessionVars({ keyring: keyringText, secret: () => readFileSync(secretPath, "utf8") }),
};
const configured = JSON.stringify(config, null, 2) + "\n";
const releaseFiles = Object.fromEntries(
  Object.entries(manifest.files)
    .filter(([file]) => file.startsWith("release/"))
    .map(([file, digest]) => [file.slice(8), digest]),
);
if (existsSync(release) && !lstatSync(release).isDirectory())
  throw new Error("Existing release is not a directory");
mkdirSync(release, { recursive: true, mode: 0o750 });
// Retry only the same verified bytes. A partial copy may have missing files,
// but never replace an unexpected file or a modified existing artifact.
// The installer writes the configured wrangler.json's vars itself, so an
// earlier install of this release with other vars (a changed profile) is
// accepted when everything but `vars` matches this configuration.
const sameButVars = (bytes) => {
  try {
    const existing = JSON.parse(bytes);
    return (
      Object.hasOwn(existing, "vars") &&
      JSON.stringify({ ...existing, vars: null }) === JSON.stringify({ ...config, vars: null })
    );
  } catch {
    return false;
  }
};
for (const file of stagedFiles(release)) {
  const bytes = readFileSync(path.join(release, file));
  const digest = hash(bytes);
  if (
    !Object.hasOwn(releaseFiles, file) ||
    (digest !== releaseFiles[file] &&
      !(file === "wrangler.json" && (digest === hash(configured) || sameButVars(bytes))))
  )
    throw new Error("Existing release differs from prepared artifacts: " + file);
}
const audit = configDir + "/rollout-" + manifest.source_sha;
if (existsSync(audit) && !lstatSync(audit).isDirectory())
  throw new Error("Existing rollout audit is not a directory");
mkdirSync(audit, { recursive: true, mode: 0o700 });
for (const name of [
  "manifest.json",
  "previous-deployment.json",
  "deployment.json",
  "provenance.json",
])
  if (existsSync(audit + "/" + name) && !lstatSync(audit + "/" + name).isFile())
    throw new Error("Special files are forbidden in the rollout audit");
if (existsSync(audit + "/manifest.json")) {
  if (
    JSON.stringify(JSON.parse(readFileSync(audit + "/manifest.json"))) !== JSON.stringify(manifest)
  )
    throw new Error("Existing rollout manifest differs from prepared deployment");
  // A reinstall of the same stage keeps the first snapshot
  // as previous-deployment.json; the deployment it replaces is kept by version.
  if (existsSync(configDir + "/deployment.json")) {
    const current = readFileSync(configDir + "/deployment.json");
    const version = JSON.parse(current)?.version;
    if (
      /^[a-f0-9]{16}$/.test(version ?? "") &&
      !existsSync(audit + "/deployment-" + version + ".json")
    )
      writeFileSync(audit + "/deployment-" + version + ".json", current, { mode: 0o600 });
  }
} else {
  // Record absence too, so a retry after deploy cannot mistake its own receipt
  // for the previous deployment. Keep this first snapshot across all retries.
  if (!existsSync(audit + "/previous-deployment.json"))
    writeFileSync(
      audit + "/previous-deployment.json",
      existsSync(configDir + "/deployment.json")
        ? readFileSync(configDir + "/deployment.json")
        : "null\n",
      { mode: 0o600 },
    );
  writeFileSync(audit + "/manifest.json", JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
for (const file of Object.keys(releaseFiles)) {
  const destination = path.join(release, file);
  if (!existsSync(destination)) {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o750 });
    cpSync(path.join(stage, "release", file), destination);
  }
}
writeFileSync(configPath, configured, { mode: 0o640 });
// Older release directories carry the session vars they were installed with.
// Give them the current keyring: a `celld deploy` rollback to one then signs
// with the current keys, a retired key can't come back with it, and retired
// secrets leave the disk. Their other vars stay as installed.
if (keyring)
  for (const sha of installedReleases) {
    const file = base + "/releases/" + sha + "/wrangler.json";
    if (sha === manifest.source_sha || !existsSync(file)) continue;
    let earlier;
    try {
      earlier = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // A partial copy from an interrupted install has no configured vars yet.
      continue;
    }
    const scrubbed = JSON.stringify(withSessionVars(earlier, config.vars), null, 2) + "\n";
    if (JSON.stringify(earlier, null, 2) + "\n" !== scrubbed)
      writeFileSync(file, scrubbed, { mode: 0o640 });
  }
function permissions(directory) {
  chownSync(directory, 0, gid);
  chmodSync(directory, 0o750);
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (lstatSync(file).isDirectory()) permissions(file);
    else {
      chownSync(file, 0, gid);
      chmodSync(file, 0o640);
    }
  }
}
permissions(base + "/releases");
// Keep the executable's inode when the bytes already match.
if (installedRuntime !== runtime.sha256) {
  cpSync(expected.runtime, base + "/celld.next");
  if (hash(readFileSync(base + "/celld.next")) !== runtime.sha256)
    throw new Error("Copied celld differs from the verified release");
  chmodSync(base + "/celld.next", 0o755);
  renameSync(base + "/celld.next", base + "/celld");
}
for (const helper of helpers) {
  cpSync(stage + "/" + helper, base + "/" + helper);
  chmodSync(base + "/" + helper, 0o644);
}
const memory = unitMemory(profile);
const unitText = `[Unit]\nDescription=Isolated native Pages experiment on celld\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${expected.service}\nGroup=${expected.service}\nWorkingDirectory=${state}\nEnvironment=AWS_REGION=us-east-1\nEnvironment=CELLD_DURABILITY=bucket\nEnvironment=CELLD_OTEL=1\nEnvironment=CELLD_OTEL_RETENTION=30d\n${profile.otelTracesSampler ? `Environment=OTEL_TRACES_SAMPLER=${profile.otelTracesSampler}\n` : ""}Environment=CELLD_TOKIO_THREADS=2\nEnvironment=CELLD_V8_HEAP_LIMIT_MB=256\nEnvironment=CELLD_MAX_REQUEST_BODY_BYTES=6291456\nEnvironment=CELLD_MAX_RSS_MB=${memory.maxRssMb}\nEnvironment=CELLD_LOCAL_CACHE_MAX_BYTES=536870912\nEnvironment=CELLD_TEST_DATA_DIR=${state}/cache\nExecStartPre=+/usr/bin/node ${base}/firewall.mjs --target ${target}\nExecStart=${base}/celld --bucket s3://${expected.bucket}/${expected.prefix} --region ${expected.region} --listen ${expected.listen} --internal-listen ${expected.internalListen}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\nLimitNOFILE=65536\nMemoryMax=${memory.memoryMax}\nCPUQuota=100%\nTasksMax=256\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${state}\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
// Stage and verify the unit under its own basename, then rename it into place,
// so a failed verify leaves the loaded definition and the file in agreement.
// /etc/systemd is the same filesystem as /etc/systemd/system.
const unitChanged = !existsSync(unit) || readFileSync(unit, "utf8") !== unitText;
if (unitChanged) {
  const staging = mkdtempSync("/etc/systemd/." + expected.service + "-unit-");
  try {
    const staged = staging + "/" + path.basename(unit);
    writeFileSync(staged, unitText, { mode: 0o644 });
    run("systemd-analyze", ["verify", staged]);
    renameSync(staged, unit);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
// A changed fragment, or one an interrupted run renamed into place but never
// loaded, or a drop-in someone added: all show as NeedDaemonReload.
if (unitChanged || serviceProcess().needDaemonReload) run("systemctl", ["daemon-reload"]);
const loaded = serviceProcess();
if (loaded.needDaemonReload)
  throw new Error(
    "systemd still reports NeedDaemonReload=yes after daemon-reload; refusing to start a stale definition",
  );
run("systemctl", ["enable", expected.service]);
// Which deployment the local node runs before this one, for the keyring's
// activation record. Unknown starts the overlap afresh.
let liveBefore = null;
if (keyring)
  try {
    liveBefore =
      JSON.parse(
        run("curl", [
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "5",
          "http://" + expected.internalListen + "/state",
        ]),
      ).deployment?.version ?? null;
  } catch {
    liveBefore = null;
  }
// An active node can adopt the pointer immediately after deploy. Apply the
// egress boundary first, even when this installation will restart it later.
// Inactive nodes install the same rules in ExecStartPre before serving.
const firewallApplied = serviceActive();
if (firewallApplied) run("/usr/bin/node", [base + "/firewall.mjs", "--target", target]);
const receipt = run("runuser", [
  "-u",
  expected.service,
  "--",
  base + "/celld",
  "deploy",
  release,
  "--bucket",
  `s3://${expected.bucket}/${expected.prefix}`,
  "--region",
  expected.region,
  "--json",
]);
const deployedVersion = JSON.parse(receipt)?.version;
if (!/^[a-f0-9]{16}$/.test(deployedVersion ?? ""))
  throw new Error("celld deploy receipt must name the 16-hex deployment version");
writeFileSync(configDir + "/deployment.json", receipt, { mode: 0o600 });
writeFileSync(audit + "/deployment.json", receipt, { mode: 0o600 });
writeFileSync(
  audit + "/provenance.json",
  JSON.stringify(
    {
      source_sha: manifest.source_sha,
      source_tree: manifest.source_tree,
      runtime_sha256: manifest.runtime.sha256,
      configured_wrangler_sha256: hash(readFileSync(configPath)),
      prefix: expected.prefix,
      hostname: expected.hostname,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const desired = fingerprint({
  unit: unitHash(unitText, loaded.dropIns),
  celld: runtime.sha256,
  config: hash(readFileSync(configPath)),
  firewall: helpersHash(base),
});
const activation = planActivation({
  active: serviceActive(),
  running,
  desired,
  reloadPending: before?.needDaemonReload ?? false,
  requested,
});
// The pointer has moved. A timeout names the way back.
function rollback(error) {
  const previousPath = audit + "/previous-deployment.json";
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  if (!previous?.version)
    return new Error(`${error.message}. No earlier deployment to roll back to (${previousPath}).`);
  const prior = readdirSync(configDir)
    .filter((name) => /^rollout-[a-f0-9]{40}$/.test(name) && name !== path.basename(audit))
    .find((name) => {
      const file = configDir + "/" + name + "/deployment.json";
      return (
        existsSync(file) && JSON.parse(readFileSync(file, "utf8"))?.version === previous.version
      );
    });
  const release = prior ? base + "/releases/" + prior.slice("rollout-".length) : null;
  // Name the way back only to a release that opens every Page this target may
  // hold; its rollout manifest carries its build receipt.
  let refusal = null;
  let earlier = null;
  if (prior)
    try {
      earlier = JSON.parse(readFileSync(configDir + "/" + prior + "/manifest.json", "utf8"));
    } catch {
      refusal = `Its rollout manifest ${configDir}/${prior}/manifest.json is unreadable, so the Pages it opens are unknown.`;
    }
  if (earlier)
    try {
      assertReleaseOpensTargetPages(
        target,
        { ...earlier.build_receipt, source_sha: earlier.source_sha },
        observedStorage,
      );
    } catch (reason) {
      refusal = reason.message;
    }
  // A release from before the keyring reads only the single secret, which
  // rotation moved aside: it would deploy without any session key.
  if (!refusal && keyring && earlier && !Object.hasOwn(earlier.files ?? {}, "session-keys.mjs"))
    refusal =
      "It predates the session keyring, so it would run without a session key; install a release with the keyring instead.";
  if (refusal)
    return new Error(
      `${error.message}. The fleet pointer names ${deployedVersion}; the previous deployment ` +
        `${previous.version} is recorded in ${previousPath}, but do not roll back to it. ${refusal}`,
    );
  return new Error(
    `${error.message}. The fleet pointer names ${deployedVersion}; the previous deployment ` +
      `${previous.version} is recorded in ${previousPath}. Roll back with: ` +
      `sudo runuser -u ${expected.service} -- ${base}/celld deploy ` +
      `${release && existsSync(release) ? release : `<release of ${previous.version}>`} ` +
      `--bucket s3://${expected.bucket}/${expected.prefix} --region ${expected.region} --json`,
  );
}
const curl = (url) => run("curl", ["--fail", "--silent", "--show-error", "--max-time", "5", url]);
const wait = (options) => {
  try {
    return awaitServing({
      sleep: (ms) => run("sleep", [String(ms / 1000)]),
      now: () => Date.now(),
      ...options,
    });
  } catch (error) {
    throw rollback(error);
  }
};
if (activation.action === "restart") run("systemctl", ["restart", expected.service]);
// Active nodes already received the firewall before publishing the pointer.
// The local gateway serves the new build. This proves only this node.
const local = wait({
  what: `Local node ${expected.listen} build ${wantBuild}`,
  probe: () => {
    try {
      const health = JSON.parse(curl("http://" + expected.listen + "/health"));
      return localServing(
        health.prototype === "pages-celld-native" ? health : { error: "not a Pages gateway" },
        wantBuild,
      );
    } catch (error) {
      return localServing({ error: error.message }, wantBuild);
    }
  },
  // A restart drains (up to CELLD_SHUTDOWN_TOTAL_MS, 40 s) and then waits for
  // fleet readiness. Adoption waits for the next pointer poll (30 s).
  timeoutMs: activation.action === "restart" ? 240_000 : 120_000,
  intervalMs: 2000,
});
writeFileSync(
  runningPath,
  JSON.stringify(runningRecord(desired, serviceProcess()), null, 2) + "\n",
  { mode: 0o600 },
);
// Every node polls the pointer on its own schedule (page10 with two nodes:
// one adopted 9 s after the pointer moved, the other 26 s), so each live node
// is asked directly: its lease names its internal listener, and /state there
// reports the deployment version it runs.
const aws = (args) => run("/usr/local/bin/aws", [...args, "--region", expected.region]);
const fleet = wait({
  what: `Fleet deployment ${deployedVersion}`,
  probe: () => {
    let keys;
    try {
      keys = JSON.parse(
        aws([
          "s3api",
          "list-objects-v2",
          "--bucket",
          expected.bucket,
          "--prefix",
          expected.prefix + "/nodes/",
          "--query",
          "Contents[].Key",
          "--output",
          "json",
        ]) || "null",
      );
    } catch (error) {
      return { serving: false, detail: "listing node leases failed: " + error.message };
    }
    const leases = (keys ?? [])
      .filter((key) => /\/nodes\/node_[a-f0-9]+\.json$/.test(key))
      .map((key) => {
        try {
          return JSON.parse(aws(["s3", "cp", `s3://${expected.bucket}/${key}`, "-"]));
        } catch {
          // A lease deleted between list and read is a node that left.
          return null;
        }
      });
    return fleetServing(
      liveLeases(leases, Date.now()).map(({ node, addr }) => {
        try {
          return {
            node,
            addr,
            version: JSON.parse(curl(`http://${addr}/state`)).deployment?.version ?? null,
          };
        } catch (error) {
          return { node, addr, version: null, error: error.message };
        }
      }),
      deployedVersion,
    );
  },
  timeoutMs: 120_000,
  intervalMs: 3000,
});
// Every node now signs with the keyring's active key. Record when that began,
// carried forward only while the same deployment line keeps the same key;
// `retire-key` measures the overlap from it.
const previousRecord = existsSync(activeRecordPath)
  ? (() => {
      try {
        return JSON.parse(readFileSync(activeRecordPath, "utf8"));
      } catch {
        return null;
      }
    })()
  : null;
const record = installedRecord({
  previous: previousRecord,
  active: keyring?.active,
  liveBefore,
  deployedVersion,
  now: Date.now(),
});
if (record)
  writeFileSync(activeRecordPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
else if (previousRecord !== null || existsSync(activeRecordPath))
  rmSync(activeRecordPath, { force: true });
console.log(
  JSON.stringify({
    installed: true,
    source_sha: manifest.source_sha,
    runtime_sha256: manifest.runtime.sha256,
    prefix: expected.prefix,
    hostname: expected.hostname,
    activation: activation.action,
    ...(activation.reasons.length && { restart_reasons: activation.reasons }),
    ...((firewallApplied || activation.action === "restart") && { firewall_applied: true }),
    build: wantBuild,
    local_serving_after_ms: local.waitedMs,
    deployment_version: deployedVersion,
    fleet_nodes: fleet.nodes,
    fleet_serving_after_ms: fleet.waitedMs,
    ...(record && { session_key: { active: record.active, signing_since: record.activated_at } }),
    published: false,
  }),
);
