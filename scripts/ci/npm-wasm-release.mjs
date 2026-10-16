import {createHash} from "node:crypto";
import {gunzipSync} from "node:zlib";
import {setTimeout as sleep} from "node:timers/promises";
import {publicationDecision, registryPackage, releasePlan, stampManifest, verifyManifest} from "./npm-release.mjs";
import {digest, positive, resolveWasmCandidate, successfulJobAtAttempt, validateArtifact, validateWasm} from "./editor-assets-release.mjs";

export const runtimeRoot = "apps/notebook/src/wasm/runtimed-wasm";
export const runtimeFiles = ["runtimed_wasm.js", "runtimed_wasm.d.ts", "runtimed_wasm_bg.wasm", "runtimed_wasm_bg.wasm.d.ts"];
export const tarballName = "runtimed-wasm.tgz";
export const candidateName = identity => `npm-wasm-${positive(identity.runId)}-${positive(identity.runAttempt)}`;
export const buildTitle = identity => `WASM npm for release ${positive(identity.runId)}/${positive(identity.runAttempt)}`;
export const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const packedPaths = ["package.json", "README.md", "LICENSE", "lib/build-info.json", "lib/THIRD_PARTY_NOTICES.md", ...runtimeFiles.map(name => `lib/${name}`)].sort();

export function packageManifest(source, plan) {
  const manifest = stampManifest(source, plan, "wasm");
  // The source template cannot be published directly without its generated lib.
  delete manifest.private;
  return manifest;
}

export function wasmReleasePlan(manifest, identity, wasm, artifact) {
  if (manifest.name !== "@runtimed/wasm") throw new Error("Unexpected WASM package name");
  validateWasm(wasm, identity);
  for (const file of [...runtimeFiles, "package.json", "LICENSE"]) {
    if (!wasm.files[`${runtimeRoot}/${file}`]) throw new Error(`Missing retained runtime file: ${file}`);
  }
  return {...releasePlan(manifest.version, identity), wasm, wasmArtifactId: positive(artifact.id), wasmArtifactDigest: artifact.digest};
}

export async function resolveWasmPlan(source, identity, upstreamRun, api) {
  const selected = await resolveWasmCandidate(identity, {
    ...api, releaseRun: async () => upstreamRun, readWasmReceipt: api.readReceipt,
  });
  return wasmReleasePlan(source, identity, selected.wasm, {
    id: selected.wasmArtifactId, digest: selected.wasmArtifactDigest,
  });
}

// No extraction or package code execution in a publisher. Our npm payload has
// only these regular files; reject links, duplicate names and extended headers.
export function readTarball(bytes) {
  const tar = gunzipSync(bytes, {maxOutputLength: 128 * 1024 * 1024});
  const files = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, "");
    const name = field(0, 100);
    const sizeText = field(124, 12).trim();
    const size = parseInt(sizeText, 8);
    const checksum = parseInt(field(148, 8).trim(), 8);
    const expected = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!/^[0-7]+$/.test(sizeText) || !Number.isSafeInteger(size) || checksum !== expected || field(345, 155) || ![0, 48].includes(header[156])) throw new Error("Unsupported npm tar header");
    if (!name.startsWith("package/") || !packedPaths.includes(name.slice(8)) || files[name.slice(8)]) throw new Error(`Unexpected/duplicate npm file: ${name}`);
    offset += 512;
    if (offset + size > tar.length) throw new Error("Truncated npm tarball");
    files[name.slice(8)] = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(packedPaths)) throw new Error("Incomplete WASM npm tarball");
  return files;
}

export function validatePacked(candidate, bytes) {
  if (candidate.schema !== 1) throw new Error("Unknown WASM candidate schema");
  positive(candidate.buildRunId); positive(candidate.buildRunAttempt);
  const {plan} = candidate;
  const expected = releasePlan(plan.baseVersion, plan);
  for (const key of ["version", "distTag"]) if (plan[key] !== expected[key]) throw new Error("WASM candidate version mismatch");
  validateWasm(plan.wasm, plan);
  if (candidate.sha256 !== digest(bytes) || candidate.integrity !== integrity(bytes)) throw new Error("WASM tarball checksum mismatch");
  const files = readTarball(bytes);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, digest(data)]));
  if (JSON.stringify(Object.keys(candidate.files ?? {}).sort()) !== JSON.stringify(packedPaths)) throw new Error("Invalid packed file receipt");
  for (const path of packedPaths) if (candidate.files[path] !== hashes[path]) throw new Error(`Packed file checksum mismatch: ${path}`);
  for (const file of runtimeFiles) if (hashes[`lib/${file}`] !== plan.wasm.files[`${runtimeRoot}/${file}`]) throw new Error(`Changed release WASM bytes: ${file}`);
  if (hashes.LICENSE !== plan.wasm.files[`${runtimeRoot}/LICENSE`]) throw new Error("Changed release license");
  const manifest = JSON.parse(files["package.json"]);
  verifyManifest(manifest, plan, "wasm");
  if (manifest.private || manifest.scripts || manifest.dependencies || manifest.optionalDependencies || manifest.peerDependencies) throw new Error("WASM package must be public with no scripts or npm dependencies");
  const info = JSON.parse(files["lib/build-info.json"]);
  for (const key of ["channel", "sourceSha", "runId"]) if (info.release?.[key] !== plan[key]) throw new Error("Packed build identity mismatch");
  for (const file of runtimeFiles) if (info.wasm?.[file] !== hashes[`lib/${file}`]) throw new Error("Packed build metadata byte mismatch");
  return {manifest, files};
}

