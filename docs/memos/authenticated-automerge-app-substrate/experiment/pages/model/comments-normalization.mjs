/**
 * ONE-SHOT MIGRATION. DELETE AFTER THE PRODUCTION COMMENTS MIGRATION HAS BEEN
 * APPLIED AND VERIFIED, together with worker/comments-migration.mjs, both
 * test files, scripts/comments-migration.mjs and the ONE-SHOT routes in
 * worker/index.mjs. DEPLOYMENT.md "Comments migration" lists what else goes,
 * including the readers of the old message forms this rewrites.
 *
 * A comments document's messages in the form this build writes: rich text
 * in the editor's spans (`encode(decode(spans).doc)`, model/wordgard-doc.mjs),
 * with no `body`. Earlier builds stored two other forms:
 *
 * - a plain message: a literal `body` alone (no `format`). It becomes the
 *   spans a plain write stores (plainCommentSpans) and `bodyFormat: "plain"`,
 *   so reads still return the text literally;
 * - a rich message in the ProseMirror adapter's form, with a `body` copy of
 *   the Markdown it was first written from. Its spans are rewritten to the
 *   editor's form and the copy is removed. Its reads stay Markdown.
 *
 * The rewrite goes through `A.updateSpans`, so text and markers that don't
 * change keep their identity. Every message keeps its id, author, timestamps
 * and thread. Thread anchors point into the Page document, which this never
 * writes; the plan still checks that no anchor changed. A message is refused,
 * never written, when its decode is lossy or throws, when the rewrite would
 * delete any character other than a prose newline or add text, or when the
 * result fails the comment content rule (64 KiB of spans, for one). Deleted
 * messages are rewritten too, so no old form remains for a reader.
 *
 * Pure: `planCommentsNormalization` measures on a clone and returns the
 * writes; `applyCommentsNormalization` replays them inside the host's change.
 */
import * as A from "@automerge/automerge/slim";
import { isRich } from "./richtext-format.mjs";
import { decode, encode } from "./wordgard-doc.mjs";
import { commentThreads } from "./comments-doc.mjs";
import { plainCommentText } from "./comment-text.mjs";
import {
  PLAIN_FORMAT,
  plainCommentSpans,
  validateCommentSpans,
  writeCommentSpans,
} from "./comment-content.mjs";

const count = (map, key) => {
  map[key] = (map[key] ?? 0) + 1;
};

/** Each span with its index in the text and the block type it sits in. */
function walk(spans) {
  const out = [];
  let index = 0;
  let container = null;
  for (const span of spans) {
    if (span.type === "block") {
      if (!span.value?.isEmbed) container = String(span.value?.type);
      out.push({ span, index, container });
      index += 1;
    } else {
      // A text run with no marker before it is the implicit first paragraph.
      out.push({ span, index, container: container ?? "paragraph" });
      index += span.value.length;
    }
  }
  return out;
}

/** The old span forms `spans` hold, by name. */
function formsOf(spans) {
  const forms = new Set();
  const [first, next] = spans;
  if (
    first?.type === "block" &&
    String(first.value?.type) === "paragraph" &&
    !first.value.isEmbed &&
    !first.value.parents?.length &&
    (!next || next.type === "text" || next.value?.isEmbed)
  )
    forms.add("first_marker");
  for (const { span, container } of walk(spans)) {
    if (span.type !== "text") continue;
    const code = container === "code-block";
    if (!code && span.value.includes("\n")) forms.add("prose_newline");
    if (code && Object.keys(span.marks ?? {}).length) forms.add("code_marks");
  }
  return forms;
}

/**
 * What a rewrite of the text at `path` from `before` to `after` (a
 * descendant) changed, read from the change's own operations, so every
 * character is accounted for: `text.lost` (deleted), `newlines` (deleted
 * `\n` in prose, which the editor stores as a hard break), `unexpected` (any
 * other deleted character), characters `before` and `after`, and markers
 * `removed` and `added` by type. A sound rewrite has `unexpected: 0` and
 * `after === before - newlines`.
 */
