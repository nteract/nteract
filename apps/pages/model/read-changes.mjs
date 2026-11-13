import * as A from "@automerge/automerge/slim";
import { orderedBlockIds } from "./order.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { nodeFields } from "./read-content.mjs";
import { nodeIds } from "./node-ids.mjs";
import { readableImageIds } from "./image-ids.mjs";
import { commentMessageState, commentThreadState } from "./comment-content.mjs";
import {
  nativeRead,
  readMarkdown,
  readKind,
  readVisibleText,
  readFingerprint,
} from "./native-read.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { blockAddress } from "./addresses.mjs";
import { changeWrites } from "./block-shape.mjs";

export const CHANGE_READ_DEFAULT_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const fail = (status, code, message, details) => {
  throw Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
};
const invalid = (message) => fail(400, "invalid_change_selector", message);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    return item;
  });

function options(args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    invalid("Change arguments must be an object");
  if (
    Object.keys(args).some(
      (key) =>
        !["page_id", "since_heads", "since_comment_heads", "comments", "max_bytes"].includes(key),
    )
  )
    invalid("Unknown change argument");
  const heads = args.since_heads;
  const validHeads = (value) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 128 &&
    !Array.from(value).some((head) => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head)) &&
    new Set(value).size === value.length;
  if (!validHeads(heads)) invalid("since_heads must contain 1 to 128 unique Automerge heads");
  const commentHeads = args.since_comment_heads;
  if (commentHeads !== undefined && !validHeads(commentHeads))
    invalid("since_comment_heads must contain 1 to 128 unique Automerge heads");
  const comments = args.comments === undefined ? "summary" : args.comments;
  if (!["none", "summary", "all"].includes(comments))
    invalid("comments must be none, summary or all");
  const maxBytes = args.max_bytes === undefined ? CHANGE_READ_DEFAULT_BYTES : args.max_bytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 262144)
    invalid("max_bytes must be an integer from 4096 to 262144");
  return {
    heads: [...heads],
    commentHeads: commentHeads && [...commentHeads],
    comments,
    maxBytes,
  };
}

// A node's identity is its text object plus its node_id
// (model/node-ids.mjs), which survives text and mark changes and earlier
// insertions. Destroying a marker can produce
// delete+insert; this is a net projection, not an edit audit. A block whose
// nodes have no ids (a marker the binding can't place) returns null and is
// reported as a whole block: matching its nodes by index
// could report the wrong one.
function nativeNodes(doc, blockId, headings) {
  const block = doc.blocks[blockId],
    tree = nativeRead(block, doc.page_id),
    objectId = A.getObjectId(block, "richText"),
    entries = [];
  let ids;
  try {
    ids = nodeIds(doc, blockId, tree);
  } catch {
    return null;
  }
  const imageIds = readableImageIds(doc, blockId, tree);
  tree.nodes.forEach((node, nodeIndex) => {
    if (readKind(node) === "heading") {
      while (headings.length && headings.at(-1).level >= node.tag.param) headings.pop();
      headings.push({
        level: node.tag.param,
        text: readVisibleText(node),
      });
    }
    const nodeId = ids[nodeIndex].id;
    entries.push({
      // A paragraph of unmarked text has no id; its index stands in.
      key: `${objectId}:${nodeId ?? `unmarked:${nodeIndex}`}`,
      node_id: nodeId,
      type: readKind(node),
      heading_path: headings.map((heading) => heading.text),
      markdown: readMarkdown([node]),
      fields: nodeFields(node, { pageId: doc.page_id, imageIds, metadata: tree.metadata }),
      fingerprint: canonical(readFingerprint(node, tree.metadata)),
    });
  });
  // Never match ambiguous marker identities by an index that can have shifted.
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw Error("Native node identities are ambiguous");
  return entries;
}

function index(doc) {
  const headings = [],
    blocks = new Map();
  for (const id of orderedBlockIds(doc)) {
    const block = doc.blocks[id];
    const nodes = nativeNodes(doc, id, headings);
    blocks.set(id, { block, address: blockAddress(doc, id), pageId: doc.page_id, nodes });
    // A block without node ids can contain headings, but has no native
    // identity. Do not invent a heading path across that boundary.
    if (!nodes) headings.length = 0;
  }
  return blocks;
}
/** A changed node's address: its id (a deleted node's id, so a caller can
 * drop what it held under it), its block's id, and its type. A live node
 * carries its heading path. A deleted node gets only its old address, never
 * its historical text or path.
 *
 * `before` is where the entry sits: the id of the next node that has one
 * (nextId), at the baseline for a deleted node and at this revision for an
 * inserted or moved one, null when no node with an id follows. Two entries
 * that have ids never name the same successor, so a caller rebuilds the
 * order of the block's nodes that have ids from its baseline and these. A
 * paragraph of unmarked text has no id to track: the feed doesn't place it
 * among the others, and a caller reaches it through its block. */
