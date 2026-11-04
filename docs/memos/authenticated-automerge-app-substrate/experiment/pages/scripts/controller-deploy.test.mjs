import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyControllerStage,
  controllerAppRelativePath,
  controllerDeploymentCompatibility,
  controllerDeploymentHelpers,
  parseControllerArgs,
  planControllerApply,
  planControllerPrepare,
  prepareControllerStage,
} from "./controller-deploy.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { releaseArtifacts } from "./stage-artifacts.mjs";
import { deploymentProfile } from "./deployment/profiles.mjs";
import { VIEWER_ASSETS, hashedAssetPath } from "./viewer-chunks.mjs";

const TARGET = "page10";
const deployment = deploymentProfile(TARGET).deployment;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compatibilitySource = `export const controllerDeploymentCompatibility = ${JSON.stringify(controllerDeploymentCompatibility)};\n`;

function listFiles(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute, relative + "/") : [relative];
  });
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pages-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trustedRoot = path.join(root, "trusted");
  const sourceRoot = path.join(root, "source");
  const trustedApp = path.join(trustedRoot, controllerAppRelativePath);
  const sourceApp = path.join(sourceRoot, controllerAppRelativePath);
  const trustedScripts = path.join(trustedApp, "scripts");
  const trustedDeployment = path.join(trustedScripts, "deployment");
  const sourceDeployment = path.join(sourceApp, "scripts", "deployment");
  const stage = `/tmp/${deployment.service}-stage-${sha256(root).slice(0, 8)}`;
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const sourceSha = "a".repeat(40);
  const sourceTree = "b".repeat(40);
  const runtimeBytes = Buffer.from("trusted-runtime-bits");
  const runtimeSha = sha256(runtimeBytes);
  const commands = [];
  for (const helper of controllerDeploymentHelpers)
    write(path.join(trustedDeployment, helper), `trusted ${helper}\n`);
  write(path.join(trustedDeployment, "controller-compatibility.mjs"), compatibilitySource);
  write(path.join(sourceDeployment, "controller-compatibility.mjs"), compatibilitySource);
  for (const name of [
    "package.json",
    "package-lock.json",
    "upstream-provenance.json",
    "patch-upstream.mjs",
    "setup.mjs",
    "UPSTREAM.md",
  ])
    write(
      path.join(sourceRoot, "docs/memos/authenticated-automerge-app-substrate/experiment", name),
      "{}\n",
    );
  write(path.join(sourceRoot, "package.json"), "{}\n");
  write(path.join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  write(path.join(sourceApp, "worker", "index.mjs"), "export const ok = true;\n");
  write(path.join(sourceApp, "scripts", "entry.mjs"), "export const entry = true;\n");
  const dist = path.join(sourceApp, "dist");
  const chunk = "public/chunks/ABCDEFGH.js";
  const assets = Object.fromEntries(
    VIEWER_ASSETS.map((name) => [hashedAssetPath(name, name), name]),
  );
  const viewerChunks = { [chunk]: sha256(chunk) };
  const viewerAssets = Object.fromEntries(
    Object.entries(assets).map(([file, bytes]) => [file, sha256(bytes)]),
  );
  fs.mkdirSync(path.join(dist, "public", "chunks"), { recursive: true });
  for (const file of [...releaseArtifacts, chunk, ...Object.keys(assets)])
    write(
      path.join(dist, file),
      file === "build-receipt.json"
        ? "pending\n"
        : file === "wrangler.json"
          ? JSON.stringify({ main: "index.js", no_bundle: true, vars: {} }, null, 2) + "\n"
          : (assets[file] ?? file),
    );
  const fingerprint = sourceFingerprint(sourceApp, { root: sourceRoot });
  const receipt = {
    schema: 1,
    built_at: "2026-11-04T21:00:00.000Z",
    source_sha: sourceSha,
    source_dirty: false,
    build_id: fingerprint.sha256.slice(0, 12),
    record_storage: ["local", "buffered", "automerge"],
    plain_storage_formats: ["doc-store-v2-host-actor-prefix"],
    viewer_chunks: viewerChunks,
    viewer_assets: viewerAssets,
    fingerprint,
  };
  write(path.join(dist, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  const execFileSyncImpl = (command, args, options = {}) => {
    commands.push({ command, args, options });
    if (command === "git") {
      const joined = args.join(" ");
      if (joined === "rev-parse --show-toplevel")
        return options.encoding ? sourceRoot : Buffer.from(sourceRoot);
      if (joined === "status --porcelain") return options.encoding ? "" : Buffer.alloc(0);
      if (joined === "rev-parse HEAD") return options.encoding ? sourceSha : Buffer.from(sourceSha);
      if (joined === "rev-parse HEAD^{tree}")
        return options.encoding ? sourceTree : Buffer.from(sourceTree);
    }
    if (command === deployment.runtime && args.join(" ") === "--version")
      return options.encoding ? "celld 0.6.3" : Buffer.from("celld 0.6.3");
    if (command === "/usr/bin/flock")
      return options.encoding
        ? JSON.stringify({ command: path.basename(args[3]), stage: args[4] })
        : Buffer.from(JSON.stringify({ command: path.basename(args[3]), stage: args[4] }));
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const fsOps = {
    ...fs,
    readFileSync(file, encoding) {
      if (file === deployment.runtime)
        return encoding ? runtimeBytes.toString(encoding) : runtimeBytes;
      return fs.readFileSync(file, encoding);
    },
  };
  return {
    commands,
    trustedRoot,
    sourceRoot,
    trustedScripts,
    sourceApp,
    dist,
    stage,
    sourceSha,
    sourceTree,
    runtimeSha,
    receipt,
    execFileSyncImpl,
    fsOps,
  };
}

test("prepare stages a trusted page10 release from a separate source checkout", (t) => {
  const fixture = createFixture(t);
  const result = prepareControllerStage(
    planControllerPrepare({
      sourceCheckout: fixture.sourceRoot,
      stage: fixture.stage,
      expectedSourceSha: fixture.sourceSha,
      trustedScriptsDir: fixture.trustedScripts,
    }),
    {
      execFileSyncImpl: fixture.execFileSyncImpl,
      fsOps: fixture.fsOps,
      now: () => "2026-11-04T21:10:00.000Z",
      verifyRuntimeImpl: () => {},
    },
  );
  assert.equal(result.prepared, fixture.stage);
  assert.equal(result.source_sha, fixture.sourceSha);
  assert.equal(result.runtime.version, "celld 0.6.3");
  assert.equal(result.runtime.sha256, fixture.runtimeSha);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.stage, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.source_sha, fixture.sourceSha);
  assert.equal(manifest.source_tree, fixture.sourceTree);
  assert.equal(manifest.prepared_at, "2026-11-04T21:10:00.000Z");
  assert.equal(manifest.source_fingerprint, fixture.receipt.fingerprint.sha256);
  assert.deepEqual(manifest.deployment, deployment);
  assert.equal(manifest.runtime.sha256, fixture.runtimeSha);
  assert.equal(manifest.build_receipt.build_id, fixture.receipt.build_id);
  const files = listFiles(fixture.stage).sort();
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("release/index.js"));
  for (const helper of controllerDeploymentHelpers) {
    assert.ok(files.includes(helper), helper);
    assert.equal(
      fs.readFileSync(path.join(fixture.stage, helper), "utf8"),
      fs.readFileSync(path.join(fixture.trustedScripts, "deployment", helper), "utf8"),
    );
  }
  assert.equal(files.includes("controller-deploy.mjs"), false);
  assert.equal(files.includes("deployment/controller-compatibility.mjs"), false);
  assert.equal(files.includes("release/.dev.vars"), false);
  assert.ok(
    fixture.commands.every(({ command }) => command === "git" || command === deployment.runtime),
  );
});

test("prepare rejects dirty source, source sha mismatches, invalid stages, and compatibility skew", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () =>
      planControllerPrepare({
        sourceCheckout: fixture.sourceRoot,
        stage: "/tmp/not-page10-stage",
        trustedScriptsDir: fixture.trustedScripts,
      }),
    /Explicit page10 stage required/,
  );
  assert.throws(
    () =>
      prepareControllerStage(
        planControllerPrepare({
          sourceCheckout: fixture.sourceRoot,
          stage: fixture.stage,
          expectedSourceSha: "c".repeat(40),
          trustedScriptsDir: fixture.trustedScripts,
        }),
        {
          execFileSyncImpl: fixture.execFileSyncImpl,
          fsOps: fixture.fsOps,
          verifyRuntimeImpl: () => {},
        },
      ),
    /does not match/,
  );
  const skew = createFixture(t);
  fs.writeFileSync(
    path.join(skew.sourceApp, "scripts", "deployment", "controller-compatibility.mjs"),
    'export const controllerDeploymentCompatibility = "pages-controller-v0";\n',
  );
  assert.throws(
    () =>
      prepareControllerStage(
        planControllerPrepare({
          sourceCheckout: skew.sourceRoot,
          stage: skew.stage,
          trustedScriptsDir: skew.trustedScripts,
        }),
        {
          execFileSyncImpl: skew.execFileSyncImpl,
          fsOps: skew.fsOps,
          verifyRuntimeImpl: () => {},
        },
      ),
    /compatibility marker mismatch/,
  );
  const dirty = createFixture(t);
  const dirtyExec = (command, args, options) => {
    if (command === "git" && args.join(" ") === "status --porcelain") return "M worker/index.mjs\n";
    return dirty.execFileSyncImpl(command, args, options);
  };
  assert.throws(
    () =>
      prepareControllerStage(
        planControllerPrepare({
          sourceCheckout: dirty.sourceRoot,
          stage: dirty.stage,
          trustedScriptsDir: dirty.trustedScripts,
        }),
        { execFileSyncImpl: dirtyExec, fsOps: dirty.fsOps, verifyRuntimeImpl: () => {} },
      ),
    /Commit the reviewed source before preparing/,
  );
});

