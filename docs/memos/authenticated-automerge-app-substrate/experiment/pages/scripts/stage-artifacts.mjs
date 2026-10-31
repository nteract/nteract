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

// Keep this list aligned with build.mjs. Never archive a dev directory wholesale:
// celld dev places .dev.vars and local account/document databases beside assets.
// The viewer's hashed files come from the build receipt instead.
export const releaseArtifacts = Object.freeze([
  "index.js",
  "automerge.wasm",
  "subduction.wasm",
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

export function stageArtifacts(dist, destination) {
  if (existsSync(destination)) throw new Error("Release destination must be new");
  if (!lstatSync(dist).isDirectory() || !lstatSync(path.join(dist, "public")).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  // Validate every input before writing anything; never dereference symlinks.
  for (const file of releaseArtifacts)
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
  // Read each hashed file once, check those bytes against the receipt, and
  // stage the same bytes, so a file changed after the build is refused, not
  // shipped.
  const certified = (files, kind) =>
    Object.entries(files).map(([file, digest]) => {
      if (!lstatSync(path.join(dist, file)).isFile())
        throw new Error("Artifact must be a regular file: " + file);
      const bytes = readFileSync(path.join(dist, file));
      if (sha256(bytes) !== digest)
        throw new Error(`Viewer ${kind} changed since the build: ${file}`);
      return [file, bytes];
    });
  const hashed = [
    ...certified(viewerChunksFor(dist), "chunk"),
    ...certified(viewerAssetsFor(dist), "asset"),
  ];
  mkdirSync(path.join(destination, "public/chunks"), { recursive: true });
  for (const file of releaseArtifacts)
    copyFileSync(path.join(dist, file), path.join(destination, file));
  for (const [file, bytes] of hashed) writeFileSync(path.join(destination, file), bytes);
}
