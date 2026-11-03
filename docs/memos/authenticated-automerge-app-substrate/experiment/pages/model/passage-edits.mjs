import * as A from "@automerge/automerge/slim";
import {
  findUniqueVisibleRange,
  formatChanges,
  formatMatch,
  replacementOf,
  replaceMatch,
  visibleRangeAddress,
} from "./replace-match.mjs";
import { nodeChange, setNode } from "./set-node.mjs";

// Operations a target-scoped batch may contain. Each finds one literal range
// the same way; replace_match changes its text, format_match its marks and
// set_node the attributes of the node that holds it.
const PASSAGE_OPS = new Set(["replace_match", "format_match", "set_node"]);
const applyPassage = (doc, input) =>
  input.op === "format_match"
    ? formatMatch(doc, input.block_id, input)
    : input.op === "set_node"
      ? setNode(doc, input.block_id, input)
      : replaceMatch(doc, input.block_id, input);
// The same input checks each operation makes, raised before any guard work.
// A target is one captured passage, so all (every match) is page-scoped only.
function validatePassage(input) {
  if (input.all !== undefined)
    throw Error("all addresses every match, so it needs conflict_scope page");
  if (input.op === "format_match") formatChanges(input);
  else if (input.op === "set_node") nodeChange(input);
  else replacementOf(input);
}

const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400, code: "invalid_edit_selector" });
};
const samePath = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lastWidth = (text) => (/^[\udc00-\udfff]$/.test(text.at(-1)) ? 2 : 1);

