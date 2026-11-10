#!/usr/bin/env node
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageArtifacts } from "./stage-artifacts.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import {
  assertReleaseOpensTargetPages,
  deploymentProfile,
  parseRuntimeVersion,
  stagePattern,
  verifyDeployment,
  verifyRuntime,
} from "./deployment/profiles.mjs";
import { controllerDeploymentCompatibility } from "./deployment/controller-compatibility.mjs";
export { controllerDeploymentCompatibility } from "./deployment/controller-compatibility.mjs";

export const controllerDeploymentTarget = "page10";
export const controllerAppRelativePath = path.join("apps", "pages");
export const controllerDeploymentHelpers = Object.freeze([
  "install.mjs",
  "activation.mjs",
  "firewall.mjs",
  "publish.mjs",
  "profiles.mjs",
  "isolated-publication.mjs",
  "connector-slots.mjs",
  "routes.mjs",
  "session-keys.mjs",
]);
const usage =
  "Usage: controller-deploy.mjs prepare SOURCE_CHECKOUT STAGE [--source-sha FULL_SHA] | install STAGE --apply | publish STAGE --apply";
const deployment = deploymentProfile(controllerDeploymentTarget).deployment;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const defaultFs = {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
};

function run(execFileSyncImpl, command, args, options = {}) {
  return execFileSyncImpl(command, args, { encoding: "utf8", ...options }).trim();
}
function digestFile(fsOps, file) {
  return sha256(fsOps.readFileSync(file));
}
function digestRegularFile(fsOps, file, label) {
  if (!fsOps.lstatSync(file).isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return digestFile(fsOps, file);
}
function readRegularFile(fsOps, file, label) {
  if (!fsOps.lstatSync(file).isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return fsOps.readFileSync(file, "utf8");
}
function stageFiles(fsOps, directory, prefix = "") {
  return fsOps
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const relative = prefix + name;
      if (!/^[A-Za-z0-9_./-]+$/.test(relative)) throw new Error("Unsupported artifact filename");
      const absolute = path.join(directory, name);
      const stat = fsOps.lstatSync(absolute);
      if (stat.isDirectory()) return stageFiles(fsOps, absolute, relative + "/");
      if (!stat.isFile()) throw new Error("Symlinks and special files are not release artifacts");
      return [relative];
    });
}
function buildManifest(fsOps, stage, manifest) {
  return {
    ...manifest,
    files: Object.fromEntries(
      stageFiles(fsOps, stage).map((file) => [file, digestFile(fsOps, path.join(stage, file))]),
    ),
  };
}

