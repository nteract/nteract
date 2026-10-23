#!/usr/bin/env node
// All external mutations are explicit subcommands. `plan` is the default.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { stageArtifacts } from "./stage-artifacts.mjs";
import {
  deploymentProfile,
  selectTarget,
  stagePattern,
  verifyDeployment,
} from "./deployment/profiles.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const pages = path.dirname(scripts);
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: pages,
  encoding: "utf8",
}).trim();
const { target, args } = selectTarget(process.argv.slice(2));
export const deployment = deploymentProfile(target).deployment;
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", ...options }).trim();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const ssh = (command) => run("ssh", ["-o", "BatchMode=yes", deployment.host, command]);
function files(directory, prefix = "") {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const relative = prefix + name;
      if (!/^[A-Za-z0-9_./-]+$/.test(relative)) throw new Error("Unsupported artifact filename");
      const stat = lstatSync(path.join(directory, name));
      if (stat.isDirectory()) return files(path.join(directory, name), relative + "/");
      if (!stat.isFile()) throw new Error("Symlinks and special files are not release artifacts");
      return [relative];
    });
}
function prepare() {
  if (run("git", ["status", "--porcelain"], { cwd: repo }))
    throw new Error("Commit the reviewed source before preparing a deployment");
  const source = run("git", ["rev-parse", "HEAD"], { cwd: repo });
  const dist = path.join(pages, "dist");
  const buildReceipt = JSON.parse(readFileSync(path.join(dist, "build-receipt.json")));
  const currentFingerprint = sourceFingerprint(pages, { root: repo });
  if (buildReceipt.fingerprint?.sha256 !== currentFingerprint.sha256)
    throw new Error("Bundle source fingerprint is stale; build and validate the current source");
  const config = JSON.parse(readFileSync(path.join(dist, "wrangler.json")));
  if (config.main !== "index.js" || config.no_bundle !== true || config.build || config.containers)
    throw new Error("Build a static no_bundle Worker before preparing");
  if (Object.keys(config.vars ?? {}).some((key) => /SECRET|TOKEN|PASSWORD|PRIVATE_KEY/.test(key)))
    throw new Error("Deployment artifacts must not contain secret variables");
  const runtime = JSON.parse(
    ssh(
      "node -e " +
        quote(
          `const cp=require('node:child_process'),fs=require('node:fs'),c=require('node:crypto');const p=${JSON.stringify(deployment.runtime)};console.log(JSON.stringify({version:cp.execFileSync(p,['--version'],{encoding:'utf8'}).trim(),sha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))`,
        ),
    ),
  );
  if (runtime.version !== deployment.requiredVersion)
    throw new Error(
      "lab1 runtime differs from the qualified celld 0.6.1; qualify it before deploying",
    );
  const output = path.join(repo, ".context", target + "-deploy", source);
  if (existsSync(output))
    throw new Error("Prepared release already exists; inspect it instead of replacing it");
  mkdirSync(output, { recursive: true });
  stageArtifacts(dist, path.join(output, "release"));
  for (const name of [
    "install.mjs",
    "firewall.mjs",
    "publish.mjs",
    "profiles.mjs",
    "isolated-publication.mjs",
    "routes.mjs",
  ])
    cpSync(path.join(scripts, "deployment", name), path.join(output, name));
  const manifest = {
    schema: 1,
    source_sha: source,
    source_tree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo }),
    prepared_at: new Date().toISOString(),
    source_fingerprint: currentFingerprint.sha256,
    build_receipt: buildReceipt,
    deployment,
    runtime,
    files: Object.fromEntries(
      files(output).map((file) => [file, digest(readFileSync(path.join(output, file)))]),
    ),
  };
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      { prepared: output, source_sha: source, runtime, files: Object.keys(manifest.files).length },
      null,
      2,
    ),
  );
}
const [mode = "plan", stage, flag, extra] = args;
if (extra) throw new Error("Unexpected deployment argument");
if (mode === "plan" && !stage) console.log(JSON.stringify(deployment, null, 2));
else if (mode === "prepare" && !stage) prepare();
else if (mode === "upload" && stage && !flag) {
  const absolute = path.resolve(stage);
  const manifest = JSON.parse(readFileSync(path.join(absolute, "manifest.json")));
  verifyDeployment(manifest, target);
  const remote = ssh("mktemp -d /tmp/" + deployment.service + "-stage-XXXXXXXX");
  if (!stagePattern(target).test(remote)) throw new Error("Unexpected remote staging directory");
  run("scp", ["-r", absolute + "/.", deployment.host + ":" + remote]);
  console.log(JSON.stringify({ uploaded: remote, source_sha: manifest.source_sha }));
} else if (
  ["install", "publish"].includes(mode) &&
  stagePattern(target).test(stage ?? "") &&
  flag === "--apply"
) {
  // Serialize operator commands across the two isolated deployment profiles.
  console.log(
    ssh(
      `sudo flock -n /run/nteract-pages-next-deploy.lock node ${quote(stage + "/" + mode + ".mjs")} ${quote(stage)} --apply`,
    ),
  );
} else
  throw new Error(
    "Usage: deploy.mjs [--target pages-next|page3|page4] [plan | prepare | upload LOCAL_STAGE | install REMOTE_STAGE --apply | publish REMOTE_STAGE --apply]",
  );