function clippedMarks(doc, path, start, end) {
  return A.marks(doc, path)
    .filter((mark) => mark.start < end && mark.end > start)
    .map((mark) => ({
      name: mark.name,
      value: mark.value,
      start: Math.max(start, mark.start) - start,
      end: Math.min(end, mark.end) - start,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function markerOffsets(doc, path) {
  const result = [];
  let offset = 0;
  for (const span of A.spans(doc, path)) {
    if (span.type === "block") result.push(offset++);
    else offset += span.value.length;
  }
  return result;
}

// Diff coordinates advance with each patch. Track both the target characters
// and their containing top-level node, so structural edits elsewhere can shift
// the address without making it point at a different paragraph.
function remapTarget(target, patches, conflict) {
  let { start, end } = target;
  let nodeStart = target.address.start;
  let nodeEnd = target.address.end;
  let markers = target.markers;
  for (const patch of patches) {
    if (!samePath(patch.path.slice(0, 3), target.path)) continue;
    if (patch.action === "mark" && patch.path.length === 3) continue;
    const at = patch.path[3];
    if (!Number.isSafeInteger(at) || at < 0) conflict(target, "text_object_changed");
    if (patch.path.length > 4) {
      if (at >= nodeStart && at < nodeEnd) conflict(target, "target_structure_changed");
      continue;
    }
    let removed = 0;
    let inserted = 0;
    let structural = false;
    if (patch.action === "splice" && typeof patch.value === "string") inserted = patch.value.length;
    else if (patch.action === "del") removed = patch.length ?? 1;
    else if (patch.action === "insert" && Array.isArray(patch.values)) {
      inserted = patch.values.length;
      structural = true;
    } else conflict(target, "target_structure_changed");
    if (removed && at < end && at + removed > start) conflict(target, "target_text_changed");
    if (inserted && at > start && at < end) conflict(target, "target_text_changed");
    if (
      (structural && at > nodeStart && at < nodeEnd) ||
      (removed &&
        markers.some(
          (index) => index >= at && index < at + removed && index >= nodeStart && index <= nodeEnd,
        ))
    )
      conflict(target, "target_structure_changed");

    if (at + removed <= start) {
      start += inserted - removed;
      end += inserted - removed;
    }
    if (at + removed <= nodeStart) {
      nodeStart += inserted - removed;
      nodeEnd += inserted - removed;
    } else if (at < nodeEnd || (!structural && at === nodeEnd)) {
      nodeEnd += inserted - removed;
    }
    markers = markers
      .filter((index) => index < at || index >= at + removed)
      .map((index) => (index >= at + removed ? index + inserted - removed : index));
    if (structural) for (let index = 0; index < inserted; index++) markers.push(at + index);
  }
  return { start, end };
}

/** Prepare an explicitly target-scoped batch of replace_match, format_match and set_node
 * operations against a
 * captured current snapshot. Text identity, current formatting and structure
 * must still match the historical target. Toggled-back identical formatting is
 * accepted: this is a net-state check, not an audit of every intermediate edit.
 *
 * The caller must synchronously construct its immutable edit from this same
 * current snapshot. This does not lock native peers or reserve text while the
 * resulting CRDT intent is persisted. Receipt/journal authority stays outside
 * this helper; it must never be called to reinterpret an existing receipt.
 */
export function guardPassageEdits(current, baseHeads, operations) {
  const currentHeads = A.getHeads(current);
  if (
    !Array.isArray(baseHeads) ||
    !baseHeads.length ||
    baseHeads.length > 128 ||
    new Set(baseHeads).size !== baseHeads.length ||
    baseHeads.some((head) => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))
  )
    invalid("base_heads must contain 1 to 128 unique revision hashes from a Page read");
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 100 ||
    operations.some(
      (op) =>
        !op ||
        !PASSAGE_OPS.has(op.op) ||
        typeof op.block_id !== "string" ||
        !op.block_id ||
        op.block_id.length > 128,
    )
  )
    invalid(
      "Target-scoped edits require 1 to 100 replace_match, format_match or set_node operations with block_id",
    );
  if (!A.hasHeads(current, baseHeads))
    throw Object.assign(Error("The base revision is unavailable; read the Page again"), {
      status: 409,
      code: "resync_required",
      details: { current_heads: currentHeads },
    });
  const conflict = (target, reason) => {
    throw Object.assign(Error("The selected passage changed; read changes before editing again"), {
      status: 409,
      code: "edit_conflict",
      details: {
        current_heads: currentHeads,
        conflicts: [
          { block_id: target.input.block_id, node_index: target.address?.node_index, reason },
        ],
      },
    });
  };
  // Pin an owned backend to the historical snapshot. The pinned SDK's path
  // helpers may otherwise resolve a view's object path against latest heads.
  const ownedBase = A.clone(A.view(current, baseHeads));
  // Re-view the owned backend to rematerialize nested values too: clone(view)
  // can otherwise retain a nested object's cached latest-state reference.
  const base = A.view(ownedBase, A.getHeads(ownedBase));
  try {
    const patches = A.diff(current, baseHeads, currentHeads);
    if (patches.length > 10000) conflict({ input: operations[0] }, "change_set_too_large");
    const targets = operations.map((input) => {
      const id = input.block_id;
      let range;
      let address;
      try {
        validatePassage(input);
        range = findUniqueVisibleRange(base, id, input);
        address = visibleRangeAddress(base, id, range.start, range.end);
      } catch (error) {
        // A refusal with its own code (unsupported_markdown from
        // replacement_markdown) keeps it, as in page scope.
        if (error.status) throw error;
        invalid(error.message);
      }
      const target = {
        input,
        ...range,
        address,
        markers: markerOffsets(base, range.path),
        first: A.getCursor(base, range.path, range.start),
        last: A.getCursor(base, range.path, range.end - lastWidth(input.match_text)),
      };
      if (
        !current.blocks[id] ||
        A.getObjectId(current.blocks[id]) !== A.getObjectId(base.blocks[id]) ||
        A.getObjectId(current.blocks[id], "richText") !== A.getObjectId(base.blocks[id], "richText")
      )
        conflict(target, "text_object_changed");
      const mapped = remapTarget(target, patches, conflict);
      const start = A.getCursorPosition(current, range.path, target.first);
      const last = A.getCursorPosition(current, range.path, target.last);
      const end = last + lastWidth(input.match_text);
      if (
        start !== mapped.start ||
        end !== mapped.end ||
        A.getCursor(current, range.path, start) !== target.first ||
        A.getCursor(current, range.path, last) !== target.last ||
        current.blocks[id].richText.slice(start, end) !== input.match_text
      )
        conflict(target, "target_text_changed");
      const now = visibleRangeAddress(current, id, start, end);
      if (!equal(address.ancestry, now.ancestry)) conflict(target, "target_structure_changed");
      if (
        !equal(
          clippedMarks(base, range.path, range.start, range.end),
          clippedMarks(current, range.path, start, end),
        )
      )
        conflict(target, "target_formatting_changed");
      const effective = {
        ...input,
        ...(input.node_index === undefined ? {} : { node_index: now.node_index }),
      };
      let found;
      try {
        found = findUniqueVisibleRange(current, id, effective);
      } catch {
        conflict(target, "target_no_longer_unique");
      }
      if (found.start !== start || found.end !== end) conflict(target, "target_changed_identity");
      return { ...target, effective, currentStart: start, currentEnd: end };
    });
    // set_node changes no text, so it may share its passage with another
    // operation ("check this task and strike it"). The dry run below still
    // refuses a batch whose earlier operation retargets a later one.
    for (let i = 0; i < targets.length; i++)
      for (let j = i + 1; j < targets.length; j++)
        if (
          targets[i].input.op !== "set_node" &&
          targets[j].input.op !== "set_node" &&
          targets[i].input.block_id === targets[j].input.block_id &&
          targets[i].start < targets[j].end &&
          targets[j].start < targets[i].end
        )
          conflict(targets[j], "overlapping_batch_targets");

    // Earlier replacements can change disambiguating context for later ones.
    // Dry-run the complete batch, checking the captured character identities
    // before each operation, so an input can never silently retarget another hit.
    const clone = A.clone(current);
    let checked;
    try {
      checked = A.change(clone, (draft) => {
        for (const target of targets) {
          let range;
          try {
            range = findUniqueVisibleRange(draft, target.input.block_id, target.effective);
          } catch {
            conflict(target, "batch_changes_target_resolution");
          }
          if (
            A.getCursor(draft, target.path, range.start) !== target.first ||
            A.getCursor(draft, target.path, range.end - lastWidth(target.input.match_text)) !==
              target.last
          )
            conflict(target, "batch_changes_target_resolution");
          try {
            applyPassage(draft, target.effective);
          } catch (error) {
            // A rule the operation enforces on the text it found, such as
            // format_match refusing code text: the caller's request, not a race.
            if (error.status) throw error;
            invalid(error.message);
          }
        }
      });
    } finally {
      A.free(checked ?? clone);
    }
    return {
      operations: targets.map((target) => target.effective),
      rebased: !equal([...baseHeads].sort(), [...currentHeads].sort()),
      base_heads: [...baseHeads],
      current_heads: currentHeads,
    };
  } finally {
    A.free(ownedBase);
  }
}