export function controllerPaths({
  sourceCheckout,
  trustedScriptsDir = path.dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const trustedScripts = path.resolve(trustedScriptsDir);
  const trustedApp = path.resolve(trustedScripts, "..");
  const trustedCheckout = path.resolve(trustedApp, "../..");
  const relativeApp = path.relative(trustedCheckout, trustedApp);
  if (!relativeApp || relativeApp.startsWith("../") || path.isAbsolute(relativeApp))
    throw new Error("Trusted Pages app must stay inside its checkout");
  const sourceRoot = path.resolve(sourceCheckout ?? "");
  return {
    trustedScripts,
    trustedApp,
    trustedCheckout,
    sourceRoot,
    sourceApp: path.join(sourceRoot, relativeApp),
    stagePattern: stagePattern(controllerDeploymentTarget),
    compatibilityFile: path.join(
      trustedApp,
      "scripts",
      "deployment",
      "controller-compatibility.mjs",
    ),
  };
}

export function validateControllerStage(stage, pattern = stagePattern(controllerDeploymentTarget)) {
  const resolved = path.resolve(stage ?? "");
  if (!pattern.test(resolved))
    throw new Error(`Explicit ${controllerDeploymentTarget} stage required (${pattern.source})`);
  return resolved;
}

export function validateControllerCompatibility(
  trustedText,
  sourceText,
  expected = controllerDeploymentCompatibility,
) {
  if (trustedText !== sourceText)
    throw new Error(
      "Controller compatibility marker mismatch between trusted and source checkouts",
    );
  const canonical = `export const controllerDeploymentCompatibility = ${JSON.stringify(expected)};\n`;
  if (trustedText !== canonical)
    throw new Error(`Expected controller compatibility ${JSON.stringify(expected)}`);
  return expected;
}

export function validateExpectedSourceSha(actual, expected) {
  if (expected === undefined) return actual;
  if (!/^[a-f0-9]{40}$/.test(expected ?? "")) throw new Error("Expected a full 40-hex source SHA");
  if (actual !== expected)
    throw new Error(`Source checkout HEAD ${actual} does not match ${expected}`);
  return actual;
}

export function planControllerPrepare({
  sourceCheckout,
  stage,
  expectedSourceSha,
  trustedScriptsDir,
} = {}) {
  if (!sourceCheckout || !stage) throw new Error(usage);
  return {
    mode: "prepare",
    expectedSourceSha,
    stage: validateControllerStage(stage),
    ...controllerPaths({ sourceCheckout, trustedScriptsDir }),
  };
}

export function planControllerApply({ mode, stage, trustedScriptsDir } = {}) {
  if (!mode || !stage) throw new Error(usage);
  if (!["install", "publish"].includes(mode)) throw new Error(usage);
  return {
    mode,
    stage: validateControllerStage(stage),
    ...controllerPaths({ sourceCheckout: path.resolve("/"), trustedScriptsDir }),
  };
}

export function verifyStagedHelpers(
  stage,
  {
    fsOps = defaultFs,
    trustedScriptsDir = path.dirname(fileURLToPath(import.meta.url)),
    manifest = JSON.parse(readRegularFile(fsOps, path.join(stage, "manifest.json"), "Manifest")),
  } = {},
) {
  for (const helper of controllerDeploymentHelpers) {
    const trusted = path.join(trustedScriptsDir, "deployment", helper);
    const staged = path.join(stage, helper);
    const trustedDigest = digestRegularFile(fsOps, trusted, "Trusted helper");
    const stagedDigest = digestRegularFile(fsOps, staged, "Staged helper");
    if (manifest.files?.[helper] !== trustedDigest)
      throw new Error(`Manifest helper digest mismatch for ${helper}`);
    if (stagedDigest !== trustedDigest)
      throw new Error(`Staged helper differs from trusted checkout: ${helper}`);
  }
  return true;
}

export function prepareControllerStage(
  plan,
  {
    execFileSyncImpl = execFileSync,
    fsOps = defaultFs,
    now = () => new Date().toISOString(),
    sourceFingerprintImpl = sourceFingerprint,
    stageArtifactsImpl = stageArtifacts,
    verifyRuntimeImpl = verifyRuntime,
    parseRuntimeVersionImpl = parseRuntimeVersion,
    assertReleaseOpensTargetPagesImpl = assertReleaseOpensTargetPages,
  } = {},
) {
  const git = (...args) => run(execFileSyncImpl, "git", args, { cwd: plan.sourceRoot });
  if (git("rev-parse", "--show-toplevel") !== plan.sourceRoot)
    throw new Error("Provide the source checkout root");
  if (git("status", "--porcelain")) throw new Error("Commit the reviewed source before preparing");
  const sourceSha = validateExpectedSourceSha(git("rev-parse", "HEAD"), plan.expectedSourceSha);
  const trustedCompatibility = readRegularFile(
    fsOps,
    plan.compatibilityFile,
    "Trusted compatibility marker",
  );
  const sourceCompatibility = readRegularFile(
    fsOps,
    path.join(plan.sourceApp, "scripts", "deployment", "controller-compatibility.mjs"),
    "Source compatibility marker",
  );
  validateControllerCompatibility(trustedCompatibility, sourceCompatibility);
  const dist = path.join(plan.sourceApp, "dist");
  const buildReceipt = JSON.parse(
    readRegularFile(fsOps, path.join(dist, "build-receipt.json"), "Build receipt"),
  );
  const fingerprint = sourceFingerprintImpl(plan.sourceApp, { root: plan.sourceRoot });
  if (
    buildReceipt.source_dirty ||
    buildReceipt.source_sha !== sourceSha ||
    buildReceipt.fingerprint?.sha256 !== fingerprint.sha256
  )
    throw new Error("Rebuild the clean committed source before staging");
  assertReleaseOpensTargetPagesImpl(controllerDeploymentTarget, {
    ...buildReceipt,
    source_sha: sourceSha,
  });
  const config = JSON.parse(
    readRegularFile(fsOps, path.join(dist, "wrangler.json"), "Worker config"),
  );
  if (config.main !== "index.js" || config.no_bundle !== true || config.build || config.containers)
    throw new Error("Build a static no_bundle Worker before preparing");
  if (
    Object.keys(config.vars ?? {}).some((key) =>
      /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SESSION_KEYS/.test(key),
    )
  )
    throw new Error("Deployment artifacts must not contain secret variables");
  if (fsOps.existsSync(plan.stage))
    throw new Error("Prepared stage already exists; inspect it instead of replacing it");
  const runtime = {
    version: parseRuntimeVersionImpl(run(execFileSyncImpl, deployment.runtime, ["--version"])),
    sha256: sha256(fsOps.readFileSync(deployment.runtime)),
  };
  verifyRuntimeImpl(runtime);
  fsOps.mkdirSync(plan.stage, { recursive: false, mode: 0o700 });
  stageArtifactsImpl(dist, path.join(plan.stage, "release"));
  for (const helper of controllerDeploymentHelpers)
    fsOps.cpSync(
      path.join(plan.trustedScripts, "deployment", helper),
      path.join(plan.stage, helper),
    );
  const manifest = buildManifest(fsOps, plan.stage, {
    schema: 1,
    source_sha: sourceSha,
    source_tree: git("rev-parse", "HEAD^{tree}"),
    prepared_at: now(),
    source_fingerprint: fingerprint.sha256,
    build_receipt: buildReceipt,
    deployment,
    runtime,
  });
  fsOps.writeFileSync(
    path.join(plan.stage, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  return {
    prepared: plan.stage,
    source_sha: sourceSha,
    runtime,
    files: Object.keys(manifest.files).length,
  };
}

export function applyControllerStage(
  plan,
  {
    execFileSyncImpl = execFileSync,
    fsOps = defaultFs,
    verifyDeploymentImpl = verifyDeployment,
    assertReleaseOpensTargetPagesImpl = assertReleaseOpensTargetPages,
  } = {},
) {
  const manifest = JSON.parse(
    readRegularFile(fsOps, path.join(plan.stage, "manifest.json"), "Manifest"),
  );
  verifyDeploymentImpl(manifest, controllerDeploymentTarget);
  assertReleaseOpensTargetPagesImpl(controllerDeploymentTarget, {
    ...manifest.build_receipt,
    source_sha: manifest.source_sha,
  });
  verifyStagedHelpers(plan.stage, {
    fsOps,
    trustedScriptsDir: plan.trustedScripts,
    manifest,
  });
  return run(execFileSyncImpl, "/usr/bin/flock", [
    "-n",
    "/run/nteract-pages-next-deploy.lock",
    "/usr/bin/node",
    path.join(plan.trustedScripts, "deployment", `${plan.mode}.mjs`),
    plan.stage,
    "--apply",
  ]);
}

export function parseControllerArgs(argv) {
  const [mode, ...args] = argv;
  if (mode === "prepare") {
    const [sourceCheckout, stage, ...rest] = args;
    if (!sourceCheckout || !stage) throw new Error(usage);
    if (!rest.length) return { mode, sourceCheckout, stage };
    if (rest.length === 2 && rest[0] === "--source-sha")
      return { mode, sourceCheckout, stage, expectedSourceSha: rest[1] };
    throw new Error(usage);
  }
  if (["install", "publish"].includes(mode)) {
    const [stage, apply, ...rest] = args;
    if (!stage || apply !== "--apply" || rest.length) throw new Error(usage);
    return { mode, stage };
  }
  throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const parsed = parseControllerArgs(process.argv.slice(2));
  if (parsed.mode === "prepare")
    console.log(
      JSON.stringify(
        prepareControllerStage(
          planControllerPrepare({
            sourceCheckout: parsed.sourceCheckout,
            stage: parsed.stage,
            expectedSourceSha: parsed.expectedSourceSha,
          }),
        ),
        null,
        2,
      ),
    );
  else {
    const output = applyControllerStage(planControllerApply(parsed));
    if (output) console.log(output);
  }
}