function address(block, entry, change, { before } = {}) {
  return {
    node_id: entry.node_id,
    block,
    scope: "node",
    change,
    type: entry.type,
    ...(change !== "deleted" && { heading_path: entry.heading_path }),
    ...(before !== undefined && { before_node_id: before }),
  };
}
/** The id of the first node after `index` in `entries` that has one, or
 * null. */
const nextId = (entries, index) =>
  entries.slice(index + 1).find((entry) => entry.node_id !== null)?.node_id ?? null;

function nodeChanges(block, before, after) {
  const previous = new Map(before.map((entry) => [entry.key, entry])),
    current = new Map(after.map((entry) => [entry.key, entry])),
    oldOrder = new Map(
      before.filter((entry) => current.has(entry.key)).map((entry, index) => [entry.key, index]),
    ),
    newOrder = new Map(
      after.filter((entry) => previous.has(entry.key)).map((entry, index) => [entry.key, index]),
    ),
    changes = [];
  for (const [index, entry] of before.entries())
    if (!current.has(entry.key))
      changes.push(address(block, entry, "deleted", { before: nextId(before, index) }));
  for (const [index, entry] of after.entries()) {
    const prior = previous.get(entry.key),
      moved = prior && oldOrder.get(entry.key) !== newOrder.get(entry.key);
    if (!prior || prior.fingerprint !== entry.fingerprint || moved)
      changes.push({
        ...address(
          block,
          entry,
          !prior ? "inserted" : prior.fingerprint !== entry.fingerprint ? "updated" : "moved",
          !prior || moved ? { before: nextId(after, index) } : {},
        ),
        markdown: entry.markdown,
        ...entry.fields,
        ...(moved && prior.fingerprint !== entry.fingerprint ? { moved: true } : {}),
      });
  }
  return changes;
}

function contentChanges(before, after, writtenBy) {
  const previous = index(before),
    current = index(after),
    changes = [];
  // Each change names the writers of its block (attribution below).
  const push = (id, ...entries) => {
    const by = writtenBy?.(id);
    changes.push(...(by ? entries.map((entry) => ({ ...entry, written_by: by })) : entries));
  };
  // An inserted or moved block's place: the id of the block after it at this
  // revision, null when it is last.
  const order = [...current.values()].map((entry) => entry.address);
  const placed = (entry) => ({ before_node_id: order[order.indexOf(entry.address) + 1] ?? null });
  // A block is named by its id; a deleted one by the id it had at the
  // baseline, which is the id it always had.
  for (const [id, prior] of previous)
    if (!current.has(id)) push(id, { node_id: prior.address, scope: "block", change: "deleted" });
  for (const [id, entry] of current) {
    const prior = previous.get(id);
    if (!prior) {
      push(id, {
        node_id: entry.address,
        scope: "block",
        change: "inserted",
        ...placed(entry),
        ...(entry.nodes ? {} : { markdown: blockMarkdown(entry.block, entry.pageId) }),
      });
      if (entry.nodes) push(id, ...nodeChanges(entry.address, [], entry.nodes));
      continue;
    }
    if (String(prior.block.position ?? "") !== String(entry.block.position ?? ""))
      push(id, { node_id: entry.address, scope: "block", change: "moved", ...placed(entry) });
    if (prior.nodes && entry.nodes)
      push(id, ...nodeChanges(entry.address, prior.nodes, entry.nodes));
    else if (blockMarkdown(prior.block, prior.pageId) !== blockMarkdown(entry.block, entry.pageId))
      push(id, {
        node_id: entry.address,
        scope: "block",
        change: "updated",
        markdown: blockMarkdown(entry.block, entry.pageId),
      });
  }
  return changes;
}

/** Thread changes between two thread maps. `project(id, messages)` reads the
 * current projection of one thread. */
