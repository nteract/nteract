import { selectionContext, threadsOf, validCommentId as validId } from "./comments.mjs";
import { commentBodyProjection } from "./comment-content.mjs";
import { addressIndex, blockAddress, resolveAddressFor } from "./addresses.mjs";

const fields = new Set(["state", "node_id", "thread_ids", "include_messages"]);
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400, code: "invalid_comment_selector" });
};
function selectors(options) {
  if (
    !options ||
    typeof options !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    invalid("Comment selectors must be an object");
  if (Object.keys(options).some((key) => !fields.has(key)))
    invalid("Unknown comment selector; use state, node_id, thread_ids, or include_messages");
  const state = options.state ?? "all";
  if (Object.hasOwn(options, "state") && !["open", "resolved", "all"].includes(options.state))
    invalid("Comment state must be open, resolved, or all");
  if (Object.hasOwn(options, "node_id") && !validId(options.node_id))
    invalid("node_id must be a block's id from read_page");
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
    block: options.node_id,
    ids: options.thread_ids ? new Set(options.thread_ids) : null,
    messages: options.include_messages ?? true,
  };
}
const strings = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => typeof value?.[key] === "string").map((key) => [key, value[key]]),
  );
/** What the writing client said about itself, when the author holds it:
 * `{ name?, model? }`. Never verified identity. */
function agentLabels(agent) {
  const labels = strings(agent, ["name", "model"]);
  return Object.keys(labels).length ? { agent: labels } : {};
}
function blockId(thread) {
  const target = thread.target;
  const id = target?.kind === "selection" ? target.anchor?.blockId : target?.blockId;
  return typeof id === "string" ? id : null;
}
function context(doc, thread, id) {
  if (!id || !Object.hasOwn(doc.blocks ?? {}, id)) return { status: "detached" };
  if (thread.target?.kind !== "selection") return null;
  // Resolve only selected threads. These coordinates are the current projection,
  // not the durable cursor/object identities kept in the shared document. The
  // thread names its block, so the endpoints carry only their offsets.
  const { start, end, ...rest } = selectionContext(doc, thread.target);
  return {
    ...rest,
    ...(start && { start: { offsetUtf16: start.offsetUtf16 } }),
    ...(end && { end: { offsetUtf16: end.offsetUtf16 } }),
  };
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
    author: {
      ...strings(value.author, ["principal", "displayName", "driver"]),
      ...agentLabels(value.author?.agent),
    },
  };
}

/** The key of the block the node_id filter names. A node's or an image's id
 * is refused as the wrong kind; an id that names nothing is not a selector. */
function filterBlock(doc, address) {
  try {
    return resolveAddressFor(addressIndex(doc), doc, address, {
      op: "list_page_comments",
      field: "node_id",
      kinds: ["block"],
    }).key;
  } catch (error) {
    if (error.code === "wrong_address_kind") throw error;
    invalid("node_id doesn't name a block in this Page; read the Page again for current ids");
  }
}
/** Compact read-only threads; message_count includes body-free deleted
 * tombstones. `doc` is the Page document, which anchors resolve against;
 * threads come from `commentsDoc` (model/comments.mjs threadsOf). A thread
 * names its block by the block's id (model/addresses.mjs), null once the
 * block is gone; the comments document keeps the block's key. */
export function projectReadComments(doc, options = {}, commentsDoc) {
  const filter = selectors(options),
    comments = threadsOf(doc, commentsDoc);
  const blockKey = filter.block === undefined ? undefined : filterBlock(doc, filter.block);
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
    .filter(([, thread]) => blockKey === undefined || blockId(thread) === blockKey)
    .map(([id, thread]) => {
      const targetBlock = blockId(thread),
        messages = thread.messages ?? {};
      return {
        id,
        state: typeof thread.status?.value === "string" ? thread.status.value : null,
        node_id:
          targetBlock && Object.hasOwn(doc.blocks ?? {}, targetBlock)
            ? blockAddress(doc, targetBlock)
            : null,
        ...strings(thread, ["createdAt"]),
        selectionContext: context(doc, thread, targetBlock),
        message_count: Object.keys(messages).length,
        ...(filter.messages
          ? {
              messages: Object.entries(messages)
                .map(([id, value]) => message(id, value))
                .sort(
                  (a, b) =>
                    (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
                    a.id.localeCompare(b.id),
                ),
            }
          : {}),
      };
    });
}
