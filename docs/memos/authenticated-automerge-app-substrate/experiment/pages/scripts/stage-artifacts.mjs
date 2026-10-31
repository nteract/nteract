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
import { VIEWER_CHUNK } from "./viewer-chunks.mjs";

// Keep this list aligned with build.mjs. Never archive a dev directory wholesale:
// celld dev places .dev.vars and local account/document databases beside assets.
export const releaseArtifacts = Object.freeze([
  "index.js",
  "automerge.wasm",
  "subduction.wasm",
  "wrangler.json",
  "build-receipt.json",
  "public/index.html",
  "public/app.js",
  "public/theme.js",
  "public/connect.js",
  "public/mermaid.js",
  "public/app.css",
  "public/automerge.wasm",
  "public/subduction.wasm",
  "public/_headers",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The viewer chunks this build's receipt certifies: chunk path → sha256 of
 * its bytes at build time. public/chunks must hold exactly those chunks: a
 * missing one would break the editor, and an extra one was not certified. */
export function viewerChunksFor(dist) {
  let chunks;
  try {
    chunks = JSON.parse(readFileSync(path.join(dist, "build-receipt.json"), "utf8")).viewer_chunks;
  } catch {
    throw new Error("Stage a complete build: build-receipt.json is unreadable");
  }
  if (
    !chunks ||
    typeof chunks !== "object" ||
    Array.isArray(chunks) ||
    !Object.keys(chunks).length ||
    Object.entries(chunks).some(
      ([file, digest]) =>
        !VIEWER_CHUNK.test(file) || typeof digest !== "string" || !SHA256.test(digest),
    )
  )
    throw new Error("The build receipt must list the viewer chunks with their sha256");
  const directory = path.join(dist, "public/chunks");
  if (existsSync(directory) && !lstatSync(directory).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  const present = existsSync(directory)
    ? readdirSync(directory).map((name) => "public/chunks/" + name)
    : [];
  if (JSON.stringify(present.sort()) !== JSON.stringify(Object.keys(chunks).sort()))
    throw new Error("public/chunks differs from the viewer chunks in the build receipt");
  return chunks;
}

export function stageArtifacts(dist, destination) {
  if (existsSync(destination)) throw new Error("Release destination must be new");
  if (!lstatSync(dist).isDirectory() || !lstatSync(path.join(dist, "public")).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  // Validate every input before writing anything; never dereference symlinks.
  for (const file of releaseArtifacts)
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
  // Read each chunk once, check those bytes against the receipt, and stage the
  // same bytes, so a chunk changed after the build is refused, not shipped.
  const chunks = Object.entries(viewerChunksFor(dist)).map(([file, digest]) => {
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
    const bytes = readFileSync(path.join(dist, file));
    if (sha256(bytes) !== digest) throw new Error("Viewer chunk changed since the build: " + file);
    return [file, bytes];
  });
  mkdirSync(path.join(destination, "public/chunks"), { recursive: true });
  for (const file of releaseArtifacts)
    copyFileSync(path.join(dist, file), path.join(destination, file));
  for (const [file, bytes] of chunks) writeFileSync(path.join(destination, file), bytes);
}