function commentChanges(prior, current, mode, project) {
  if (mode === "none") return [];
  const changes = [];
  for (const id of Object.keys(prior))
    if (!Object.hasOwn(current, id)) changes.push({ thread_id: id, change: "deleted" });
  for (const id of Object.keys(current)) {
    if (
      Object.hasOwn(prior, id) &&
      canonical(commentThreadState(prior[id])) === canonical(commentThreadState(current[id]))
    )
      continue;
    const thread = project(id, mode === "all");
    if (mode === "all" && Object.hasOwn(prior, id)) {
      // Return only new/changed *current* messages. Removed/tombstoned messages
      // never expose old body or author values from the historical view.
      thread.messages = thread.messages.filter(
        (message) =>
          !Object.hasOwn(prior[id].messages ?? {}, message.id) ||
          canonical(commentMessageState(prior[id].messages[message.id])) !==
            canonical(commentMessageState(current[id].messages[message.id])),
      );
      thread.removed_message_ids = Object.keys(prior[id].messages ?? {}).filter(
        (key) => !Object.hasOwn(current[id].messages ?? {}, key),
      );
    }
    changes.push({
      thread_id: id,
      change: Object.hasOwn(prior, id) ? "updated" : "inserted",
      ...thread,
    });
  }
  return changes;
}

/** An owned historical view of `doc` at `heads`, or null when it can't be
 * opened. Free `owned` when done. */
function historical(doc, heads) {
  let owned;
  try {
    // In the pinned SDK, rich-text paths and getObjectId(prop) resolve map fields
    // against the underlying handle before applying a view's heads. An owned fork
    // at the baseline also handles deleted/replaced objects correctly. Never free
    // the shared A.view itself; only this separate clone belongs to the projector.
    owned = A.clone(A.view(doc, heads));
    // clone applies patches onto the supplied view and can retain its nested
    // objects' original-handle metadata. Rematerialize against the owned fork.
    return { owned, view: A.view(owned, A.getHeads(owned)) };
  } catch {
    if (owned) A.free(owned);
    return null;
  }
}

const sameHeads = (a, b) => canonical([...a].sort()) === canonical([...b].sort());

/** Comment changes from the comments document since `since`, its own heads.
 * Comments have their own history, so Page heads can't serve as their
 * baseline. Without `since` the delta is unknown: the result is a snapshot of
 * every current thread with `comments_snapshot: true`. */
function commentsDocChanges(page, commentsDoc, since, mode) {
  if (mode === "none") return { comments: [] };
  // No comments baseline: a client from before the comments document, or one
  // that never kept comment_revision. Every current thread, flagged as a
  // snapshot, so it keeps seeing comments and can tell it must replace what
  // it holds rather than merge a delta. Deleted threads can't be listed.
  if (!since)
    return {
      comments: projectReadComments(
        page,
        { state: "all", include_messages: mode === "all" },
        commentsDoc,
      ).map((thread) => ({ thread_id: thread.id, change: "snapshot", ...thread })),
      comments_snapshot: true,
    };
  if (!A.hasHeads(commentsDoc, since))
    fail(
      409,
      "resync_required",
      "The comments baseline is unavailable. Read the Page or list_page_comments to establish a new comment_revision baseline.",
    );
  if (sameHeads(since, A.getHeads(commentsDoc))) return { comments: [] };
  const before = historical(commentsDoc, since);
  if (!before)
    fail(
      409,
      "resync_required",
      "The comments baseline cannot be opened. Read the Page or list_page_comments to establish a new comment_revision baseline.",
    );
  try {
    const project = (id, messages) =>
      projectReadComments(page, { thread_ids: [id], include_messages: messages }, commentsDoc)[0];
    return {
      comments: commentChanges(before.view.threads ?? {}, commentsDoc.threads ?? {}, mode, project),
    };
  } catch (error) {
    if (error.code === "resync_required") throw error;
    fail(
      409,
      "resync_required",
      'Comment changes cannot be projected from this baseline. Retry with comments: "none" for content-only changes, then read current comments. No partial delta was returned.',
    );
  } finally {
    A.free(before.owned);
  }
}

/** The actors of the Page changes after `since`, for the host to resolve
 * into writers before projecting (projectReadChanges' `writerOf`). Empty when
 * `since` isn't in the document's history. */
export function changeActors(doc, since) {
  if (!A.hasHeads(doc, since)) return [];
  return [...new Set(A.getChangesSince(doc, since).map((bytes) => A.decodeChange(bytes).actor))];
}

const UNRECORDED = Object.freeze({ recorded: false });

