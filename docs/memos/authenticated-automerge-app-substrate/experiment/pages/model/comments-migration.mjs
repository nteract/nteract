import * as A from "@automerge/automerge/slim";
import { RICH_FORMAT, adapter, isRich } from "./richtext.mjs";
import { COMMENTS_FEATURE } from "./comments-doc.mjs";
import { commentsMigrated } from "./comments.mjs";
import { stampFeatures, stampSpans } from "./schema-features.mjs";

/**
 * Moving a Page's comments out of the Page document.
 *
 * Pages created before the comments document kept their threads at
 * `page.comments`. The Page host moves them, once, the first time the Page
 * loads, in two journaled host changes (worker/index.mjs runs them):
 *
 * 1. `copyLegacyThreads` writes every thread into the comments document under
 *    its original ID, unchanged. A thread the comments document already holds
 *    is skipped, so a rerun after a crash copies nothing twice.
 * 2. `detachLegacyComments` removes the Page's `comments` map and stamps the
 *    `comments-doc` schema feature in the same change. The stamp makes a
 *    build that would still write `page.comments` open the Page read-only, and
 *    the host refuses that build's writes (model/schema-features.mjs).
 *
 * Page text is never touched. Only the host runs either step: it holds peer
 * writes while it migrates, so nothing lands between the copy and the detach.
 *
 * What the copy drops:
 * - a thread or message whose ID isn't 1–128 letters, digits, `-` or `_`
 *   (every ID Pages generated is a UUID, which passes);
 * - a thread whose content can't be read or written (unreadable rich text,
 *   say), counted in `skipped`;
 * - in `drop` mode, the fallback after a copy that keeps failing for good,
 *   every thread;
 * - a comment an older build wrote into its own tab that the host had not
 *   accepted before the migration. When that tab reloads and syncs, the
 *   comment lands in the detached map, where nothing reads it.
 */
export const LEGACY_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MIGRATION_MODES = Object.freeze(["copy", "drop"]);

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, fallback = "") =>
  value === undefined || value === null ? fallback : String(value);

/** The Page's legacy thread map, or an empty object. */
export function legacyThreads(page) {
  return isMap(page?.comments) ? page.comments : {};
}

/** Whether the Page still needs the move: it isn't stamped. */
export const needsCommentsMigration = (page) => !commentsMigrated(page);

function authorOf(value) {
  return {
    principal: text(value?.principal),
    displayName: text(value?.displayName, "Collaborator"),
    driver: text(value?.driver, "Browser"),
  };
}

/** A plain copy of an anchor: `{ kind, blockId }` or `{ kind, anchor, head }`. */
function anchorOf(target) {
  if (!isMap(target)) throw Error("Thread has no anchor");
  if (text(target.kind) === "block") return { kind: "block", blockId: text(target.blockId) };
  const endpoint = (value) => ({
    blockId: text(value?.blockId),
    textObjectId: text(value?.textObjectId),
    relativePositionBase64: text(value?.relativePositionBase64),
  });
  if (text(target.kind) === "selection")
    return { kind: "selection", anchor: endpoint(target.anchor), head: endpoint(target.head) };
  throw Error("Unsupported anchor");
}

function copyThread(commentsDraft, page, threadId) {
  const thread = page.comments[threadId];
  if (!isMap(thread) || !isMap(thread.messages)) throw Error("Malformed thread");
  const createdAt = text(thread.createdAt, new Date(0).toISOString());
  const messages = {};
  const rich = [];
  for (const [messageId, message] of Object.entries(thread.messages)) {
    if (!LEGACY_ID.test(messageId) || !isMap(message)) continue;
    messages[messageId] = {
      body: text(message.body),
      author: authorOf(message.author),
      createdAt: text(message.createdAt, createdAt),
      deletedAt:
        message.deletedAt === undefined || message.deletedAt === null
          ? null
          : text(message.deletedAt),
    };
    if (isRich(message)) {
      // Read before writing: a bad span fails the whole thread, not half of it.
      rich.push([
        messageId,
        A.spans(page, ["comments", threadId, "messages", messageId, "richText"]),
      ]);
    }
  }
  if (!Object.keys(messages).length) throw Error("Thread has no messages");
  commentsDraft.threads[threadId] = {
    target: anchorOf(thread.target),
    author: authorOf(thread.author),
    createdAt,
    status: {
      value: text(thread.status?.value) === "resolved" ? "resolved" : "open",
      at: text(thread.status?.at, createdAt),
    },
    messages,
  };
  for (const [messageId, spans] of rich) {
    const target = commentsDraft.threads[threadId].messages[messageId];
    target.format = RICH_FORMAT;
    target.richText = "";
    A.updateSpans(
      commentsDraft,
      ["threads", threadId, "messages", messageId, "richText"],
      spans,
      adapter.updateSpansConfig(),
    );
    stampSpans(commentsDraft, spans);
  }
}

/**
 * Step 1, inside an `A.change` on the comments document. `page` is the Page
 * document at the revision being migrated. Returns `{ copied, existing,
 * skipped }`: thread counts copied now, already present, and dropped.
 */
export function copyLegacyThreads(commentsDraft, page, { mode = "copy" } = {}) {
  if (!MIGRATION_MODES.includes(mode)) throw Error("Unknown comments migration mode");
  if (!isMap(commentsDraft.threads)) throw Error("The comments document has no thread map");
  const result = { copied: 0, existing: 0, skipped: 0 };
  for (const threadId of Object.keys(legacyThreads(page))) {
    if (Object.hasOwn(commentsDraft.threads, threadId)) {
      result.existing++;
      continue;
    }
    if (mode === "drop" || !LEGACY_ID.test(threadId)) {
      result.skipped++;
      continue;
    }
    // A thread that fails part way must leave nothing behind: copy into a
    // scratch document first, then into the draft.
    try {
      const scratch = A.change(A.from({ threads: {} }), (draft) =>
        copyThread(draft, page, threadId),
      );
      A.free(scratch);
    } catch {
      result.skipped++;
      continue;
    }
    copyThread(commentsDraft, page, threadId);
    result.copied++;
  }
  return result;
}

/** Step 2, inside an `A.change` on the Page document: drop the legacy map
 * and stamp the feature. Returns `{ detached }`, the thread count removed. */
export function detachLegacyComments(pageDraft) {
  const detached = Object.keys(legacyThreads(pageDraft)).length;
  if (Object.hasOwn(pageDraft, "comments")) delete pageDraft.comments;
  stampFeatures(pageDraft, [COMMENTS_FEATURE]);
  return { detached };
}
