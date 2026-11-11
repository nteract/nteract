// Addresses: one id for anything an agent names in a Page.
//
// An address is the id of the Automerge op that made the thing,
// `<counter>@<actor hex>`:
//
// - a block: its map object, `A.getObjectId(doc.blocks[key])`
// - a top-level node: the cursor on its opening marker (node-ids.mjs)
// - an image: the cursor on its embed (image-ids.mjs)
//
// Op ids are unique across the whole document, so one id names one thing
// and its block, with no block key beside it. A character never moves
// between text objects, so a node or image stays in the block it was made
// in until it is deleted.
//
// A caller's id never reaches Automerge. getCursorPosition throws on a
// cursor from another text object, and answers with a position for a
// deleted marker without saying it is gone. Ids resolve by string
// comparison against the ids minted from the live document.
//
// A paragraph of unmarked text has no address. A block holding a node this
// build can't place has its block's address and its images', and none for
// its nodes (node-ids.mjs readableNodeIds).
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { orderedBlockIds } from "./order.mjs";
import { MAX_NODE_ID, spanNodeIds } from "./node-ids.mjs";
import { spanImageIds } from "./image-ids.mjs";
import { blockAddresses } from "./node-addresses.mjs";
import { nativeRead, readKind } from "./native-read.mjs";

export const ADDRESS_PATTERN = /^[0-9]+@[0-9a-f]+$/;
export const MAX_ADDRESS = MAX_NODE_ID;

/** The address of block `key`: the id of its map object. */
export function blockAddress(doc, key) {
  return A.getObjectId(doc.blocks[key]);
}

/** The node and image addresses in block `key`: `{ nodes, byId }`, `nodes`
 * as nodeIds gives them (none for a block with a node this build can't
 * place), and `byId` each address's entry. Never throws for content a merge
 * or a newer build left. */
function indexBlock(doc, key) {
  const path = textPath(key);
  const spans = A.spans(doc, path);
  let nodes;
  try {
    nodes = spanNodeIds(doc, path, spans);
  } catch {
    nodes = [];
  }
  const byId = new Map();
  for (const [index, { id }] of nodes.entries())
    if (id !== null) byId.set(id, { kind: "node", index });
  for (const { id, at, index } of spanImageIds(doc, path, spans))
    byId.set(id, { kind: "image", at, index });
  return { nodes, byId };
}

/** A lookup from address to the thing it names, over one captured document
 * or a draft inside `A.change`. It reads lazily: every block's address on
 * the first lookup, then each block's node and image addresses in document
 * order, once per block, only as far as the address it is looking for.
 *
 * After a write to block `key` (or one that adds, deletes or moves it)
 * inside the same change, call `forget(key)` before the next lookup. */
export function addressIndex(doc) {
  let blocks = null;
  const indexed = new Map();
  return {
    /** The key of the block `address` names, or undefined. */
    block(address) {
      if (!blocks) {
        blocks = { order: orderedBlockIds(doc), keys: new Map() };
        for (const key of blocks.order) {
          const id = blockAddress(doc, key);
          if (id) blocks.keys.set(id, key);
        }
      }
      return blocks.keys.get(address);
    },
    /** The node or image `address` names, as `{ key, entry, nodes }`, or
     * undefined. */
    find(address) {
      this.block(address);
      for (const key of blocks.order) {
        if (!indexed.has(key)) indexed.set(key, indexBlock(doc, key));
        const { byId, nodes } = indexed.get(key);
        const entry = byId.get(address);
        if (entry) return { key, entry, nodes };
      }
    },
    /** Whether block `key`'s node and image addresses are read. */
    isIndexed(key) {
      return indexed.has(key);
    },
    /** Drop what the index read from block `key`, and the block list. */
    forget(key) {
      indexed.delete(key);
      blocks = null;
    },
  };
}

/** The addresses of block `key`'s top-level nodes, in order: null for a
 * paragraph of unmarked text, and for every node of a block holding one this
 * build can't place. */
export function nodeAddresses(doc, key) {
  const path = textPath(key);
  const spans = A.spans(doc, path);
  try {
    return spanNodeIds(doc, path, spans).map(({ id }) => id);
  } catch {
    return blockAddresses(spans).nodes.map(() => null);
  }
}

const notFound = (message) => Object.assign(Error(message), { code: "node_not_found" });

/** What kind of thing `address` names in `index`'s document, and the key
 * of its block: `{ kind, key }`, without a node's range or an image's
 * offset. Throws as resolveAddress does. */
export function addressKind(index, address) {
  if (typeof address !== "string" || address.length > MAX_ADDRESS || !ADDRESS_PATTERN.test(address))
    throw Error(
      `node_id must be an id from read_page: <counter>@<actor hex>, up to ${MAX_ADDRESS} characters`,
    );
  const key = index.block(address);
  if (key !== undefined) return { kind: "block", key };
  const found = index.find(address);
  if (!found)
    throw notFound(
      "node_id doesn't name a block, node or image in this Page: it was deleted, or it is not an id read_page gave. Read the Page again for current ids. A node read_page reports with node_id null is reached through its block's id.",
    );
  return { kind: found.entry.kind, key: found.key, found };
}

/** What `address` names in `index`'s document: `{ kind: "block", key }`,
 * `{ kind: "node", key, index, start, end }` with the node's index among its
 * block's top-level nodes and its text range, from its marker to where the
 * reader ends it (the next node's start, unmarked text included), or
 * `{ kind: "image", key, at, index }` with the embed's offset and span
 * index. Throws `node_not_found` when the address names nothing live, and
 * a plain Error when it isn't an address. */
export function resolveAddress(index, address) {
  const { kind, key, found } = addressKind(index, address);
  if (kind === "block") return { kind, key };
  const { entry, nodes } = found;
  if (kind === "image") return { kind, key, at: entry.at, index: entry.index };
  const { at: start, end } = nodes[entry.index];
  return { kind, key, index: entry.index, start, end };
}

// What each kind of address is for, in a wrong_address_kind refusal.
const KIND_USES = {
  block: "delete_block, move_block and replace_block_markdown take it",
  node: "delete_node removes it",
  image: "set_image changes it",
};
const WANTED = {
  block: "a block's id: the block field of the block's first outline entry",
  node: "a node's id from the outline",
  image: "an image's id from summary.images",
};

/** What `resolved` (resolveAddress) names, as a refusal says it: "a block",
 * "an image", or the node's type with its article. */
function addressLabel(doc, resolved) {
  if (resolved.kind !== "node") return `${resolved.kind === "image" ? "an" : "a"} ${resolved.kind}`;
  let type = "node";
  try {
    type =
      readKind(nativeRead(doc.blocks[resolved.key], doc.page_id).nodes[resolved.index]) ?? type;
  } catch {
    // The label is advisory; the refusal stands without it.
  }
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

/** resolveAddress for field `field` of operation `op`, which takes the
 * address `kinds` listed. Any other kind is refused with 400
 * `wrong_address_kind`, naming what the id names and what takes it. */
export function resolveAddressFor(index, doc, address, { op, field, kinds }) {
  const resolved = resolveAddress(index, address);
  if (kinds.includes(resolved.kind)) return resolved;
  throw Object.assign(
    Error(
      `This id names ${addressLabel(doc, resolved)}; ${KIND_USES[resolved.kind]}. ${op} takes ${kinds
        .map((kind) => WANTED[kind])
        .join(", or ")} as ${field}.`,
    ),
    { status: 400, code: "wrong_address_kind" },
  );
}
