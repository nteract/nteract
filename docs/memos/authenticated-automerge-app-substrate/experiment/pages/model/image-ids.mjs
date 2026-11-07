import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { readKind, readDescendants } from "./native-read.mjs";

// Enumerate actual live embed characters. Resolving a deleted cursor by position
// alone is unsafe: Automerge deliberately slides it to a surviving neighbour.
export function imageIds(doc, blockId) {
  const path = textPath(blockId),
    result = [];
  let at = 0;
  for (const [index, span] of A.spans(doc, path).entries()) {
    if (span.type === "block" && String(span.value.type) === "image" && span.value.isEmbed)
      result.push({ image_id: A.getCursor(doc, path, at), at, index });
    at += span.type === "text" ? span.value.length : 1;
  }
  return result;
}

export function resolveImageId(doc, blockId, imageId) {
  if (typeof imageId !== "string" || !imageId || imageId.length > 192)
    throw Error("image_id must be a live image marker ID from read_page");
  const found = imageIds(doc, blockId).filter((entry) => entry.image_id === imageId);
  if (found.length !== 1)
    throw Object.assign(Error("image_id does not name a live image in this block"), {
      code: "image_not_found",
    });
  return found[0];
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
  const byOffset = new Map(ids.map((entry) => [entry.at, entry.image_id]));
  for (const node of nodes) {
    const id = byOffset.get(tree.source.get(node));
    if (!id) return new Map();
    result.set(node, id);
  }
  return result;
}
