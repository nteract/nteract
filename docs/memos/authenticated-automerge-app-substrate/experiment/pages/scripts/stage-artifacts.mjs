import { copyFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

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
  "public/connect.js",
  "public/mermaid.js",
  "public/app.css",
  "public/automerge.wasm",
  "public/subduction.wasm",
  "public/_headers",
]);
export function stageArtifacts(dist, destination) {
  if (existsSync(destination)) throw new Error("Release destination must be new");
  if (!lstatSync(dist).isDirectory() || !lstatSync(path.join(dist, "public")).isDirectory())
    throw new Error("Bundle directories must not be symlinks");
  // Validate every input before writing anything; never dereference symlinks.
  for (const file of releaseArtifacts)
    if (!lstatSync(path.join(dist, file)).isFile())
      throw new Error("Artifact must be a regular file: " + file);
  mkdirSync(path.join(destination, "public"), { recursive: true });
  for (const file of releaseArtifacts)
    copyFileSync(path.join(dist, file), path.join(destination, file));
}