test("install and publish re-check trusted helper bytes before flocking the trusted installer", (t) => {
  const fixture = createFixture(t);
  prepareControllerStage(
    planControllerPrepare({
      sourceCheckout: fixture.sourceRoot,
      stage: fixture.stage,
      trustedScriptsDir: fixture.trustedScripts,
    }),
    {
      execFileSyncImpl: fixture.execFileSyncImpl,
      fsOps: fixture.fsOps,
      verifyRuntimeImpl: () => {},
    },
  );
  fixture.commands.length = 0;
  for (const mode of ["install", "publish"]) {
    const output = JSON.parse(
      applyControllerStage(
        planControllerApply({
          mode,
          stage: fixture.stage,
          trustedScriptsDir: fixture.trustedScripts,
        }),
        { execFileSyncImpl: fixture.execFileSyncImpl, fsOps: fixture.fsOps },
      ),
    );
    assert.equal(output.command, `${mode}.mjs`);
    assert.equal(output.stage, fixture.stage);
  }
  assert.deepEqual(
    fixture.commands.map(({ command, args }) => [command, args.slice(0, 5)]),
    [
      [
        "/usr/bin/flock",
        [
          "-n",
          "/run/nteract-pages-next-deploy.lock",
          "/usr/bin/node",
          path.join(fixture.trustedScripts, "deployment", "install.mjs"),
          fixture.stage,
        ],
      ],
      [
        "/usr/bin/flock",
        [
          "-n",
          "/run/nteract-pages-next-deploy.lock",
          "/usr/bin/node",
          path.join(fixture.trustedScripts, "deployment", "publish.mjs"),
          fixture.stage,
        ],
      ],
    ],
  );
  const tampered = createFixture(t);
  prepareControllerStage(
    planControllerPrepare({
      sourceCheckout: tampered.sourceRoot,
      stage: tampered.stage,
      trustedScriptsDir: tampered.trustedScripts,
    }),
    {
      execFileSyncImpl: tampered.execFileSyncImpl,
      fsOps: tampered.fsOps,
      verifyRuntimeImpl: () => {},
    },
  );
  tampered.commands.length = 0;
  fs.writeFileSync(path.join(tampered.trustedScripts, "deployment", "profiles.mjs"), "changed\n");
  assert.throws(
    () =>
      applyControllerStage(
        planControllerApply({
          mode: "install",
          stage: tampered.stage,
          trustedScriptsDir: tampered.trustedScripts,
        }),
        { execFileSyncImpl: tampered.execFileSyncImpl, fsOps: tampered.fsOps },
      ),
    /Manifest helper digest mismatch|Staged helper differs from trusted checkout/,
  );
  assert.equal(tampered.commands.length, 0);
});

test("CLI parsing stays bounded to prepare, install, and publish", () => {
  assert.deepEqual(parseControllerArgs(["prepare", "/src", "/tmp/nteract-page10-stage-AbCd1234"]), {
    mode: "prepare",
    sourceCheckout: "/src",
    stage: "/tmp/nteract-page10-stage-AbCd1234",
  });
  assert.deepEqual(
    parseControllerArgs([
      "prepare",
      "/src",
      "/tmp/nteract-page10-stage-AbCd1234",
      "--source-sha",
      "a".repeat(40),
    ]),
    {
      mode: "prepare",
      sourceCheckout: "/src",
      stage: "/tmp/nteract-page10-stage-AbCd1234",
      expectedSourceSha: "a".repeat(40),
    },
  );
  assert.deepEqual(
    parseControllerArgs(["install", "/tmp/nteract-page10-stage-AbCd1234", "--apply"]),
    {
      mode: "install",
      stage: "/tmp/nteract-page10-stage-AbCd1234",
    },
  );
  assert.throws(
    () => parseControllerArgs(["publish", "/tmp/nteract-page10-stage-AbCd1234"]),
    /Usage:/,
  );
  assert.throws(() => parseControllerArgs(["provision"]), /Usage:/);
});
