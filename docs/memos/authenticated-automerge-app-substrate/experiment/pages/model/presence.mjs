import * as A from "@automerge/automerge/slim";
import { selectionContext } from "./comments.mjs";
import { findUniqueVisibleRange } from "./replace-match.mjs";
import { isRich } from "./richtext.mjs";

const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const bounded = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const headsValid = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 100 &&
  value.every((head) => typeof head === "string" && /^[a-f0-9]{64}$/.test(head)) &&
  new Set(value).size === value.length;
const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code });
};
const invalid = (message) => fail(400, "invalid_presence_target", message);
const field = (block) => (isRich(block) ? "richText" : "markdown");
const quote = (text) => {
  const visible = text.replaceAll("\ufffc", "\n");
  // Slice at a Unicode code-point boundary while retaining a UTF-16 budget.
  const end = visible.length > 256 && /[\ud800-\udbff]/.test(visible[255]) ? 255 : 256;
  return visible.slice(0, end);
};
const boundary = (text, offset) =>
  Number.isSafeInteger(offset) &&
  offset >= 0 &&
  offset <= text.length &&
  !(offset > 0 && /[\ud800-\udbff]/.test(text[offset - 1]) && /[\udc00-\udfff]/.test(text[offset]));
const lastOffset = (text, end) =>
  end -
  (end > 1 && /[\udc00-\udfff]/.test(text[end - 1]) && /[\ud800-\udbff]/.test(text[end - 2])
    ? 2
    : 1);

/** Pure, server-side passage capture. These private cursors are never document
 * changes and should only be sent to authenticated readers of the same Page.
 */
export function createProgressTargets(doc, targets, expectedHeads) {
  if (targets === undefined) return [];
  if (!Array.isArray(targets) || targets.length > 3)
    invalid("targets must contain at most 3 unique passages");
  if (!targets.length) return [];
  if (!headsValid(expectedHeads))
    invalid("expected_heads from a current Page read are required for targets");
  if (JSON.stringify([...expectedHeads].sort()) !== JSON.stringify(A.getHeads(doc).sort()))
    fail(
      409,
      "presence_revision_changed",
      "Page changed; read it again before choosing a progress target",
    );
  const seen = new Set();
  return targets.map((input) => {
    if (
      !plain(input) ||
      Object.keys(input).some(
        (key) => !["block_id", "match_text", "context_before", "context_after"].includes(key),
      ) ||
      !bounded(input.block_id, 128) ||
      !bounded(input.match_text, 1024) ||
      [input.context_before, input.context_after].some(
        (context) => context !== undefined && (typeof context !== "string" || context.length > 256),
      )
    )
      invalid(
        "Each target requires block_id and match_text (1–1024 UTF-16 units), with optional context up to 256 units",
      );
    if (!Object.hasOwn(doc.blocks ?? {}, input.block_id))
      fail(404, "presence_target_not_found", "Progress target block not found");
    let range;
    try {
      range = findUniqueVisibleRange(doc, input.block_id, input);
    } catch (error) {
      invalid(error.message.replaceAll("replace_match", "Progress target"));
    }
    const { path, start, end } = range,
      id = input.block_id,
      textObjectId = A.getObjectId(doc.blocks[id], "richText"),
      key = JSON.stringify([id, textObjectId, start, end]);
    if (seen.has(key)) invalid("targets must identify distinct passages");
    seen.add(key);
    const endpoint = (offset) => ({
      blockId: id,
      textObjectId,
      relativePositionBase64: btoa(A.getCursor(doc, path, offset)),
    });
    return {
      block_id: id,
      quote: input.match_text,
      target: {
        kind: "selection",
        anchor: endpoint(start),
        head: endpoint(lastOffset(doc.blocks[id].richText, end)),
      },
    };
  });
}

/** Resolve against one captured document version. A detached quote is never
 * searched again; a replacement passage is a new target requiring a new read.
 */
export function resolveProgressTargets(doc, anchors) {
  return (anchors ?? []).slice(0, 3).map((anchor) => {
    const context = anchor?.target && selectionContext(doc, anchor.target),
      base = { block_id: anchor?.block_id, status: "detached" };
    if (context?.status !== "attached" || context.start.blockId !== anchor.block_id) return base;
    return {
      ...base,
      status: "attached",
      start_utf16: context.start.offsetUtf16,
      end_utf16: context.end.offsetUtf16,
      quote: quote(context.text),
    };
  });
}

/** Validate only the bounded selection payload. Identity and access come from
 * the authenticated native sender binding, never fields supplied by the peer.
 */
export function validatePeerSelection(value) {
  if (
    !plain(value) ||
    !bounded(value.block_id, 128) ||
    !bounded(value.start, 512) ||
    !bounded(value.end, 512) ||
    (value.backward !== undefined && typeof value.backward !== "boolean") ||
    !headsValid(value.heads)
  )
    return null;
  return {
    block_id: value.block_id,
    start: value.start,
    end: value.end,
    backward: value.backward ?? false,
    heads: [...value.heads],
  };
}

// Cursor resolution is object-specific, but a malformed cursor can still name
// a deleted character. Require a genuine endpoint in the published revision.
const validCursor = (doc, path, cursor, offset) =>
  [A.getCursor(doc, path, offset, "after"), A.getCursor(doc, path, offset, "before")].includes(
    cursor,
  );

/** Compact, revision-bound browser presence for agents. Selection is observed
 * UI state, not an assertion that the person is typing or committing an edit.
 */
export function resolvePeerSelection(doc, input) {
  const value = validatePeerSelection(input);
  if (!value) return null;
  const base = { block_id: value.block_id, status: "detached" };
  try {
    if (!A.hasHeads(doc, value.heads)) return { ...base, status: "pending" };
    const original = A.view(doc, value.heads),
      id = value.block_id;
    if (!Object.hasOwn(original.blocks ?? {}, id) || !Object.hasOwn(doc.blocks ?? {}, id))
      return base;
    const name = field(original.blocks[id]),
      path = ["blocks", id, name],
      before = original.blocks[id][name],
      current = doc.blocks[id][name];
    if (
      typeof before !== "string" ||
      typeof current !== "string" ||
      name !== field(doc.blocks[id]) ||
      A.getObjectId(original.blocks[id], name) !== A.getObjectId(doc.blocks[id], name)
    )
      return base;
    const initialStart = A.getCursorPosition(original, path, value.start),
      initialEnd = A.getCursorPosition(original, path, value.end);
    if (
      !boundary(before, initialStart) ||
      !boundary(before, initialEnd) ||
      initialStart > initialEnd ||
      !validCursor(original, path, value.start, initialStart) ||
      !validCursor(original, path, value.end, initialEnd)
    )
      return base;
    const caret = initialStart === initialEnd,
      start = A.getCursorPosition(doc, path, value.start),
      // Older publishers use opposite endpoint affinity even for a caret.
      // Typing there must not turn that collapsed selection into a range.
      end = caret ? start : A.getCursorPosition(doc, path, value.end);
    if (!boundary(current, start) || !boundary(current, end) || start > end) return base;
    if (!caret) {
      if (start === end) return base;
      const last = A.getCursor(original, path, lastOffset(before, initialEnd)),
        at = A.getCursorPosition(doc, path, last);
      if (A.getCursor(doc, path, at) !== last) return base;
    }
    return {
      ...base,
      status: "attached",
      kind: caret ? "caret" : "selection",
      start_utf16: start,
      end_utf16: end,
      caret_utf16: value.backward ? start : end,
      backward: value.backward,
      ...(caret ? {} : { quote: quote(current.slice(start, end)) }),
    };
  } catch {
    return base;
  }
}
