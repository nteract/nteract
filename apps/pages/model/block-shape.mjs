import * as A from "@automerge/automerge/slim";
import { generateKeyBetween } from "fractional-indexing";

// The shape of a stored Page block: exactly `{ position, richText }`, with its
// id as its key in `doc.blocks`. `position` is a raw-string fractional index
// and `richText` is an Automerge text object. Registration checks every block
// of a draft (worker/registration.mjs); plain sync admission checks the blocks
// a peer's changes touch (blockChangeRefusal). The spans inside `richText`
// are checked elsewhere.

export const BLOCK_KEYS = Object.freeze(["position", "richText"]);
export const MAX_POSITION_LENGTH = 512;
/** The refusal code for a change that leaves a block out of shape. */
export const INVALID_BLOCK = "invalid_block";

/** An Automerge map, not a list, text, or scalar. */
const isMap = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !A.isRawString(value) &&
  !!A.getObjectId(value);

function validPosition(position) {
  if (!A.isRawString(position)) return false;
  const key = String(position);
  if (key.length > MAX_POSITION_LENGTH) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** A raw-string fractional `position` of at most 512 characters and a text
 * `richText`. Says nothing about other keys. */
export const validBlockFields = (block) =>
  validPosition(block.position) && typeof block.richText === "string";

const refusal = (message, block) => ({
  code: INVALID_BLOCK,
  message,
  ...(block !== undefined && { block }),
});

/**
 * The block shape after a peer's changes, judged on the blocks those changes
 * touched. `before` is the admitted document and `after` is it with the
 * changes applied. Returns null, or `{ code, message, block? }`.
 *
 * The touched blocks come from `A.diff` between the two documents' heads, so
 * the cost follows the size of the change, not the number of blocks. A change
 * whose effect is hidden by a concurrent one (an edit in a block another peer
 * deleted, a move that loses to a concurrent move) leaves no patch and needs
 * no check.
 *
 * Every touched block that still exists must be a map with a valid `position`
 * and a text `richText`. The changes may not add a key other than those two;
 * a key the same block already held before them is tolerated, so blocks that
 * carry the earlier format's extra keys stay editable. A block replaced by a
 * new map tolerates none. Deleting a block is allowed.
 */
export function blockChangeRefusal(before, after) {
  const touched = new Set();
  let blocksTouched = false;
  for (const { path } of A.diff(after, A.getHeads(before), A.getHeads(after))) {
    if (path[0] !== "blocks") continue;
    if (path.length === 1) blocksTouched = true;
    else touched.add(String(path[1]));
  }
  if (!blocksTouched && !touched.size) return null;
  if (!isMap(after.blocks)) return refusal("A Page's blocks must be a map");
  const earlier = isMap(before.blocks) ? before.blocks : undefined;
  for (const id of touched) {
    const block = after.blocks[id];
    if (block === undefined) continue;
    if (!isMap(block)) return refusal("A block must be a map", id);
    const previous = earlier?.[id];
    const kept =
      isMap(previous) && A.getObjectId(previous) === A.getObjectId(block)
        ? new Set(Object.keys(previous))
        : new Set();
    for (const key of Object.keys(block))
      if (!BLOCK_KEYS.includes(key) && !kept.has(key))
        return refusal(`A block holds only position and richText, not ${key}`, id);
    if (!validPosition(block.position))
      return refusal(
        `A block's position must be a raw-string fractional index of at most ${MAX_POSITION_LENGTH} characters`,
        id,
      );
    if (typeof block.richText !== "string") return refusal("A block's richText must be text", id);
  }
  return null;
}
