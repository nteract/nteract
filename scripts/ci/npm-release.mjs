import {setTimeout as sleep} from "node:timers/promises";

// Pure release decisions shared by the pack and OIDC-only publication jobs.
export const nativeTargets = [
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "win32-x64-msvc",
  "win32-arm64-msvc",
];

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error(`Invalid ${name}`);
  return String(value);
}

export function releaseIdentity(run, expected) {
  const runId = positiveInteger(expected.runId, "release run ID");
  const runAttempt = positiveInteger(expected.runAttempt, "release run attempt");
  if (String(run.id) !== runId || String(run.run_attempt) !== runAttempt) {
    throw new Error("Release run identity does not match the requested run and attempt");
  }
  if (run.repository?.full_name !== expected.repository || run.head_repository?.full_name !== expected.repository) {
    throw new Error("Release must originate in this repository");
  }
  const channels = {
    ".github/workflows/release-stable.yml": "stable",
    ".github/workflows/release-nightly.yml": "nightly",
  };
  const channel = channels[run.path];
  if (!channel || !["workflow_dispatch", "schedule", "push"].includes(run.event)) {
    throw new Error("Expected a Stable Release or Nightly Release workflow run");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Upstream release must have completed successfully");
  }
  if (!/^[a-f0-9]{40}$/.test(run.head_sha) || (expected.sourceSha && run.head_sha !== expected.sourceSha)) {
    throw new Error("Upstream source SHA does not match the triggering release");
  }
  return { channel, sourceSha: run.head_sha, runId, runAttempt };
}

function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.([1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`Unsupported npm release version: ${version}`);
  return match.slice(1).map(value => value === undefined ? undefined : BigInt(value));
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === undefined) return 1;
  if (b[3] === undefined) return -1;
  return a[3] > b[3] ? 1 : -1;
}

export function releasePlan(baseVersion, identity, linuxArm64Enabled, windowsArm64Enabled) {
  if (versionParts(baseVersion)[3] !== undefined) throw new Error("Checked-in Node version must be stable");
  if (!["stable", "nightly"].includes(identity.channel)) throw new Error("Invalid release channel");
  const runId = positiveInteger(identity.runId, "release run ID");
  return {
    ...identity,
    baseVersion,
    version: identity.channel === "nightly" ? `${baseVersion}-nightly.${runId}` : baseVersion,
    distTag: identity.channel === "nightly" ? "nightly" : "latest",
    nativeTargets: nativeTargets.filter(target =>
      (target !== "linux-arm64-gnu" || linuxArm64Enabled === "true") &&
      (target !== "win32-arm64-msvc" || windowsArm64Enabled === "true")),
  };
}

export function packageName(target) {
  if (target === "wrapper") return "@runtimed/node";
  if (target === "pi") return "@nteract/pi";
  if (!nativeTargets.includes(target)) throw new Error(`Unknown native target ${target}`);
  return `@runtimed/node-${target}`;
}

function metadata(plan) {
  // An upstream rerun keeps its run ID and source. Attempts must not change
  // the bytes assigned to that immutable npm version.
  return { channel: plan.channel, sourceSha: plan.sourceSha, runId: plan.runId };
}

export function stampManifest(manifest, plan, target) {
  if (manifest.name !== packageName(target)) throw new Error(`Unexpected package ${manifest.name}`);
  if (manifest.version !== plan.baseVersion) throw new Error(`Checked-in version mismatch for ${manifest.name}`);
  const stamped = { ...manifest, version: plan.version, nteractRelease: metadata(plan) };
  if (target === "wrapper") {
    const expected = nativeTargets.map(packageName).sort();
    if (JSON.stringify(Object.keys(manifest.optionalDependencies ?? {}).sort()) !== JSON.stringify(expected)) {
      throw new Error("Source wrapper native dependency inventory has changed");
    }
    stamped.optionalDependencies = Object.fromEntries(plan.nativeTargets.map(target => [packageName(target), plan.version]));
  }
  return stamped;
}

export function stampBuildManifest(manifest, plan, target) {
  const stamped = stampManifest(manifest, plan, target);
  // napi-rs embeds this version in its loader. Keep workspace links intact
  // until pnpm has finished building, validating and packing the package.
  if (target === "wrapper") stamped.optionalDependencies = {...manifest.optionalDependencies};
  return stamped;
}

export function finalizePackedManifest(manifest, plan, target) {
  if (manifest.version !== plan.version) throw new Error("Packed build version does not match the release");
  for (const [key, value] of Object.entries(metadata(plan))) {
    if (manifest.nteractRelease?.[key] !== value) throw new Error(`Packed build identity mismatch: ${key}`);
  }
  const finalized = stampManifest({...manifest, version: plan.baseVersion}, plan, target);
  verifyManifest(finalized, plan, target);
  return finalized;
}

export function verifyManifest(manifest, plan, target) {
  if (manifest.name !== packageName(target)) throw new Error(`Unexpected package ${manifest.name}`);
  if (target === "pi") {
    if (plan.channel !== "stable" || manifest.dependencies?.["@runtimed/node"] !== plan.version) {
      throw new Error("Pi must use the exact stable Node release");
    }
  } else {
    if (manifest.version !== plan.version) throw new Error("Packed version does not match the release");
    for (const [key, value] of Object.entries(metadata(plan))) {
      if (manifest.nteractRelease?.[key] !== value) throw new Error(`Packed release identity mismatch: ${key}`);
    }
  }
  if (manifest.dependencies?.runtimed) throw new Error("Packed manifest depends on private package runtimed");
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (String(version).startsWith("workspace:")) throw new Error(`${section}.${name} uses workspace protocol`);
    }
  }
  if (target === "wrapper") {
    assertWrapperDependencies(manifest, plan);
  }
}

