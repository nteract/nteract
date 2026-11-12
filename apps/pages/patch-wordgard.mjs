import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Two fixes to Wordgard 0.6.2's dist/editor.js, applied to the pinned source
// only. Remove each when upgrading to a release that has it.
//
// - Changed point shapes map from new positions back to the previous
//   document. Its offset is old length minus new length, so add it.
// - posAtCoords walks the drawn tiles, which describe the flushed state, then
//   maps the result through the pending transactions. It passed the current
//   state to the walk instead. Between a dispatched document change and the
//   next flush (a remote edit landing mid-gesture), a textblock lookup then
//   read the new document at an old position and threw on a null node.
//
// The published JS has no sourceMappingURL, and both edits stay on their own
// lines, so no other source line moves.
export const WORDGARD_PATCHES = Object.freeze([
  ["        let posA = posB - off;\n        if (scan.pos < posA)", "posB - off", "posB + off"],
  [
    "        let result = tile.posAtCoords(this.state, coords.x, coords.y);",
    "tile.posAtCoords(this.state,",
    "tile.posAtCoords(this.flushedState,",
  ],
]);

export function patchWordgard(root) {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  if (pkg.name !== "wordgard" || pkg.version !== "0.6.2")
    throw new Error("Unexpected Wordgard package version");
  const path = `${root}/dist/editor.js`;
  let source = readFileSync(path, "utf8");
  if (
    createHash("sha256").update(source).digest("hex") !==
    "c3491a5e44c1187cff95cd1c4c3cb80d3f1061cb716b9352eca3a389c2995d9f"
  )
    throw new Error("Unexpected Wordgard editor source hash");
  for (const [before, from, to] of WORDGARD_PATCHES) {
    if (source.split(before).length !== 2) throw new Error("Wordgard patch mismatch");
    source = source.replace(before, before.replace(from, to));
  }
  writeFileSync(path, source);
}
