import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Three fixes to Wordgard 0.7.0's dist/editor.js, applied to the pinned source
// only. Remove each when upgrading to a release that has it.
//
// - setUneditable marks a rendered widget's DOM contenteditable="false"
//   unless it is a void element (br, hr, img, input, wbr). Its tag test is
//   inverted, so every other widget stays editable: a click inside one, such
//   as a rendered diagram, places a text caret there instead of focusing it.
// - posAtCoords walks the drawn tiles, which describe the flushed state, then
//   maps the result through the pending transactions. It passes the current
//   state to the walk instead. Between a dispatched document change and the
//   next flush (a remote edit landing mid-gesture), a textblock lookup then
//   reads the new document at an old position and throws on a null node.
// - When an update changes a node's content but keeps its shape, the content
//   update copies the shape's tiles with copyEltStructure. It keeps each inner
//   child without content (a widget beside the content hole) as the same tile,
//   but doesn't mark it reused, so the update then disconnects a widget that
//   stays drawn and never connects it again. A Mermaid diagram stops at
//   "Rendering diagram…" when a peer's selection moves inside its source.
//
// The published JS has no sourceMappingURL, and each edit stays on its own
// line, so no other source line moves.
export const WORDGARD_PATCHES = Object.freeze([
  [
    '    if (cur != "inherit" || !/^(br|hr|img|input|wbr)$/i.test(dom.nodeName))',
    "|| !/^(br",
    "|| /^(br",
  ],
  [
    "        let result = tile.posAtCoords(this.state, coords.x, coords.y);",
    "tile.posAtCoords(this.state,",
    "tile.posAtCoords(this.flushedState,",
  ],
  [
    "                    copy.addChild((child.flags & 2048) ? this.copyEltStructure(child) : child);",
    ": child);",
    ": (this.reused.set(child, 1), child));",
  ],
]);

export function patchWordgard(root) {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  if (pkg.name !== "wordgard" || pkg.version !== "0.7.0")
    throw new Error("Unexpected Wordgard package version");
  const path = `${root}/dist/editor.js`;
  let source = readFileSync(path, "utf8");
  if (
    createHash("sha256").update(source).digest("hex") !==
    "22fa33d59899e2068fbe1107d925f6eda171e8fd988fe25e0cecb9537ef8b36f"
  )
    throw new Error("Unexpected Wordgard editor source hash");
  for (const [before, from, to] of WORDGARD_PATCHES) {
    if (source.split(before).length !== 2) throw new Error("Wordgard patch mismatch");
    source = source.replace(before, before.replace(from, to));
  }
  writeFileSync(path, source);
}