export function measureRewrite(before, after, path) {
  const parent = path.slice(0, -1).reduce((value, key) => value[key], before);
  const textId = A.getObjectId(parent, path.at(-1));
  const deleted = new Set();
  for (const change of A.getChanges(before, after))
    for (const op of A.decodeChange(change).ops)
      if (op.action === "del" && op.obj === textId && op.elemId) deleted.add(op.elemId);
  const entries = walk(A.spans(before, path));
  const entryAt = (index) => {
    let low = 0,
      high = entries.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (entries[mid].index <= index) low = mid;
      else high = mid - 1;
    }
    return entries[low];
  };
  const markers = { removed: {}, added: {} };
  const text = { before: 0, after: 0, lost: 0, newlines: 0, unexpected: 0 };
  const typesBefore = {};
  for (const { span } of entries)
    if (span.type === "block") count(typesBefore, String(span.value.type));
    else text.before += span.value.length;
  for (const elemId of deleted) {
    const index = A.getCursorPosition(before, path, elemId);
    const { span, index: start, container } = entryAt(index);
    if (span.type === "block") {
      count(markers.removed, String(span.value.type));
      continue;
    }
    text.lost++;
    if (span.value[index - start] === "\n" && container !== "code-block") text.newlines++;
    else text.unexpected++;
  }
  const typesAfter = {};
  for (const span of A.spans(after, path))
    if (span.type === "block") count(typesAfter, String(span.value.type));
    else text.after += span.value.length;
  for (const [type, n] of Object.entries(typesAfter)) {
    const added = n - ((typesBefore[type] ?? 0) - (markers.removed[type] ?? 0));
    if (added > 0) markers.added[type] = added;
  }
  return { markers, text };
}

const heads = (doc) => A.getHeads(doc).sort().join(",");
/** Stored spans compared by value. Key order differs between reads. */
const sameSpans = (a, b) => {
  const json = (spans) =>
    JSON.stringify(spans, (_key, value) => {
      if (A.isImmutableString(value)) return String(value);
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        );
      return value;
    });
  return json(a) === json(b);
};
const anchors = (doc) =>
  JSON.stringify(
    Object.entries(commentThreads(doc))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, thread]) => [id, thread?.target ?? null]),
  );

/**
 * Plan and measure the normalization of comments document `doc`. Pure; `doc`
 * is not changed.
 *
 * Returns `{ report, writes }`:
 * - `writes`: what `applyCommentsNormalization` replays, in order:
 *   `{ thread_id, message_id, spans, plain }`.
 * - `report`: `{ messages, writes, refused, refused_reasons, forms }`.
 *   `messages` lists every message that changes or is refused:
 *   `{ thread_id, message_id, action: "plain" | "normalize" | "refused",
 *   reason?, forms, markers?, text? }`. `forms` counts messages by old form:
 *   `plain_body`, `markdown_copy` (a `body` beside rich text), and the span
 *   forms `first_marker`, `quote_marker`, `prose_newline`, `code_marks` and
 *   `attrs` (any other difference, such as a default attr).
 */
