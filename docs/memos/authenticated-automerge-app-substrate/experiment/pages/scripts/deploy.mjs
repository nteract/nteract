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
import { parseFromArtifactArgs, promoteFromArtifact } from "./promote-artifact.mjs";
import {
  deploymentProfile,
  assertQualifiedDeploymentTarget,
  assertReleaseOpensTargetPages,
  selectTarget,
  stagePattern,
  verifyDeployment,
  verifyRuntime,
  parseRuntimeVersion,
} from "./deployment/profiles.mjs";
import { provisionTarget } from "./deployment/provision.mjs";
import { SESSION_OVERLAP_DAYS, hostKeyCommand } from "./deployment/session-keys.mjs";
import { OAUTH_REFRESH_SECONDS } from "../shared/oauth-grant.mjs";

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
// `sourceRoot` is the checkout whose source and dist are staged: this one, or
// a promotion worktree holding a gate artifact. The stage lands under this
// checkout's .context either way. `releaseArtifact` records that artifact.
function prepare({ sourceRoot = repo, sourceApp = pages, releaseArtifact } = {}) {
  if (run("git", ["status", "--porcelain"], { cwd: sourceRoot }))
    throw new Error("Commit the reviewed source before preparing a deployment");
  const source = run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  const dist = path.join(sourceApp, "dist");
  const buildReceipt = JSON.parse(readFileSync(path.join(dist, "build-receipt.json")));
  const currentFingerprint = sourceFingerprint(sourceApp, { root: sourceRoot });
  if (buildReceipt.fingerprint?.sha256 !== currentFingerprint.sha256)
    throw new Error("Bundle source fingerprint is stale; build and validate the current source");
  assertReleaseOpensTargetPages(target, { ...buildReceipt, source_sha: source });
  const config = JSON.parse(readFileSync(path.join(dist, "wrangler.json")));
  if (config.main !== "index.js" || config.no_bundle !== true || config.build || config.containers)
    throw new Error("Build a static no_bundle Worker before preparing");
  if (
    Object.keys(config.vars ?? {}).some((key) =>
      /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SESSION_KEYS/.test(key),
    )
  )
    throw new Error("Deployment artifacts must not contain secret variables");
  const runtime = JSON.parse(
    ssh(
      "node -e " +
        quote(
          `const cp=require('node:child_process'),fs=require('node:fs'),c=require('node:crypto');const p=${JSON.stringify(deployment.runtime)};console.log(JSON.stringify({version:cp.execFileSync(p,['--version'],{encoding:'utf8'}).trim(),sha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))`,
        ),
    ),
  );
  runtime.version = parseRuntimeVersion(runtime.version);
  verifyRuntime(runtime);
  const output = path.join(repo, ".context", target + "-deploy", source);
  if (existsSync(output))
    throw new Error("Prepared release already exists; inspect it instead of replacing it");
  mkdirSync(output, { recursive: true });
  stageArtifacts(dist, path.join(output, "release"));
  for (const name of [
    "install.mjs",
    "activation.mjs",
    "firewall.mjs",
    "publish.mjs",
    "profiles.mjs",
    "isolated-publication.mjs",
    "connector-slots.mjs",
    "routes.mjs",
    "session-keys.mjs",
  ])
    cpSync(path.join(sourceApp, "scripts", "deployment", name), path.join(output, name));
  const manifest = {
    schema: 1,
    source_sha: source,
    source_tree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd: sourceRoot }),
    prepared_at: new Date().toISOString(),
    source_fingerprint: currentFingerprint.sha256,
    build_receipt: buildReceipt,
    ...(releaseArtifact ? { release_artifact: releaseArtifact } : {}),
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
      {
        prepared: output,
        source_sha: source,
        runtime,
        files: Object.keys(manifest.files).length,
        ...(releaseArtifact ? { release_artifact: releaseArtifact } : {}),
      },
      null,
      2,
    ),
  );
}
const [mode = "plan", stage, flag, extra, ...rest] = args;
// `install ... --apply --restart` restarts the service even when nothing it
// reads at startup changed.
const restart = mode === "install" && extra === "--restart";
const keyMode = ["rotate-key", "retire-key"].includes(mode);
const fromArtifact = mode === "prepare" && stage === "--from-artifact";
if (!keyMode && !fromArtifact && ((extra && !restart) || rest.length))
  throw new Error("Unexpected deployment argument");