export function seal(plan, bytes, buildRunId, buildRunAttempt) {
  const files = readTarball(bytes);
  const candidate = {schema: 1, plan, buildRunId: positive(buildRunId), buildRunAttempt: positive(buildRunAttempt), sha256: digest(bytes), integrity: integrity(bytes), files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, digest(data)]))};
  validatePacked(candidate, bytes);
  return candidate;
}

export function validateBuildRun(run, repository, defaultBranch) {
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || run.path !== ".github/workflows/build-wasm-npm.yml" || run.head_branch !== defaultBranch || !["workflow_run", "workflow_dispatch"].includes(run.event)) throw new Error("Untrusted WASM npm build run");
}

export function packJobStatusAtAttempt(jobs, attempt) {
  const name = "Pack WASM npm package";
  if (successfulJobAtAttempt(jobs, attempt, name)) return "success";
  const job = jobs.find(job => String(job.run_attempt) === String(attempt) && (job.name === name || job.name.endsWith(` / ${name}`)));
  if (!job) return "missing";
  return job.status === "completed" ? "failed" : "pending";
}

export async function resolveCandidate(identity, api, current) {
  let completedPack = false;
  // The first completed candidate remains canonical on duplicate events.
  const runs = (await api.buildRuns()).filter(run => run.display_title === buildTitle(identity)).sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
  for (const build of runs) {
    // Wrong-branch manual runs must not poison lookup of a valid candidate.
    try { validateBuildRun(build, api.repository, api.defaultBranch); }
    catch { continue; }
    const matches = (await api.artifacts(build.id)).filter(item => item.name === candidateName(identity));
    if (matches.length > 1) throw new Error("Duplicate WASM npm candidate");
    if (matches.length) {
      const artifact = validateArtifact(matches[0], build, candidateName(identity));
      const candidate = await api.readCandidate(artifact);
      if (BigInt(positive(candidate.buildRunAttempt)) > BigInt(positive(build.run_attempt))) throw new Error("Future WASM candidate attempt");
      if (candidate.buildRunId !== String(build.id) || candidateName(candidate.plan) !== candidateName(identity) || candidate.plan.sourceSha !== identity.sourceSha || candidate.plan.channel !== identity.channel) throw new Error("WASM candidate origin mismatch");
      const status = await api.packJobStatus(build.id, candidate.buildRunAttempt);
      // Artifact upload completes before job cleanup. The independent publisher
      // must keep polling, while another producer must never repack these bytes.
      if (status === "pending") {
        if (current) throw new Error("Retained WASM candidate pack is still running; wait and retry without rebuilding");
        return null;
      }
      if (status !== "success") throw new Error("Retained WASM candidate pack did not succeed; refusing rebuild or publication");
      return {artifact, candidate};
    }
    for (let attempt = Number(build.run_attempt) - (String(build.id) === current?.runId ? 1 : 0); attempt >= 1; attempt--) {
      if (await api.successfulJob(build.id, attempt, "Pack WASM npm package")) completedPack = true;
    }
    if (completedPack) throw new Error("Successful WASM npm artifact missing/expired; create a new release identity, never repack this one");
  }
  return null;
}

export function wasmPublicationDecision(candidate, bytes, packument) {
  const {manifest} = validatePacked(candidate, bytes);
  const decision = publicationDecision(manifest, candidate.plan, packument);
  if (decision === "stale") throw new Error("WASM candidate would move the npm channel backwards");
  if (decision === "existing") {
    const existing = packument.versions[manifest.version];
    // This package has no legacy releases: stable and nightly both require
    // the same immutable tarball and source, not just a matching version.
    for (const key of ["channel", "sourceSha", "runId"]) if (existing.nteractRelease?.[key] !== manifest.nteractRelease[key]) throw new Error("Existing WASM source identity differs");
    if (existing.dist?.integrity !== candidate.integrity) throw new Error("Existing immutable WASM tarball differs");
  }
  return decision;
}

// npm can accept an upload before the public registry exposes the version.
// This wait only reads metadata: it never repeats the upload or weakens the
// exact source/integrity and stale-channel checks used before publication.
export const wasmVerificationRecovery = "Download the original npm-wasm-publish-input-* artifact from this publisher run, then run node <dir>/npm-wasm-release-cli.mjs verify-published <dir> against its extracted directory before retrying publication; do not rebuild or blindly republish.";

export async function waitForWasmPublication(candidate, bytes, {
  fetchPackage = registryPackage, timeoutMs = 900_000, intervalMs = 15_000,
  now = () => performance.now(), wait = sleep, onWait = message => console.error(message),
} = {}) {
  const {manifest} = validatePacked(candidate, bytes);
  const deadline = now() + timeoutMs;
  for (;;) {
    let packument;
    try {packument = await fetchPackage(manifest.name);}
    catch (error) {throw new Error(`Unable to verify WASM npm visibility: ${error.message}. ${wasmVerificationRecovery}`, {cause: error});}
    if (wasmPublicationDecision(candidate, bytes, packument) === "existing") return;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    onWait(`Waiting for npm visibility of ${manifest.name}@${manifest.version}; ${Math.ceil(remaining / 1000)}s remaining. No upload is repeated.`);
    await wait(Math.min(intervalMs, remaining));
  }
  throw new Error(`WASM npm visibility is still pending after ${timeoutMs}ms for ${manifest.name}@${manifest.version}. An accepted upload may still be processing. ${wasmVerificationRecovery}`);
}

export async function publishWasmPackage(candidate, bytes, {
  fetchPackage = registryPackage, publish, onAccepted = () => {}, visibility,
}) {
  const {manifest} = validatePacked(candidate, bytes);
  const decision = wasmPublicationDecision(candidate, bytes, await fetchPackage(manifest.name));
  if (decision === "publish") {
    await publish();
    onAccepted();
    await waitForWasmPublication(candidate, bytes, {...visibility, fetchPackage});
  }
  return decision;
}

export {digest};
