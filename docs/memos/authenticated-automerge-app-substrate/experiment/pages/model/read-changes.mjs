import * as A from "@automerge/automerge/slim";
import { eventsWithIndexChanges, traverseSpans } from "@automerge/prosemirror/dist/traversal.js";
import { orderedBlockIds } from "./order.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { commentMessageState, commentThreadState } from "./comment-content.mjs";
import {
  adapter,
  blockMarkdown,
  exportMarkdown,
  isRich,
  richDoc,
  schema,
  textPath,
} from "./richtext.mjs";

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

// Positions returned to callers are revision-bound indexes, never durable IDs.
// A native text object plus the first marker cursor provides an internal identity
// that survives text/mark changes and earlier paragraph insertions. Destroying a
// marker can produce delete+insert; this is a net projection, not an edit audit.
function nativeNodes(doc, blockId, headings) {
  const block = doc.blocks[blockId],
    path = textPath(blockId),
    spans = A.spans(doc, path),
    tree = richDoc(block),
    objectId = A.getObjectId(block, "richText"),
    entries = [];
  tree.forEach((node, offset, nodeIndex) => {
    if (node.type.name === "heading") {
      while (headings.length && headings.at(-1).level >= node.attrs.level) headings.pop();
      headings.push({
        level: node.attrs.level,
        text: node.textBetween(0, node.content.size, "", (leaf) =>
          leaf.type.name === "image"
            ? (leaf.attrs.alt ?? "")
            : leaf.type.name === "hard_break"
              ? "\n"
              : "",
        ),
      });
    }
    entries.push({
      offset,
      end: offset + node.nodeSize,
      node_index: nodeIndex,
      type: node.type.name,
      heading_path: headings.map((heading) => heading.text),
      markdown: exportMarkdown(schema.node("doc", null, [node])),
      fingerprint: canonical(node.toJSON()),
    });
  });
  // Walk the binding's indexed traversal once, rather than rescanning the full
  // span array for every paragraph. Containers use their first native marker.
  let at = 0;
  for (const state of eventsWithIndexChanges(traverseSpans(adapter, spans))) {
    while (at < entries.length && state.after.pmIdx >= entries[at].end) at++;
    const entry = entries[at];
    if (entry && state.event.type === "block" && entry.key === undefined)
      entry.key = `${objectId}:${A.getCursor(doc, path, state.after.amIdx)}`;
  }
  for (const entry of entries) entry.key ??= `${objectId}:implicit:${entry.node_index}`;
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
    blocks.set(id, {
      block,
      nodes: isRich(block) ? nativeNodes(doc, id, headings) : null,
    });
    // A preserved/legacy block can contain headings, but its source format has
    // no native identity. Do not invent a heading path across that boundary.
    if (!isRich(block)) headings.length = 0;
  }
  return blocks;
}
function metadata(block) {
  return canonical(
    Object.fromEntries(
      Object.entries(block).filter(
        ([key]) => !["id", "position", "markdown", "richText"].includes(key),
      ),
    ),
  );
}
function address(entry, previous = false) {
  return {
    [previous ? "before_node_index" : "node_index"]: entry.node_index,
    type: entry.type,
    // A deleted node gets only its old address, never its historical text/path.
    ...(!previous && { heading_path: entry.heading_path }),
  };
}
function nodeChanges(blockId, before, after) {
  const previous = new Map(before.map((entry) => [entry.key, entry])),
    current = new Map(after.map((entry) => [entry.key, entry])),
    oldOrder = new Map(
      before.filter((entry) => current.has(entry.key)).map((entry, index) => [entry.key, index]),
    ),
    newOrder = new Map(
      after.filter((entry) => previous.has(entry.key)).map((entry, index) => [entry.key, index]),
    ),
    changes = [];
  for (const entry of before)
    if (!current.has(entry.key))
      changes.push({
        block_id: blockId,
        scope: "node",
        change: "deleted",
        ...address(entry, true),
      });
  for (const entry of after) {
    const prior = previous.get(entry.key),
      moved = prior && oldOrder.get(entry.key) !== newOrder.get(entry.key);
    if (!prior || prior.fingerprint !== entry.fingerprint || moved)
      changes.push({
        block_id: blockId,
        scope: "node",
        change: !prior ? "inserted" : prior.fingerprint !== entry.fingerprint ? "updated" : "moved",
        ...address(entry),
        markdown: entry.markdown,
        ...(moved && prior.fingerprint !== entry.fingerprint ? { moved: true } : {}),
      });
  }
  return changes;
}

function contentChanges(before, after) {
  const previous = index(before),
    current = index(after),
    changes = [];
  for (const id of previous.keys())
    if (!current.has(id)) changes.push({ block_id: id, scope: "block", change: "deleted" });
  for (const [id, entry] of current) {
    const prior = previous.get(id);
    if (!prior) {
      changes.push({
        block_id: id,
        scope: "block",
        change: "inserted",
        ...(entry.nodes ? {} : { markdown: blockMarkdown(entry.block) }),
      });
      if (entry.nodes) changes.push(...nodeChanges(id, [], entry.nodes));
      continue;
    }
    if (String(prior.block.position ?? "") !== String(entry.block.position ?? ""))
      changes.push({ block_id: id, scope: "block", change: "moved" });
    const metadataChanged = metadata(prior.block) !== metadata(entry.block);
    if (prior.nodes && entry.nodes) {
      if (metadataChanged)
        changes.push({ block_id: id, scope: "block", change: "updated", metadata_changed: true });
      changes.push(...nodeChanges(id, prior.nodes, entry.nodes));
    } else if (metadataChanged || blockMarkdown(prior.block) !== blockMarkdown(entry.block))
      changes.push({
        block_id: id,
        scope: "block",
        change: "updated",
        markdown: blockMarkdown(entry.block),
        ...(metadataChanged && { metadata_changed: true }),
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
  // that never kept comment_heads. Every current thread, flagged as a
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
      "The comments baseline is unavailable. Read the Page or list_page_comments to establish a new comment_heads baseline.",
    );
  if (sameHeads(since, A.getHeads(commentsDoc))) return { comments: [] };
  const before = historical(commentsDoc, since);
  if (!before)
    fail(
      409,
      "resync_required",
      "The comments baseline cannot be opened. Read the Page or list_page_comments to establish a new comment_heads baseline.",
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

/** Bounded net changes between one known historical view and one captured
 * current revision. No actor/display-name inference or historical body export.
 * The caller checks current access and adds retry authority to these same heads.
 */
export function projectReadChanges(doc, args, commentsDoc) {
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
    attribution: "unavailable",
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
      let changes;
      try {
        changes = contentChanges(before.view, doc);
      } catch {
        fail(
          409,
          "resync_required",
          "Content changes cannot be projected from this baseline. Read the current Page or outline to establish a new baseline. No partial delta was returned.",
        );
      }
      // A Page that hasn't migrated still holds its threads; diff them here.
      let comments = payload.comments;
      if (!commentsDoc) {
        try {
          comments = commentChanges(
            before.view.comments ?? {},
            doc.comments ?? {},
            settings.comments,
            (id, messages) =>
              projectReadComments(doc, { thread_ids: [id], include_messages: messages })[0],
          );
        } catch {
          fail(
            409,
            "resync_required",
            'Comment changes cannot be projected from this baseline. Retry the same since_heads with comments: "none" for content-only changes, then read current comments; or read the current Page to establish a new baseline. No partial delta was returned.',
          );
        }
      }
      payload = {
        ...payload,
        title_changed: before.view.title !== doc.title,
        ...(before.view.title !== doc.title ? { title: doc.title } : {}),
        changes,
        comments,
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
