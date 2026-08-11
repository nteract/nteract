#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "../..");
const NODE_CRATE_MANIFEST = join(WORKSPACE_ROOT, "crates/runtimed-node/Cargo.toml");

export const RELEASE_TARGETS = Object.freeze({
  wrapper: Object.freeze({
    assetStem: "runtimed-node-wrapper",
    packageName: "@runtimed/node",
  }),
  "darwin-arm64": Object.freeze({
    assetStem: "runtimed-node-darwin-arm64",
    packageName: "@runtimed/node-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binary: "runtimed-node.darwin-arm64.node",
  }),
  "darwin-x64": Object.freeze({
    assetStem: "runtimed-node-darwin-x64",
    packageName: "@runtimed/node-darwin-x64",
    os: "darwin",
    cpu: "x64",
    binary: "runtimed-node.darwin-x64.node",
  }),
  "linux-x64-gnu": Object.freeze({
    assetStem: "runtimed-node-linux-x64-gnu",
    packageName: "@runtimed/node-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    binary: "runtimed-node.linux-x64-gnu.node",
  }),
  "win32-x64-msvc": Object.freeze({
    assetStem: "runtimed-node-win32-x64-msvc",
    packageName: "@runtimed/node-win32-x64-msvc",
    os: "win32",
    cpu: "x64",
    binary: "runtimed-node.win32-x64-msvc.node",
  }),
});

const PLATFORM_TARGETS = Object.keys(RELEASE_TARGETS).filter((target) => target !== "wrapper");

function assertToken(label, value) {
  if (!value || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value)) {
    throw new Error(
      `${label} must be a non-empty release-safe token; received ${JSON.stringify(value)}`,
    );
  }
}

function targetConfig(target) {
  if (!Object.hasOwn(RELEASE_TARGETS, target)) {
    throw new Error(`Unsupported runtimed-node release target ${JSON.stringify(target)}`);
  }
  return RELEASE_TARGETS[target];
}

export function releaseAssetName(target, releaseVersion) {
  assertToken("release version", releaseVersion);
  return `${targetConfig(target).assetStem}-${releaseVersion}.tgz`;
}

export function releaseManifestName(releaseVersion) {
  assertToken("release version", releaseVersion);
  return `runtimed-node-assets-${releaseVersion}.json`;
}

export function nodeApiVersionFromCargoManifest(manifestPath = NODE_CRATE_MANIFEST) {
  const manifest = readFileSync(manifestPath, "utf8");
  const napiDependency = /^napi\s*=\s*\{([^}]*)\}\s*$/m.exec(manifest)?.[1];
  const features = /features\s*=\s*\[([^\]]*)\]/.exec(napiDependency ?? "")?.[1];
  const versions = [...(features ?? "").matchAll(/"napi([0-9]+)"/g)].map((match) =>
    Number(match[1]),
  );
  if (versions.length !== 1 || !Number.isInteger(versions[0])) {
    throw new Error(
      `${manifestPath} must configure exactly one napiN feature; found ${versions.join(", ") || "none"}`,
    );
  }
  return versions[0];
}

