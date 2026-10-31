import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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

/** The fixed artifacts plus the viewer chunks this build's receipt lists.
 * public/chunks must hold exactly those chunks: a missing one would break
 * the editor, and an extra one was not certified by the receipt. */
export function releaseArtifactsFor(dist) {
  let chunks;
  try {
    chunks = JSON.parse(readFileSync(path.join(dist, "build-receipt.json"), "utf8")).viewer_chunks;
  } catch {
    throw new Error("Stage a complete build: build-receipt.json is unreadable");
  }
  if (!Array.isArray(chunks) || !chunks.length || chunks.some((file) => !VIEWER_CHUNK.test(file)))
    throw new Error("The build receipt must list the viewer chunks");
  const directory = path.join(dist, "public/chunks");
  if (existsSync(directory) && !lstatSync(directory).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  const present = existsSync(directory)
    ? readdirSync(directory).map((name) => "public/chunks/" + name)
    : [];
  if (JSON.stringify(present.sort()) !== JSON.stringify([...chunks].sort()))
    throw new Error("public/chunks differs from the viewer chunks in the build receipt");
  return [...releaseArtifacts, ...chunks];
}

export function stageArtifacts(dist, destination) {
  if (existsSync(destination)) throw new Error("Release destination must be new");
  if (!lstatSync(dist).isDirectory() || !lstatSync(path.join(dist, "public")).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  // Validate every input before writing anything; never dereference symlinks.
  for (const file of releaseArtifacts)
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
  const artifacts = releaseArtifactsFor(dist);
  for (const file of artifacts)
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
  mkdirSync(path.join(destination, "public/chunks"), { recursive: true });
  for (const file of artifacts) copyFileSync(path.join(dist, file), path.join(destination, file));
}