export function planCommentsNormalization(doc) {
  const report = { messages: [], writes: 0, refused: 0, refused_reasons: {}, forms: {} };
  const writes = [];
  const threads = commentThreads(doc);
  let work = A.clone(doc);
  try {
    for (const threadId of Object.keys(threads).sort()) {
      const messages = threads[threadId]?.messages ?? {};
      for (const messageId of Object.keys(messages).sort()) {
        const message = messages[messageId];
        const path = ["threads", threadId, "messages", messageId];
        const entry = { thread_id: threadId, message_id: messageId };
        const refuse = (reason) => {
          report.messages.push({ ...entry, action: "refused", reason });
          report.refused++;
          count(report.refused_reasons, reason);
        };
        if (!message || typeof message !== "object") {
          refuse("not_a_message");
          continue;
        }
        const copy = message.body !== undefined;
        let spans, plain, forms;
        if (!isRich(message)) {
          if (message.format !== undefined || message.richText !== undefined) {
            refuse("unknown_format");
            continue;
          }
          const body = String(message.body ?? "");
          try {
            spans = plainCommentSpans(body);
          } catch {
            refuse("undecodable");
            continue;
          }
          // The text must read back exactly as the author wrote it.
          if (plainCommentText(spans) !== body) {
            refuse("text_changed");
            continue;
          }
          plain = true;
          forms = new Set(["plain_body"]);
        } else {
          let before;
          try {
            before = A.spans(message, ["richText"]);
            const decoded = decode(before);
            if (decoded.lossy) {
              refuse("lossy");
              continue;
            }
            spans = encode(decoded.doc);
          } catch {
            refuse("undecodable");
            continue;
          }
          plain = String(message.bodyFormat ?? "") === PLAIN_FORMAT;
          forms = sameSpans(before, spans) ? new Set() : formsOf(before);
          if (copy) forms.add("markdown_copy");
        }
        try {
          validateCommentSpans(spans);
        } catch {
          refuse("invalid_content");
          continue;
        }
        let next;
        try {
          next = A.change(A.clone(work), (draft) =>
            writeCommentSpans(draft, path, spans, { plain }),
          );
        } catch {
          refuse("invalid_content");
          continue;
        }
        // Automerge can rewrite a mark that spans adjacent runs even when the
        // spans don't change: new heads, same content. That isn't a write.
        if (
          heads(next) === heads(work) ||
          (isRich(message) &&
            !copy &&
            sameSpans(A.spans(next, [...path, "richText"]), A.spans(work, [...path, "richText"])) &&
            (message.bodyFormat === PLAIN_FORMAT) === plain)
        ) {
          A.free(next);
          continue;
        }
        let measured;
        if (isRich(message)) {
          measured = measureRewrite(work, next, [...path, "richText"]);
          if (measured.text.unexpected) {
            A.free(next);
            refuse("identity_lost");
            continue;
          }
          if (measured.text.after !== measured.text.before - measured.text.newlines) {
            A.free(next);
            refuse("text_changed");
            continue;
          }
          if (measured.markers.added.blockquote) forms.add("quote_marker");
          if (!forms.size) forms.add("attrs");
        }
        // Anchors live in the Page document; a comments rewrite never moves one.
        if (anchors(next) !== anchors(work)) {
          A.free(next);
          refuse("anchors_changed");
          continue;
        }
        for (const form of forms) count(report.forms, form);
        report.messages.push({
          ...entry,
          action: isRich(message) ? "normalize" : "plain",
          forms: [...forms].sort(),
          ...measured,
        });
        writes.push({ ...entry, spans, plain });
        A.free(work);
        work = next;
      }
    }
  } finally {
    A.free(work);
  }
  report.writes = writes.length;
  return { report, writes };
}

/** Replay `writes` from `planCommentsNormalization` inside an Automerge
 * change on the document it planned. Returns the number replayed. */
export function applyCommentsNormalization(draft, writes) {
  for (const write of writes)
    writeCommentSpans(
      draft,
      ["threads", write.thread_id, "messages", write.message_id],
      write.spans,
      { plain: write.plain },
    );
  return writes.length;
}

/** Problems with a comments document that claims to be normalized, as
 * strings; empty when nothing is left to write or refuse. */
export function commentsNormalizationProblems(report) {
  return report.messages.map((message) =>
    message.action === "refused"
      ? `${message.thread_id}/${message.message_id}: refused (${message.reason})`
      : `${message.thread_id}/${message.message_id}: ${message.action} pending`,
  );
}

/** Whether a plan must not be applied: a message is refused. The host
 * writes nothing for a blocked Page, so a run never leaves its comments half
 * normalized. */
export const commentsNormalizationBlocked = (report) => report.refused > 0;