/**
 * Who wrote what since `since`, at block granularity. `writerOf(actor)` is
 * the host's answer for one actor: a writer, or null when none is recorded
 * (worker/host-writers.mjs). Returns `writers`, the distinct writers in the
 * order first seen, with `{ recorded: false }` standing for every change that
 * has none, and `writtenBy(blockId)` and `title`, the sorted indexes into
 * `writers` of the changes that wrote that block or the title.
 *
 * A block's writers are the authors of every change since the baseline that
 * wrote anything in it, so a node change names everyone who wrote its block,
 * not only its node.
 */
function attribution(doc, since, writerOf) {
  const backend = A.getBackend(doc),
    paths = new Map(),
    writers = [],
    keys = new Map(),
    blocks = new Map(),
    title = new Set();
  const indexOf = (actor) => {
    const writer = writerOf(actor) ?? UNRECORDED;
    const key = canonical(writer);
    if (!keys.has(key)) {
      keys.set(key, writers.length);
      writers.push(writer);
    }
    return keys.get(key);
  };
  for (const bytes of A.getChangesSince(doc, since)) {
    const change = A.decodeChange(bytes);
    const { touched, root } = changeWrites(backend, change, paths);
    if (!touched.size && !root.has("title")) continue;
    const writer = indexOf(change.actor);
    for (const id of touched) {
      if (!blocks.has(id)) blocks.set(id, new Set());
      blocks.get(id).add(writer);
    }
    if (root.has("title")) title.add(writer);
  }
  const sorted = (set) => [...(set ?? [])].sort((a, b) => a - b);
  return { writers, writtenBy: (id) => sorted(blocks.get(id)), title: sorted(title) };
}

/** Bounded net changes between one known historical view and one captured
 * current revision. No historical body export. The caller names these heads
 * as revision handles.
 *
 * With `writerOf` (see attribution), the result says who wrote each change:
 * `attribution: "block"`, a `writers` table, `written_by` on each content
 * change and `title_written_by` beside a title change. Without it,
 * `attribution: "unavailable"`.
 */
export function projectReadChanges(doc, args, commentsDoc, { writerOf } = {}) {
  const settings = options(args),
    heads = A.getHeads(doc);
  // Pinned Automerge diff tolerates unknown heads and may return root-to-tip
  // patches, so never use diff/view as a test of whether the baseline exists.
  if (!A.hasHeads(doc, settings.heads))
    fail(
      409,
      "resync_required",
      "The baseline revision is unavailable. Read the current Page or outline to establish a new baseline.",
    );
  let payload = {
    page_id: doc.page_id,
    since_heads: settings.heads,
    heads,
    title_changed: false,
    changes: [],
    comments: [],
    comments_mode: settings.comments,
    ...(commentsDoc && { comment_heads: A.getHeads(commentsDoc) }),
    attribution: writerOf ? "block" : "unavailable",
    ...(writerOf && { writers: [] }),
  };
  if (commentsDoc)
    payload = {
      ...payload,
      ...commentsDocChanges(doc, commentsDoc, settings.commentHeads, settings.comments),
    };
  // The common polling case needs no historical backend or content projection.
  if (!sameHeads(settings.heads, heads)) {
    const before = historical(doc, settings.heads);
    if (!before)
      fail(
        409,
        "resync_required",
        "The baseline revision cannot be opened. Read the current Page or outline to establish a new baseline.",
      );
    try {
      let changes, written;
      try {
        written = writerOf && attribution(doc, settings.heads, writerOf);
        changes = contentChanges(before.view, doc, written?.writtenBy);
      } catch {
        fail(
          409,
          "resync_required",
          "Content changes cannot be projected from this baseline. Read the current Page or outline to establish a new baseline. No partial delta was returned.",
        );
      }
      const titleChanged = before.view.title !== doc.title;
      payload = {
        ...payload,
        title_changed: titleChanged,
        ...(titleChanged ? { title: doc.title } : {}),
        ...(titleChanged && written && { title_written_by: written.title }),
        changes,
        ...(written && { writers: written.writers }),
      };
    } finally {
      A.free(before.owned);
    }
  }
  const size = encoder.encode(JSON.stringify(payload)).byteLength;
  if (size > settings.maxBytes)
    fail(
      413,
      "changes_budget_exceeded",
      "Changes exceed max_bytes. Read the current outline and targeted passages to establish a new baseline; no partial change feed was returned.",
      {
        max_bytes: settings.maxBytes,
        required_bytes: size,
        counts: { changes: payload.changes.length, comments: payload.comments.length },
      },
    );
  return payload;
}
