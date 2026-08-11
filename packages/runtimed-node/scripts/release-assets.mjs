#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
    node_api_version: 9,
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

function tarOutput(archive, args) {
  const result = spawnSync("tar", [...args, archive], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} ${archive} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function readPackageManifest(archive) {
  const result = spawnSync("tar", ["-xOf", archive, "package/package.json"], {
    encoding: "utf8",
  });
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
  const [command, ...rest] = argv;
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
  if (command === "rename") {
    renameAsset(values);
    return;
  }
  if (command === "manifest") {
    writeManifest(values);
    return;
  }
  throw new Error(`Usage: ${basename(process.argv[1])} <rename|manifest> --key value ...`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