export function buildReleaseManifest({ releaseVersion, sourceRevision, packageVersion }) {
  assertToken("release version", releaseVersion);
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error(
      `source revision must be a full lowercase Git commit SHA; received ${sourceRevision}`,
    );
  }
  if (!packageVersion) {
    throw new Error("package version is required");
  }

  return {
    schema_version: 1,
    release_version: releaseVersion,
    source_revision: sourceRevision,
    binding_source_revision: sourceRevision.slice(0, 7),
    npm_package_version: packageVersion,
    node_api_version: nodeApiVersionFromCargoManifest(),
    wrapper: {
      package: RELEASE_TARGETS.wrapper.packageName,
      asset: releaseAssetName("wrapper", releaseVersion),
    },
    platforms: Object.fromEntries(
      PLATFORM_TARGETS.map((target) => {
        const config = RELEASE_TARGETS[target];
        return [
          target,
          {
            package: config.packageName,
            asset: releaseAssetName(target, releaseVersion),
            os: config.os,
            cpu: config.cpu,
            ...(config.libc ? { libc: config.libc } : {}),
          },
        ];
      }),
    ),
  };
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    // Windows cannot execute npm.cmd directly through CreateProcess. The
    // command and every argument here are locally generated release paths.
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error}`,
    );
  }
  return result.stdout;
}

export function packWrapperReleaseAsset({ packageRoot = PACKAGE_ROOT, outputDir }) {
  const resolvedPackageRoot = resolve(packageRoot);
  const resolvedOutputDir = resolve(outputDir);
  const manifest = JSON.parse(readFileSync(join(resolvedPackageRoot, "package.json"), "utf8"));
  const optionalDependencies = Object.fromEntries(
    Object.entries(manifest.optionalDependencies ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, version]) => {
        if (version !== "workspace:*") {
          throw new Error(
            `Expected optionalDependencies.${name} to use workspace:*; received ${version}`,
          );
        }
        return [name, manifest.version];
      }),
  );
  const stagedManifest = { ...manifest, optionalDependencies };
  const stagingDirectory = mkdtempSync(join(tmpdir(), "runtimed-node-wrapper-pack-"));

  try {
    for (const relativePath of manifest.files ?? []) {
      const source = join(resolvedPackageRoot, relativePath);
      const destination = join(stagingDirectory, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true });
    }
    copyFileSync(join(WORKSPACE_ROOT, "LICENSE"), join(stagingDirectory, "LICENSE"));
    writeFileSync(
      join(stagingDirectory, "package.json"),
      `${JSON.stringify(stagedManifest, null, 2)}\n`,
    );
    mkdirSync(resolvedOutputDir, { recursive: true });
    const existingArchives = readdirSync(resolvedOutputDir).filter((file) => file.endsWith(".tgz"));
    if (existingArchives.length !== 0) {
      throw new Error(
        `Wrapper output directory ${resolvedOutputDir} must contain no .tgz files; found ${existingArchives.join(", ")}`,
      );
    }
    run(
      commandName("npm"),
      ["pack", "--ignore-scripts", "--pack-destination", resolvedOutputDir, stagingDirectory],
      { cwd: resolvedPackageRoot },
    );
    const archives = readdirSync(resolvedOutputDir).filter((file) => file.endsWith(".tgz"));
    if (archives.length !== 1) {
      throw new Error(
        `Expected exactly one wrapper .tgz in ${resolvedOutputDir}; found ${archives.join(", ")}`,
      );
    }
    const archive = join(resolvedOutputDir, archives[0]);
    assertPackage("wrapper", archive, manifest.version);
    console.log(archive);
    return archive;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export function smokeReleasePair({ wrapperArchive, platformArchive, target, sourceRevision }) {
  const wrapper = assertPackage("wrapper", wrapperArchive);
  assertPackage(target, platformArchive, wrapper.version);
  const stagingDirectory = mkdtempSync(join(tmpdir(), "runtimed-node-release-smoke-"));
  const nodeModulesRoot = join(stagingDirectory, "node_modules");
  const wrapperDirectory = join(nodeModulesRoot, "@runtimed/node");
  const platformDirectory = join(nodeModulesRoot, targetConfig(target).packageName);

  try {
    mkdirSync(wrapperDirectory, { recursive: true });
    mkdirSync(platformDirectory, { recursive: true });
    extractArchive(wrapperArchive, wrapperDirectory);
    extractArchive(platformArchive, platformDirectory);
    const require = createRequire(join(stagingDirectory, "release-asset-smoke.cjs"));
    const relay = require("@runtimed/node/relay");
    if (typeof relay.bindingSourceRevision !== "function") {
      throw new Error("Extracted @runtimed/node/relay does not expose bindingSourceRevision()");
    }
    const actualRevision = relay.bindingSourceRevision();
    if (!sourceRevision.startsWith(actualRevision)) {
      throw new Error(
        `Extracted binding revision ${actualRevision} is not a prefix of ${sourceRevision}`,
      );
    }
    console.log(`${target}: loaded @runtimed/node/relay at ${actualRevision}`);
    return actualRevision;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function archiveCommand(archive, argsBeforeArchive, argsAfterArchive = []) {
  const resolvedArchive = resolve(archive);
  return spawnSync("tar", [...argsBeforeArchive, basename(resolvedArchive), ...argsAfterArchive], {
    cwd: dirname(resolvedArchive),
    encoding: "utf8",
  });
}

function extractArchive(archive, destination) {
  const result = archiveCommand(
    archive,
    ["-xzf"],
    ["-C", resolve(destination), "--strip-components=1"],
  );
  if (result.status !== 0) {
    throw new Error(`Could not extract ${archive}: ${result.stderr || result.stdout}`);
  }
}

function tarOutput(archive, args) {
  const result = archiveCommand(archive, args);
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} ${archive} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function readPackageManifest(archive) {
  const result = archiveCommand(archive, ["-xOf"], ["package/package.json"]);
  if (result.status !== 0) {
    throw new Error(
      `Could not read package/package.json from ${archive}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

