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
  writeFileSync,
} from "node:fs";
import path from "node:path";
const [stage, apply] = process.argv.slice(2);
if (
  process.getuid() !== 0 ||
  apply !== "--apply" ||
  !/^\/tmp\/nteract-pages-next-stage-[A-Za-z0-9]{8}$/.test(stage ?? "")
)
  throw new Error("Explicit root installation with a prepared stage is required");
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
const expected = {
  host: "lab1",
  hostname: "pages-next.runtimed.run",
  service: "nteract-pages-next",
  bucket: "nteract-celld-lab-621741996708",
  prefix: "standalone/pages-next",
  region: "us-east-1",
  listen: "127.0.0.1:9472",
  internalListen: "127.0.0.1:19472",
  runtime: "/usr/local/bin/celld",
  requiredVersion: "celld 0.6.1",
};
if (
  JSON.stringify(manifest.deployment) !== JSON.stringify(expected) ||
  !/^[a-f0-9]{40}$/.test(manifest.source_sha)
)
  throw new Error("Unexpected deployment target or source");
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
    !/^(release\/[A-Za-z0-9_./-]+|(install|firewall|publish)[.]mjs)$/.test(file) ||
    file.split("/").includes("..")
  )
    throw new Error("Unsafe manifest path");
  const actual = path.join(stage, file);
  if (!lstatSync(actual).isFile() || hash(readFileSync(actual)) !== digest)
    throw new Error("Artifact checksum mismatch");
}
if (
  run(expected.runtime, ["--version"]) !== expected.requiredVersion ||
  hash(readFileSync(expected.runtime)) !== manifest.runtime.sha256
)
  throw new Error("Installed celld changed after preparation");
const base = "/opt/nteract-pages-next",
  configDir = "/etc/nteract-pages-next",
  state = "/var/lib/nteract-pages-next";
const unit = "/etc/systemd/system/nteract-pages-next.service";
const owned = existsSync(configDir + "/ownership.json");
if (owned && JSON.parse(readFileSync(configDir + "/ownership.json")).prefix !== expected.prefix)
  throw new Error("Existing service has different ownership");
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
      .some((line) => /:(9472|19472)\s/.test(line))
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
  if (rules.includes("nteract_pages_next") || /0x20000000|536870912/.test(rules))
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
if (existsSync(release))
  throw new Error("This release already exists; inspect deployment receipt before retrying");
mkdirSync(release, { recursive: true, mode: 0o750 });
cpSync(stage + "/release", release, { recursive: true });
const configPath = release + "/wrangler.json",
  config = JSON.parse(readFileSync(configPath));
if (config.main !== "index.js" || config.no_bundle !== true || config.build || config.containers)
  throw new Error("Unexpected build configuration");
config.vars = {
  NOTEBOOK_CLOUD_OIDC_FLOW: "server",
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages-next.runtimed.run",
  NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://pages-next.runtimed.run/oidc",
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
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o640 });
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
cpSync(expected.runtime, base + "/celld.next");
chmodSync(base + "/celld.next", 0o755);
renameSync(base + "/celld.next", base + "/celld");
cpSync(stage + "/firewall.mjs", base + "/firewall.mjs");
chmodSync(base + "/firewall.mjs", 0o644);
const audit = configDir + "/rollout-" + manifest.source_sha;
mkdirSync(audit, { mode: 0o700 });
writeFileSync(audit + "/manifest.json", JSON.stringify(manifest, null, 2), { mode: 0o600 });
if (existsSync(configDir + "/deployment.json"))
  cpSync(configDir + "/deployment.json", audit + "/previous-deployment.json");
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
writeFileSync(
  unit,
  `[Unit]\nDescription=Isolated native Pages experiment on celld\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${expected.service}\nGroup=${expected.service}\nWorkingDirectory=${state}\nEnvironment=AWS_REGION=us-east-1\nEnvironment=CELLD_DURABILITY=bucket\nEnvironment=CELLD_TOKIO_THREADS=2\nEnvironment=CELLD_V8_HEAP_LIMIT_MB=256\nEnvironment=CELLD_MAX_REQUEST_BODY_BYTES=2097152\nEnvironment=CELLD_MAX_RSS_MB=768\nEnvironment=CELLD_LOCAL_CACHE_MAX_BYTES=536870912\nEnvironment=CELLD_TEST_DATA_DIR=${state}/cache\nExecStartPre=+/usr/bin/node ${base}/firewall.mjs\nExecStart=${base}/celld --bucket s3://${expected.bucket}/${expected.prefix} --region ${expected.region} --listen ${expected.listen} --internal-listen ${expected.internalListen}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\nLimitNOFILE=65536\nMemoryMax=1G\nCPUQuota=100%\nTasksMax=256\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${state}\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`,
  { mode: 0o644 },
);
run("systemd-analyze", ["verify", unit]);
run("systemctl", ["daemon-reload"]);
run("systemctl", ["enable", expected.service]);
run("systemctl", ["restart", expected.service]);
console.log(
  JSON.stringify({
    installed: true,
    source_sha: manifest.source_sha,
    runtime_sha256: manifest.runtime.sha256,
    prefix: expected.prefix,
    hostname: expected.hostname,
    published: false,
  }),
);
