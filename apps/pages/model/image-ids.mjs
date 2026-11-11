import { markerType } from "./node-registry.mjs";
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { readKind, readDescendants } from "./native-read.mjs";

/** Each live image embed in block `blockId`: `{ id, at, index }`, its id
 * (the cursor on its embed character), offset and span index. Ids come from
 * the live embeds, never from resolving a cursor: Automerge slides a deleted
 * cursor to a surviving neighbour. */
export function imageIds(doc, blockId) {
  const path = textPath(blockId);
  return spanImageIds(doc, path, A.spans(doc, path));
}

/** imageIds for the text at `path`, from `spans` the caller already read
 * from it. */
export function spanImageIds(doc, path, spans) {
  const result = [];
  let at = 0;
  for (const [index, span] of spans.entries()) {
    if (span.type === "block" && markerType(span.value) === "image" && span.value.isEmbed)
      result.push({ id: A.getCursor(doc, path, at), at, index });
    at += span.type === "text" ? span.value.length : 1;
  }
  return result;
}

export function readableImageIds(doc, blockId, tree) {
  const result = new Map();
  const nodes = [];
  for (const root of tree.nodes) {
    if (readKind(root) === "image") nodes.push(root);
    readDescendants(root, (node) => {
      if (readKind(node) === "image") nodes.push(node);
    });
  }
  const ids = imageIds(doc, blockId);
  // Unknown-node projections can change the tree. Never guess an identity.
  if (nodes.length !== ids.length) return result;
  const byOffset = new Map(ids.map((entry) => [entry.at, entry.id]));
  for (const node of nodes) {
    const id = byOffset.get(tree.source.get(node));
    if (!id) return new Map();
    result.set(node, id);
  }
  return result;
}
