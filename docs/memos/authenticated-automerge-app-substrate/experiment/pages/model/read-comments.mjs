import { selectionContext } from "./comments.mjs";
import { commentBodyProjection } from "./comment-content.mjs";

const encoder = new TextEncoder();
const fields = new Set(["state", "block_id", "thread_ids", "include_messages"]);
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400, code: "invalid_comment_selector" });
};
function validId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) return false;
  }
  return encoder.encode(value).byteLength <= 256;
}
function selectors(options) {
  if (
    !options ||
    typeof options !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    invalid("Comment selectors must be an object");
  if (Object.keys(options).some((key) => !fields.has(key)))
    invalid("Unknown comment selector; use state, block_id, thread_ids, or include_messages");
  const state = options.state ?? "all";
  if (Object.hasOwn(options, "state") && !["open", "resolved", "all"].includes(options.state))
    invalid("Comment state must be open, resolved, or all");
  if (Object.hasOwn(options, "block_id") && !validId(options.block_id))
    invalid("block_id must be a nonempty ID of at most 256 UTF-8 bytes");
  if (Object.hasOwn(options, "include_messages") && typeof options.include_messages !== "boolean")
    invalid("include_messages must be a boolean");
  if (Object.hasOwn(options, "thread_ids")) {
    const ids = options.thread_ids;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      Array.from(ids).some((id) => !validId(id)) ||
      new Set(ids).size !== ids.length
    )
      invalid("thread_ids must contain 1–100 unique IDs of at most 256 UTF-8 bytes each");
  }
  return {
    state,
    blockId: options.block_id,
    ids: options.thread_ids ? new Set(options.thread_ids) : null,
    messages: options.include_messages ?? true,
  };
}
const strings = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => typeof value?.[key] === "string").map((key) => [key, value[key]]),
  );
function blockId(thread) {
  const target = thread.target;
  const id = target?.kind === "selection" ? target.anchor?.blockId : target?.blockId;
  return typeof id === "string" ? id : null;
}
function context(doc, thread, id) {
  if (!id || !Object.hasOwn(doc.blocks ?? {}, id)) return { status: "detached" };
  if (thread.target?.kind !== "selection") return null;
  // Resolve only selected threads. These coordinates are the current projection,
  // not the durable cursor/object identities kept in the shared document.
  return selectionContext(doc, thread.target);
}
function message(id, value) {
  const base = { id, ...strings(value, ["createdAt"]) };
  // Tombstones retain their ID/timestamp so message_count and thread history are
  // explicit. Never return the stored body of a deleted message.
  if (value.deletedAt !== null && value.deletedAt !== undefined)
    return { ...base, ...strings(value, ["deletedAt"]) };
  return {
    ...base,
    ...commentBodyProjection(value),
    // Author labels are mutable document content, not verified audit identity.
    author: strings(value.author, ["principal", "displayName", "driver"]),
  };
}

/** Compact read-only threads; message_count includes body-free deleted tombstones. */
export function projectReadComments(doc, options = {}) {
  const filter = selectors(options),
    comments = doc.comments ?? {};
  if (filter.ids)
    for (const id of filter.ids)
      if (!Object.hasOwn(comments, id))
        throw Object.assign(Error(`Comment thread not found: ${id}`), {
          status: 404,
          code: "comment_not_found",
        });
  const threads = filter.ids
    ? Object.keys(comments)
        .filter((id) => filter.ids.has(id))
        .map((id) => [id, comments[id]])
    : Object.entries(comments);
  return threads
    .filter(([, thread]) => filter.state === "all" || thread.status?.value === filter.state)
    .filter(([, thread]) => filter.blockId === undefined || blockId(thread) === filter.blockId)
    .map(([id, thread]) => {
      const targetBlock = blockId(thread),
        messages = thread.messages ?? {};
      return {
        id,
        state: typeof thread.status?.value === "string" ? thread.status.value : null,
        block_id: targetBlock,
        ...strings(thread, ["createdAt"]),
        selectionContext: context(doc, thread, targetBlock),
        message_count: Object.keys(messages).length,
        ...(filter.messages
          ? {
              messages: Object.entries(messages)
                .map(([id, value]) => message(id, value))
                .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
            }
          : {}),
      };
    });
}
