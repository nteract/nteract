import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Wordgard 0.6.2 maps changed point shapes from new positions back to the
// previous document. Its offset is old length minus new length, so add it.
// The published JS has no sourceMappingURL; this same-width edit shifts no
// source positions. Remove this patch when upgrading to a fixed release.
export function patchWordgard(root) {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  if (pkg.name !== "wordgard" || pkg.version !== "0.6.2")
    throw new Error("Unexpected Wordgard package version");
  const path = `${root}/dist/editor.js`;
  const source = readFileSync(path, "utf8");
  if (
    createHash("sha256").update(source).digest("hex") !==
    "c3491a5e44c1187cff95cd1c4c3cb80d3f1061cb716b9352eca3a389c2995d9f"
  )
    throw new Error("Unexpected Wordgard editor source hash");
  const before = "        let posA = posB - off;\n        if (scan.pos < posA)";
  if (source.split(before).length !== 2) throw new Error("Wordgard position patch mismatch");
  writeFileSync(path, source.replace(before, before.replace("posB - off", "posB + off")));
}