if (
  ["prepare", "upload", "install", "provision", "publish", "rotate-key", "retire-key"].includes(
    mode,
  )
)
  assertQualifiedDeploymentTarget(target);
if (mode === "plan" && !stage) console.log(JSON.stringify(deployment, null, 2));
else if (mode === "prepare" && !stage) prepare();
else if (fromArtifact)
  promoteFromArtifact({
    ...parseFromArtifactArgs(args.slice(1)),
    repo,
    appRelative: path.relative(repo, pages),
    prepare,
  });
else if (keyMode) {
  // Edits /etc/<service>/session-keys.json on the host. The helper comes from
  // this checkout over SSH stdin and runs as root under the deployment lock;
  // a new secret is generated there and never leaves the host. Without
  // --apply it prints the plan. The Worker sees the change on the next
  // `install REMOTE_STAGE --apply`. With OAuth, grants keep email proofs for
  // their whole lifetime, so retiring waits that long instead of a session's.
  const overlapDays = deploymentProfile(target).oauth
    ? OAUTH_REFRESH_SECONDS / (24 * 60 * 60)
    : SESSION_OVERLAP_DAYS;
  const command = hostKeyCommand(mode, args.slice(1), deployment, { overlapDays });
  console.log(
    run(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        deployment.host,
        "sudo flock -n /run/nteract-pages-next-deploy.lock node --input-type=module - " +
          command.map(quote).join(" "),
      ],
      { input: readFileSync(path.join(scripts, "deployment", "session-keys.mjs")) },
    ),
  );
} else if (mode === "provision" && [undefined, "--apply"].includes(stage) && !flag) {
  // The token comes from the environment only. The result never holds it or
  // the tunnel secret.
  const result = await provisionTarget({
    token: process.env.CLOUDFLARE_API_TOKEN,
    target,
    apply: stage === "--apply",
  });
  console.log(JSON.stringify(result, null, 2));
} else if (mode === "upload" && stage && !flag) {
  const absolute = path.resolve(stage);
  const manifest = JSON.parse(readFileSync(path.join(absolute, "manifest.json")));
  verifyDeployment(manifest, target);
  assertReleaseOpensTargetPages(target, {
    ...manifest.build_receipt,
    source_sha: manifest.source_sha,
  });
  const remote = ssh("mktemp -d /tmp/" + deployment.service + "-stage-XXXXXXXX");
  if (!stagePattern(target).test(remote)) throw new Error("Unexpected remote staging directory");
  run("scp", ["-r", absolute + "/.", deployment.host + ":" + remote]);
  console.log(JSON.stringify({ uploaded: remote, source_sha: manifest.source_sha }));
} else if (
  ["install", "publish"].includes(mode) &&
  stagePattern(target).test(stage ?? "") &&
  flag === "--apply"
) {
  // A stage carries its own install.mjs, and one prepared before the record
  // storage check never runs it. Check the staged release from this checkout
  // first, so installing an older release (a rollback) is refused here too.
  if (mode === "install") {
    const staged = JSON.parse(ssh("cat " + quote(stage + "/manifest.json")));
    assertReleaseOpensTargetPages(target, {
      ...staged.build_receipt,
      source_sha: staged.source_sha,
    });
  }
  // Serialize operator commands across the isolated deployment profiles.
  console.log(
    ssh(
      `sudo flock -n /run/nteract-pages-next-deploy.lock node ${quote(stage + "/" + mode + ".mjs")} ${quote(stage)} --apply` +
        (restart ? " --restart" : ""),
    ),
  );
} else
  throw new Error(
    "Usage: deploy.mjs [--target pages-next|page3|page4|page5|page6|page7|page8|page9|page10|pages|pages2] [plan | prepare [--from-artifact GATE_RUN_ID [--attempt N] [--worktree]] | upload LOCAL_STAGE | install REMOTE_STAGE --apply [--restart] | provision [--apply] | publish REMOTE_STAGE --apply | rotate-key [--apply --from ACTIVE_KID] | retire-key [--kid KID] [--force] [--apply --from ACTIVE_KID]]",
  );
