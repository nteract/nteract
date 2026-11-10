import * as A from "@automerge/automerge/slim";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const position = (block) => {
  const value = block?.position;
  return A.isRawString(value) ? value.toString() : typeof value === "string" ? value : "";
};

/** Match NotebookDoc's map membership and (position, stable ID) ordering.
 * Pages use the maintained JS generator's keys, not NotebookDoc's hex encoding.
 * Locale comparison is unsuitable for these case-sensitive ordering keys.
 */
export function orderedBlockIds(doc) {
  return Object.keys(doc?.blocks ?? {}).sort(
    (a, b) => compare(position(doc.blocks[a]), position(doc.blocks[b])) || compare(a, b),
  );
}

/** Allocate an atomic scalar position. Omitted anchor appends; null prepends.
 * A move excludes its existing block from the neighbors without replacing it.
 */
export function positionForInsertion(doc, afterBlockId, excludedId) {
  const ids = orderedBlockIds(doc).filter((id) => id !== excludedId);
  const index =
    afterBlockId === null
      ? 0
      : afterBlockId === undefined
        ? ids.length
        : ids.indexOf(afterBlockId) + 1;
  if (afterBlockId != null && index === 0) throw Error("Block anchor not found");
  const at = (index) =>
    index >= 0 && index < ids.length ? position(doc.blocks[ids[index]]) : null;
  const left = at(index - 1),
    right = at(index);
  if (left === null || right === null || left !== right)
    return new A.RawString(generateKeyBetween(left, right));

  // Concurrent inserts can choose the same key. IDs make their order stable,
  // but no scalar lies strictly between equal keys. Open a gap by advancing
  // only the tied items to the right of this insertion. The anchor, earlier
  // ties, and every block outside this group retain their original positions.
  let end = index;
  while (end < ids.length && at(end) === right) end++;
  const keys = generateNKeysBetween(left, at(end), end - index + 1);
  for (let i = index; i < end; i++)
    doc.blocks[ids[i]].position = new A.RawString(keys[i - index + 1]);
  return new A.RawString(keys[0]);
}
