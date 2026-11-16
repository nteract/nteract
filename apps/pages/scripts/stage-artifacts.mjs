import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { VIEWER_ASSETS, VIEWER_CHUNK, digestHash, viewerAsset } from "./viewer-chunks.mjs";
import { WORKER_MODULES } from "./worker-modules.mjs";

// Keep this list aligned with build.mjs. Never archive a dev directory wholesale:
// celld dev places .dev.vars and local account/document databases beside assets.
// The viewer's hashed files come from the build receipt instead.
export const releaseArtifacts = Object.freeze([
  "index.js",
  ...WORKER_MODULES,
  "wrangler.json",
  "build-receipt.json",
  "public/index.html",
  "public/connect.js",
  "public/_headers",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function receiptOf(dist) {
  try {
    return JSON.parse(readFileSync(path.join(dist, "build-receipt.json"), "utf8"));
  } catch {
    throw new Error("Stage a complete build: build-receipt.json is unreadable");
  }
}
const certifiedMap = (value, valid) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(
    ([file, digest]) => typeof digest === "string" && SHA256.test(digest) && valid(file, digest),
  );
const sameFiles = (present, certified) =>
  JSON.stringify(present.sort()) === JSON.stringify(Object.keys(certified).sort());

/** The viewer chunks this build's receipt certifies: chunk path → sha256 of
 * its bytes at build time. public/chunks must hold exactly those chunks: a
 * missing one would break the editor, and an extra one was not certified. */
export function viewerChunksFor(dist) {
  const chunks = receiptOf(dist).viewer_chunks;
  if (!certifiedMap(chunks, (file) => VIEWER_CHUNK.test(file)))
    throw new Error("The build receipt must list the viewer chunks with their sha256");
  const directory = path.join(dist, "public/chunks");
  if (existsSync(directory) && !lstatSync(directory).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  const present = existsSync(directory)
    ? readdirSync(directory).map((name) => "public/chunks/" + name)
    : [];
  if (!sameFiles(present, chunks))
    throw new Error("public/chunks differs from the viewer chunks in the build receipt");
  return chunks;
}

/** The hashed shell assets this build's receipt certifies: path → sha256 of
 * its bytes at build time. The receipt names each of VIEWER_ASSETS once, and
 * each name's hash must come from its digest, so a name can't be paired with
 * other bytes. public/ must hold no other file of that shape. */
export function viewerAssetsFor(dist) {
  const assets = receiptOf(dist).viewer_assets;
  if (
    !certifiedMap(assets, (file, digest) => viewerAsset(file)?.hash === digestHash(digest)) ||
    JSON.stringify(
      Object.keys(assets)
        .map((file) => viewerAsset(file).name)
        .sort(),
    ) !== JSON.stringify([...VIEWER_ASSETS].sort())
  )
    throw new Error("The build receipt must list the viewer assets with their sha256");
  const present = readdirSync(path.join(dist, "public"))
    .map((name) => "public/" + name)
    .filter((file) => viewerAsset(file));
  if (!sameFiles(present, assets))
    throw new Error("public differs from the viewer assets in the build receipt");
  return assets;
}

/** Every file a release carries except build-receipt.json: the allowlisted
 * artifacts plus the viewer's hashed chunks and shell assets (dist paths). The
 * receipt's `files` certifies exactly this set. */
export function releaseFilesOf(viewerChunks, viewerAssets) {
  return [
    ...releaseArtifacts.filter((file) => file !== "build-receipt.json"),
    ...viewerChunks,
    ...viewerAssets,
  ].sort();
}

/** Every file this build's receipt certifies: dist path → sha256 of its bytes
 * at build time. The set must be exactly releaseFilesOf the receipt's viewer
 * chunks and assets, and a viewer file's digest must agree with its viewer
 * entry, so the receipt can't certify a file the release doesn't carry or
 * leave one it does carry unchecked. */
export function releaseFilesFor(
  dist,
  chunks = viewerChunksFor(dist),
  assets = viewerAssetsFor(dist),
) {
  const files = receiptOf(dist).files;
  const expected = releaseFilesOf(Object.keys(chunks), Object.keys(assets));
  if (!certifiedMap(files, () => true))
    throw new Error("The build receipt must list the release files with their sha256");
  if (!sameFiles(expected, files))
    throw new Error("The build receipt's files differ from the release allowlist");
  for (const [file, digest] of Object.entries({ ...chunks, ...assets }))
    if (files[file] !== digest) throw new Error("The build receipt lists two digests for " + file);
  return files;
}

/** The output Worker module in a build (scripts/build.mjs). Only the release
 * package carries it, so the receipt certifies it in `output_files`, apart
 * from `files`, and stageArtifacts leaves it out. */
export const OUTPUT_WORKER = "output/worker.js";
// A frame path: absolute, lowercase segments, ending in a slash.
const FRAME_PATH = /^(?:\/[a-z0-9][a-z0-9-]*)+\/$/;

/** The output Worker this build's receipt certifies, as its bytes, and the
 * frame paths it serves. The receipt must certify exactly OUTPUT_WORKER, and
 * the file must still hold the certified bytes. */
export function outputWorkerFor(dist) {
  const receipt = receiptOf(dist);
  const files = receipt.output_files;
  if (!certifiedMap(files, (file) => file === OUTPUT_WORKER) || Object.keys(files).length !== 1)
    throw new Error(`The build receipt must certify ${OUTPUT_WORKER} in output_files`);
  const paths = receipt.output_frame_paths;
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    !paths.every((value) => typeof value === "string" && FRAME_PATH.test(value)) ||
    new Set(paths).size !== paths.length
  )
    throw new Error("The build receipt must list the output Worker's frame paths");
  const file = path.join(dist, OUTPUT_WORKER);
  const statOf = (name) => (existsSync(name) ? lstatSync(name) : undefined);
  if (!statOf(path.join(dist, "output"))?.isDirectory() || !statOf(file)?.isFile())
    throw new Error("Artifact must be a regular file: " + OUTPUT_WORKER);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== files[OUTPUT_WORKER])
    throw new Error(`Release file changed since the build: ${OUTPUT_WORKER}`);
  return { bytes, framePaths: [...paths] };
}

export function stageArtifacts(dist, destination) {
  if (existsSync(destination)) throw new Error("Release destination must be new");
  if (!lstatSync(dist).isDirectory() || !lstatSync(path.join(dist, "public")).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  // Validate every input before writing anything; never dereference symlinks.
  for (const file of releaseArtifacts)
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
  const chunks = viewerChunksFor(dist);
  const assets = viewerAssetsFor(dist);
  const files = releaseFilesFor(dist, chunks, assets);
  // Read each file once, check those bytes against the receipt, and stage the
  // same bytes, so a file changed after the build is refused, not shipped.
  const kind = (file) =>
    file in chunks ? "Viewer chunk" : file in assets ? "Viewer asset" : "Release file";
  const staged = Object.entries(files).map(([file, digest]) => {
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
    const bytes = readFileSync(path.join(dist, file));
    if (sha256(bytes) !== digest) throw new Error(`${kind(file)} changed since the build: ${file}`);
    return [file, bytes];
  });
  mkdirSync(path.join(destination, "public/chunks"), { recursive: true });
  copyFileSync(path.join(dist, "build-receipt.json"), path.join(destination, "build-receipt.json"));
  for (const [file, bytes] of staged) writeFileSync(path.join(destination, file), bytes);
}
