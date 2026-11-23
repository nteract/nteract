// What an edit_page refusal adds to its answer: why it was refused and which
// operation refused it (model/edit-refusals.mjs). errorResponse (auth.mjs)
// spreads these fields into the answer it writes.
import { ADDRESS_PATTERN, MAX_ADDRESS } from "../model/address-shape.mjs";
import { refusalReason } from "../model/edit-refusals.mjs";

/** Codes whose refusal names the operation it came from. */
export const OPERATION_REFUSAL_CODES = Object.freeze([
  "invalid_edit_selector",
  "node_not_found",
  "wrong_address_kind",
  "nodes_would_join",
]);

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const token = (value) => typeof value === "string" && TOKEN.test(value);

/** The fields `error`'s answer adds, or null: `error_reason` on an
 * invalid_edit_selector refusal, and on a refusal from inside a batch its
 * `edit_index` (zero-based in `operations`), `op`, and where known `field`
 * and the operation's `node_id`. Each is a token, an index or an id-shaped
 * address of bounded length, so no message, title or matched text reaches
 * the answer through them. */
export function editRefusalFields(error) {
  if ((error?.status ?? 500) >= 500 || !OPERATION_REFUSAL_CODES.includes(error.code)) return null;
  const at = error.editAt;
  const fields = {
    ...(error.code === "invalid_edit_selector" && { error_reason: refusalReason(error) }),
    ...(Number.isSafeInteger(at?.index) &&
      at.index >= 0 && {
        edit_index: at.index,
        ...(token(at.op) && { op: at.op }),
        ...(token(at.field) && { field: at.field }),
        ...(typeof at.node_id === "string" &&
          at.node_id.length <= MAX_ADDRESS &&
          ADDRESS_PATTERN.test(at.node_id) && { node_id: at.node_id }),
      }),
  };
  return Object.keys(fields).length ? fields : null;
}
