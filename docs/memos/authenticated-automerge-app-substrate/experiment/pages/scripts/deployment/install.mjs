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
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  deploymentProfile,
  assertQualifiedDeploymentTarget,
  stageTarget,
  verifyDeployment,
  verifyRuntime,
  parseRuntimeVersion,
} from "./profiles.mjs";
import {
  awaitBuild,
  fingerprint,
  observedFingerprint,
  parseRunning,
  planActivation,
  runningRecord,
} from "./activation.mjs";
const [stage, apply, extra] = process.argv.slice(2);
const target = stageTarget(stage);
assertQualifiedDeploymentTarget(target);
if (process.getuid() !== 0 || apply !== "--apply" || extra)
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
    !/^(release\/[A-Za-z0-9_./-]+|(install|activation|firewall|publish|profiles|isolated-publication|routes)[.]mjs)$/.test(
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
const serviceProcess = () => {
  const properties = Object.fromEntries(
    run("systemctl", [
      "show",
      expected.service,
      "--property=MainPID",
      "--property=ExecMainStartTimestamp",
      "--property=NeedDaemonReload",
      "--timestamp=unix",
    ])
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    pid: Number(properties.MainPID),
    startedAtSeconds: Number(/^@(\d+)$/.exec(properties.ExecMainStartTimestamp ?? "")?.[1]),
    needDaemonReload: properties.NeedDaemonReload !== "no",
  };
};
// What the running process started with, read before this installation
// changes any of it. See activation.mjs.
function observeRunning() {
  if (!owned || !serviceActive()) return null;
  const current = serviceProcess();
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
    needDaemonReload: current.needDaemonReload,
    unit: file([unit], () => hash(readFileSync(unit))),
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
  // This random secret is created and remains on lab1. Never copied from Pages m.
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
  ...(profile.asyncPersistence ? { PAGES_ASYNC_PERSISTENCE: "true" } : {}),
  ...(profile.compactRecords ? { PAGES_COMPACT_RECORDS: "true" } : {}),
  ...(profile.editor ? { PAGES_EDITOR: profile.editor } : {}),
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
  NOTEBOOK_CLOUD_APP_SESSION_SECRET: readFileSync(configDir + "/session-secret", "utf8").trim(),
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
for (const file of stagedFiles(release)) {
  const digest = hash(readFileSync(path.join(release, file)));
  if (
    !Object.hasOwn(releaseFiles, file) ||
    (digest !== releaseFiles[file] && !(file === "wrangler.json" && digest === hash(configured)))
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
JSON.parse(receipt);
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
const unitText = `[Unit]\nDescription=Isolated native Pages experiment on celld\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${expected.service}\nGroup=${expected.service}\nWorkingDirectory=${state}\nEnvironment=AWS_REGION=us-east-1\nEnvironment=CELLD_DURABILITY=bucket\nEnvironment=CELLD_OTEL=1\nEnvironment=CELLD_OTEL_RETENTION=30d\n${profile.otelTracesSampler ? `Environment=OTEL_TRACES_SAMPLER=${profile.otelTracesSampler}\n` : ""}Environment=CELLD_TOKIO_THREADS=2\nEnvironment=CELLD_V8_HEAP_LIMIT_MB=256\nEnvironment=CELLD_MAX_REQUEST_BODY_BYTES=6291456\nEnvironment=CELLD_MAX_RSS_MB=768\nEnvironment=CELLD_LOCAL_CACHE_MAX_BYTES=536870912\nEnvironment=CELLD_TEST_DATA_DIR=${state}/cache\nExecStartPre=+/usr/bin/node ${base}/firewall.mjs --target ${target}\nExecStart=${base}/celld --bucket s3://${expected.bucket}/${expected.prefix} --region ${expected.region} --listen ${expected.listen} --internal-listen ${expected.internalListen}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\nLimitNOFILE=65536\nMemoryMax=1G\nCPUQuota=100%\nTasksMax=256\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${state}\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
const desired = fingerprint({
  unit: hash(unitText),
  celld: runtime.sha256,
  config: hash(readFileSync(configPath)),
  firewall: helpersHash(base),
});
if (!existsSync(unit) || readFileSync(unit, "utf8") !== unitText) {
  writeFileSync(unit, unitText, { mode: 0o644 });
  run("systemd-analyze", ["verify", unit]);
  run("systemctl", ["daemon-reload"]);
}
run("systemctl", ["enable", expected.service]);
const activation = planActivation({ active: serviceActive(), running, desired });
if (activation.action === "restart") run("systemctl", ["restart", expected.service]);
// The firewall rules name the service cgroup, which a running process keeps,
// so a changed helper applies in place.
else if (activation.applyFirewall)
  run("/usr/bin/node", [base + "/firewall.mjs", "--target", target]);
const served = awaitBuild({
  want: wantBuild,
  probe: () => {
    try {
      const health = JSON.parse(
        run("curl", [
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "5",
          "http://" + expected.listen + "/health",
        ]),
      );
      return {
        ok: health.ok === true && health.prototype === "pages-celld-native",
        build: health.build,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  },
  sleep: (ms) => run("sleep", [String(ms / 1000)]),
  now: () => Date.now(),
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
console.log(
  JSON.stringify({
    installed: true,
    source_sha: manifest.source_sha,
    runtime_sha256: manifest.runtime.sha256,
    prefix: expected.prefix,
    hostname: expected.hostname,
    activation: activation.action,
    ...(activation.reasons.length && { restart_reasons: activation.reasons }),
    ...(activation.applyFirewall && { firewall_applied: true }),
    build: wantBuild,
    serving_after_ms: served.waitedMs,
    published: false,
  }),
);
