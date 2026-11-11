import * as A from "@automerge/automerge/slim";
import { generateKeyBetween } from "fractional-indexing";

// The shape of a stored Page block: exactly `{ position, richText }`, with its
// id as its key in `doc.blocks`. `position` is a raw-string fractional index
// and `richText` is an Automerge text object. Registration checks every block
// of a draft (worker/registration.mjs) and validates the spans inside each
// `richText` (`validateRich`). Plain sync admission checks the shape of the
// blocks a peer's changes touch (blockChangeRefusal), and that a block the
// changes create opens with its first node's marker; it doesn't validate the
// spans.

export const BLOCK_KEYS = Object.freeze(["position", "richText"]);
export const MAX_POSITION_LENGTH = 512;
/** The refusal code for a change that leaves a block out of shape. */
export const INVALID_BLOCK = "invalid_block";

// fractional-indexing's default base-62 digits, after a head letter. Its
// generator checks the head, the integer length and a trailing zero, not
// every character, so a key with another character would sort out of order.
const ORDER_KEY = /^[A-Za-z][0-9A-Za-z]*$/;

/** A fractional index key of at most 512 characters that the generator orders. */
function validPositionKey(key) {
  if (key.length > MAX_POSITION_LENGTH || !ORDER_KEY.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** A raw-string fractional `position` and a text `richText`, on a
 * materialized block. Says nothing about other keys. */
export const validBlockFields = (block) =>
  A.isRawString(block.position) &&
  validPositionKey(String(block.position)) &&
  typeof block.richText === "string";

const refusal = (message, block) => ({
  code: INVALID_BLOCK,
  message,
  ...(block !== undefined && { block }),
});

const POSITION_MESSAGE = `A block's position must be a raw-string fractional index of at most ${MAX_POSITION_LENGTH} characters`;

/**
 * The block ids that `fresh` writes: a key of a blocks map, or anything
 * inside a block. An op names its object; the object's path comes from
 * `objInfo` at the document's heads, or at its own change's heads when the
 * object is hidden behind a concurrent value. Paths are looked up once per
 * object, so the cost follows the change, not the number of blocks.
 * `created` holds the id of every map the changes make: an object's id is
 * the id of the op that made it.
 */
function touchedBlocks(backend, fresh) {
  const touched = new Set();
  const created = new Set();
  const paths = new Map();
  let blocks = false;
  for (const bytes of fresh) {
    const { hash, ops, actor, startOp } = A.decodeChange(bytes);
    for (const [index, { action, obj, key }] of ops.entries()) {
      if (action === "makeMap") created.add(`${startOp + index}@${actor}`);
      if (obj === "_root") {
        if (key === "blocks") blocks = true;
        continue;
      }
      let path = paths.get(obj);
      if (path === undefined) {
        path = backend.objInfo(obj).path ?? backend.objInfo(obj, [hash]).path ?? null;
        paths.set(obj, path);
      }
      if (path?.[0] !== "blocks") continue;
      blocks = true;
      if (path.length === 1) {
        if (typeof key === "string") touched.add(key);
      } else touched.add(String(path[1]));
    }
  }
  return { blocks, touched, created };
}

/** The marker at the start of text object `text`, or null. */
function openingMarker(backend, text) {
  try {
    return backend.getBlock(text, 0);
  } catch {
    return null;
  }
}

/** The refusal for block object `obj` stored at `id`, or null. `isNew` says
 * the changes made the object. */
function blockObjectRefusal(backend, obj, id, isNew) {
  for (const key of backend.keys(obj))
    if (!BLOCK_KEYS.includes(key))
      return refusal(`A block holds only position and richText, not ${key}`, id);
  const positions = backend.getAll(obj, "position");
  if (
    !positions.length ||
    positions.some(([type, value]) => type !== "str" || !validPositionKey(value))
  )
    return refusal(POSITION_MESSAGE, id);
  const texts = backend.getAll(obj, "richText");
  if (!texts.length || texts.some(([type]) => type !== "text"))
    return refusal("A block's richText must be text", id);
  if (isNew)
    for (const [, text] of texts) {
      const marker = openingMarker(backend, text);
      if (!marker || marker.isEmbed || marker.parents?.length)
        return refusal("A new block's text must open with its first node's marker", id);
    }
  return null;
}

/**
 * The block shape after a peer's `fresh` changes, judged on the blocks they
 * write. `after` is the admitted document with the changes
 * applied. Returns null, or `{ code, message, block? }`.
 *
 * Every value is judged, not only the one a reader sees: a value that loses a
 * concurrent conflict now can become visible later, when a peer that saw only
 * the winner deletes it, and that peer's change must not be the one refused.
 * So `blocks` must hold only maps, and every value stored at a touched block
 * id must be a map whose every `position` is a raw-string fractional index and
 * whose every `richText` is text.
 *
 * A block holds no key other than those two. A block object the changes
 * make must also open its text with a top-level node's marker, as every
 * writer writes it. A block that already existed is not held to that: a
 * merge of two edits can leave text no marker opens (model/wordgard-doc.mjs
 * decode), and every reader reads it. Deleting and moving blocks are allowed.
 */
export function blockChangeRefusal(after, fresh) {
  const backend = A.getBackend(after);
  const { blocks, touched, created } = touchedBlocks(backend, fresh);
  if (!blocks) return null;
  const maps = backend.getAll("_root", "blocks");
  if (!maps.length || maps.some(([type]) => type !== "map"))
    return refusal("A Page's blocks must be a map");
  for (const id of touched)
    for (const [, blocksObj] of maps)
      for (const [type, obj] of backend.getAll(blocksObj, id)) {
        if (type !== "map") return refusal("A block must be a map", id);
        const refused = blockObjectRefusal(backend, obj, id, created.has(obj));
        if (refused) return refused;
      }
  return null;
}