function listArchiveFiles(archive) {
  return tarOutput(archive, ["-tzf"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replace(/^\.\//, ""));
}

function assertPackage(target, archive, expectedVersion) {
  const config = targetConfig(target);
  const manifest = readPackageManifest(archive);
  if (manifest.name !== config.packageName) {
    throw new Error(
      `${basename(archive)} contains ${manifest.name}; expected ${config.packageName}`,
    );
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(
      `${basename(archive)} contains package version ${manifest.version}; expected ${expectedVersion}`,
    );
  }

  if (target === "wrapper") {
    const optionalDependencies = manifest.optionalDependencies ?? {};
    const expectedPackages = PLATFORM_TARGETS.map(
      (platform) => RELEASE_TARGETS[platform].packageName,
    );
    const actualPackages = Object.keys(optionalDependencies).sort();
    if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages.sort())) {
      throw new Error(
        `Wrapper optional dependencies are ${actualPackages.join(", ")}; expected ${expectedPackages.join(", ")}`,
      );
    }
    for (const [name, version] of Object.entries(optionalDependencies)) {
      if (version !== manifest.version) {
        throw new Error(
          `Wrapper optional dependency ${name} is ${version}; expected ${manifest.version}`,
        );
      }
    }
    for (const [section, entries] of Object.entries({
      dependencies: manifest.dependencies ?? {},
      optionalDependencies,
    })) {
      for (const [name, version] of Object.entries(entries)) {
        if (String(version).startsWith("workspace:")) {
          throw new Error(`${section}.${name} still uses the workspace protocol`);
        }
      }
    }
  } else {
    if (!manifest.os?.includes(config.os) || !manifest.cpu?.includes(config.cpu)) {
      throw new Error(
        `${basename(archive)} has platform ${JSON.stringify({ os: manifest.os, cpu: manifest.cpu })}; expected ${config.os}/${config.cpu}`,
      );
    }
    if (config.libc && !manifest.libc?.includes(config.libc)) {
      throw new Error(`${basename(archive)} does not declare libc ${config.libc}`);
    }
    const files = listArchiveFiles(archive);
    if (!files.includes(`package/${config.binary}`)) {
      throw new Error(`${basename(archive)} does not contain package/${config.binary}`);
    }
  }

  return manifest;
}

function parseArgs(argv) {
  const [command, ...rawArgs] = argv;
  const rest = rawArgs.filter((argument) => argument !== "--");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --key value arguments; received ${rest.join(" ")}`);
    }
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function requireArg(values, name) {
  const value = values[name];
  if (!value) {
    throw new Error(`Missing required --${name} argument`);
  }
  return value;
}

function renameAsset(values) {
  const releaseVersion = requireArg(values, "release-version");
  const target = requireArg(values, "target");
  const inputDir = resolve(requireArg(values, "input-dir"));
  const outputDir = resolve(requireArg(values, "output-dir"));
  const archives = readdirSync(inputDir).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one .tgz in ${inputDir}; found ${archives.join(", ")}`);
  }
  const input = join(inputDir, archives[0]);
  assertPackage(target, input);
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, releaseAssetName(target, releaseVersion));
  copyFileSync(input, output);
  console.log(output);
}

function writeManifest(values) {
  const releaseVersion = requireArg(values, "release-version");
  const sourceRevision = requireArg(values, "source-revision");
  const assetsDir = resolve(requireArg(values, "assets-dir"));
  const output = resolve(requireArg(values, "output"));
  const expectedManifestName = releaseManifestName(releaseVersion);
  if (basename(output) !== expectedManifestName) {
    throw new Error(
      `Release manifest must be named ${expectedManifestName}; received ${basename(output)}`,
    );
  }

  const expectedArchives = Object.keys(RELEASE_TARGETS)
    .map((target) => releaseAssetName(target, releaseVersion))
    .sort();
  const actualArchives = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  if (JSON.stringify(actualArchives) !== JSON.stringify(expectedArchives)) {
    throw new Error(
      `Release archive set is ${actualArchives.join(", ")}; expected ${expectedArchives.join(", ")}`,
    );
  }

  const wrapperArchive = join(assetsDir, releaseAssetName("wrapper", releaseVersion));
  const wrapper = assertPackage("wrapper", wrapperArchive);
  for (const target of PLATFORM_TARGETS) {
    assertPackage(
      target,
      join(assetsDir, releaseAssetName(target, releaseVersion)),
      wrapper.version,
    );
  }

  const manifest = buildReleaseManifest({
    releaseVersion,
    sourceRevision,
    packageVersion: wrapper.version,
  });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(output);
}

function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "pack-wrapper") {
    packWrapperReleaseAsset({ outputDir: requireArg(values, "output-dir") });
    return;
  }
  if (command === "rename") {
    renameAsset(values);
    return;
  }
  if (command === "manifest") {
    writeManifest(values);
    return;
  }
  if (command === "smoke") {
    smokeReleasePair({
      wrapperArchive: requireArg(values, "wrapper"),
      platformArchive: requireArg(values, "platform"),
      target: requireArg(values, "target"),
      sourceRevision: requireArg(values, "source-revision"),
    });
    return;
  }
  throw new Error(
    `Usage: ${basename(process.argv[1])} <pack-wrapper|rename|manifest|smoke> --key value ...`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
