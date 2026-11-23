// Why an edit_page refusal was refused, and which operation refused it.
//
// A refusal coded invalid_edit_selector carries one reason from
// EDIT_REFUSAL_REASONS. The reason is a fixed token, so the usage log and
// the failure table can count it without keeping the message, an id, a
// title or matched text. A refusal with no reason of its own reads as
// "other".
//
// A refusal from inside a batch also names the operation it came from:
// its position in `operations`, its op, and where the throw site knows it
// the field it was about.

/** Every reason an invalid_edit_selector refusal can carry. */
export const EDIT_REFUSAL_REASONS = Object.freeze([
  // match_text (with its context and node scope) matched nothing, or the
  // occurrence named doesn't exist.
  "match_zero",
  // match_text matched more than once where one match is required, or more
  // than an operation may address.
  "match_many",
  // The match crosses a top-level node or cuts a character in two.
  "match_boundary",
  // The operation names a field it doesn't take.
  "field_unexpected",
  // A field it takes is missing, of the wrong type or out of range.
  "field_invalid",
  // set_node without match_text on a node that isn't a dataframe.
  "set_node_needs_match",
  // set_node's type or attribute doesn't apply to the node match_text is in.
  "node_type_mismatch",
  // conflict_scope target with operations other than the passage ones.
  "target_scope_ops",
  // conflict_scope target without a revision from a Page read.
  "revision_required",
  // An id that isn't an address read_page gives.
  "address_malformed",
  // replacement_markdown that isn't inline Markdown on one line.
  "inline_markdown",
  // The batch's in-place inserts read too much block text.
  "in_place_budget",
  // The batch writes formatting on too many ranges.
  "mark_budget",
  // format_match or replacement_markdown on text inside a code block.
  "code_block",
  // The batch itself: too many operations, one that isn't an object, the
  // same image set twice.
  "batch_invalid",
  // An earlier operation in the batch changed the occurrence a later one
  // names.
  "batch_overlap",
  // An op name no operation has.
  "op_unknown",
  "other",
]);

/** A refusal with `message`, for `reason` (one of EDIT_REFUSAL_REASONS).
 * `field` names the operation's field it is about, when the site knows.
 * The code is left to the caller: one with none becomes
 * invalid_edit_selector where edit_page answers. */
export const refused = (reason, message, field) =>
  Object.assign(Error(message), { editReason: reason }, field && { editField: field });

/** The reason `error` carries, or "other". Never the message. */
export const refusalReason = (error) =>
  EDIT_REFUSAL_REASONS.includes(error?.editReason) ? error.editReason : "other";

/** Name operation `op`, at `index` in its batch, as where `error` came from.
 * The first operation named is kept, so an outer catch never renames it. */
export function atOperation(error, index, op) {
  if (error && typeof error === "object" && !error.editAt)
    error.editAt = { index, op: op?.op, field: error.editField, node_id: op?.node_id };
  return error;
}

/** `target`, a refusal that replaces `source`, with the reason, field and
 * operation `source` carries. */
export const withRefusal = (target, source) =>
  Object.assign(
    target,
    source?.editReason !== undefined && { editReason: source.editReason },
    source?.editField !== undefined && { editField: source.editField },
    source?.editAt !== undefined && { editAt: source.editAt },
  );

/** The index of the first of `operations` that `check([op])` refuses on its
 * own, or -1. For a check that judges each operation by itself, in order,
 * that is the operation that refused the whole batch. */
export function refusingOperation(operations, check) {
  return operations.findIndex((op) => {
    try {
      check([op]);
      return false;
    } catch {
      return true;
    }
  });
}

/** `run()`, with any refusal it throws named as operation `op` at `index`. */
export function forOperation(index, op, run) {
  try {
    return run();
  } catch (error) {
    throw atOperation(error, index, op);
  }
}