function assertWrapperDependencies(manifest, plan) {
  const expected = Object.fromEntries(plan.nativeTargets.map(target => [packageName(target), plan.version]));
  const actual = manifest.optionalDependencies ?? {};
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
    throw new Error("Packed native dependencies do not match the publication gate");
  }
  for (const [name, version] of Object.entries(expected)) {
    if (actual[name] !== version) throw new Error(`Native dependency ${name} must be exactly ${version}`);
  }
}

export function assertPublishedIdentity(manifest, plan) {
  // Existing stable releases predate this metadata. Nightly versions are new
  // and must be tied to the intended immutable source, including on retries.
  if (plan.channel === "nightly") {
    for (const key of ["channel", "sourceSha", "runId"]) {
      if (manifest.nteractRelease?.[key] !== plan[key]) throw new Error(`Published release identity mismatch: ${key}`);
    }
  }
}

export function publicationDecision(manifest, plan, packument) {
  const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const versions = packument?.versions;
  const tags = packument?.["dist-tags"];
  if (!isRecord(packument) || !isRecord(versions) || !isRecord(tags)) {
    throw new Error("Invalid registry metadata; refusing to publish");
  }
  const existing = versions[manifest.version];
  if (existing !== undefined) {
    if (!isRecord(existing) || existing.version !== manifest.version) throw new Error("Invalid existing registry version");
    assertPublishedIdentity(existing, plan);
    return "existing";
  }
  const taggedVersion = tags[plan.distTag];
  if (taggedVersion === undefined) return "publish";
  if (typeof taggedVersion !== "string" || !taggedVersion) throw new Error("Invalid registry dist-tag");
  const tagged = versions[taggedVersion];
  if (!isRecord(tagged) || tagged.version !== taggedVersion) throw new Error("Registry dist-tag points to a missing version");
  const taggedRunId = tagged.nteractRelease?.runId;
  if (taggedRunId && BigInt(positiveInteger(taggedRunId, "published run ID")) > BigInt(plan.runId)) return "stale";
  if (compareVersions(manifest.version, taggedVersion) <= 0) return "stale";
  return "publish";
}

export async function registryPackage(name, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(30_000),
    headers: {"Cache-Control": "no-cache"},
  });
  if (response.status === 404) return { versions: {}, "dist-tags": {} };
  if (!response.ok) throw new Error(`Registry lookup failed for ${name}: HTTP ${response.status}`);
  return response.json();
}

export async function assertNativeDependencies(manifest, plan, fetchPackage = registryPackage, {
  timeoutMs = 600_000, intervalMs = 10_000, now = () => performance.now(),
  wait = sleep, onWait = message => console.error(message),
} = {}) {
  const deadline = now() + timeoutMs;
  let missing = [];
  do {
    missing = [];
    for (const [name, version] of Object.entries(manifest.optionalDependencies ?? {})) {
      const packument = await fetchPackage(name);
      const versions = packument?.versions;
      if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
        throw new Error(`Invalid registry metadata for ${name}`);
      }
      const published = versions[version];
      if (published === undefined) {
        missing.push(`${name}@${version}`);
      } else {
        if (!published || typeof published !== "object" || Array.isArray(published) || published.version !== version) {
          throw new Error(`Invalid existing registry version for ${name}@${version}`);
        }
        assertPublishedIdentity(published, plan);
      }
    }
    if (missing.length === 0) return;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    onWait(`Waiting for native npm publication: ${missing.join(", ")}`);
    await wait(Math.min(intervalMs, remaining));
  } while (now() < deadline);
  throw new Error(`Required native package is not published after ${timeoutMs}ms: ${missing.join(", ")}`);
}

export async function publishPackage(manifest, plan, target, { fetchPackage = registryPackage, publish, nativeWait }) {
  verifyManifest(manifest, plan, target);
  if (target !== "wrapper" && target !== "pi" && !plan.nativeTargets.includes(target)) {
    throw new Error("Native target is disabled by the publication gate");
  }
  let packument = await fetchPackage(manifest.name);
  let decision = publicationDecision(manifest, plan, packument);
  if (decision === "stale") {
    throw new Error(`${manifest.name}@${manifest.version} is missing and would move ${plan.distTag} backwards; refusing incomplete older release`);
  }
  if (target === "wrapper") {
    if (decision === "existing") assertWrapperDependencies(packument.versions[manifest.version], plan);
    await assertNativeDependencies(manifest, plan, fetchPackage, nativeWait);
    // Recheck after waiting: never republish an existing version or move a tag
    // backwards if another publisher completed while dependencies propagated.
    if (decision === "publish") {
      packument = await fetchPackage(manifest.name);
      decision = publicationDecision(manifest, plan, packument);
      if (decision === "stale") throw new Error("Wrapper release became stale while waiting for native publication");
      if (decision === "existing") assertWrapperDependencies(packument.versions[manifest.version], plan);
    }
  }
  if (decision === "publish") await publish();
  return {
    requestedRelease: plan,
    package: manifest.name,
    version: manifest.version,
    // Old stable packages may lack provenance; don't attribute their bytes to
    // the requested run just because that package/version already exists.
    registryRelease: decision === "existing" ? packument.versions[manifest.version].nteractRelease ?? null : manifest.nteractRelease ?? null,
    status: decision === "existing" ? "existing" : "published",
  };
}
