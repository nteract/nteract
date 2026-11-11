import * as A from "@automerge/automerge/slim";
import { parseAgentMarkdown } from "./markdown-import.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { pageSpans, validateRichSpans } from "./richtext-spans.mjs";
import { Leaf } from "wordgard/doc";
import { LineBreak, Paragraph, decode, encode, schema } from "./wordgard-doc.mjs";
import { stampSpans } from "./schema-features.mjs";
import { DATAFRAME_BLOCK } from "../shared/dataset-assets.mjs";
import {
  COMMENT_MAX_BYTES,
  COMMENT_MAX_LENGTH,
  PLAIN_FORMAT,
  commentSpansMeasure,
} from "./comment-text.mjs";

export { COMMENT_MAX_BYTES, COMMENT_MAX_LENGTH, PLAIN_FORMAT } from "./comment-text.mjs";
export {
  commentMarkdown,
  commentBodyProjection,
  commentMessageState,
  commentThreadState,
} from "./comment-read.mjs";
/** The most UTF-8 bytes of `body` source a tool write may send. The stored
 * content rule still applies to what it parses to. */
export const COMMENT_MAX_SOURCE = COMMENT_MAX_BYTES;

/** `spans` in the editor's form: what Wordgard's `encode` writes for the
 * tree they decode to, the form every Page body is in. Refuses spans the
 * editor can't hold whole, as pageSpans does. */
export function editorCommentSpans(spans) {
  const decoded = decode(spans);
  if (decoded.lossy)
    throw Object.assign(Error("This comment has content the Pages editor can't hold"), {
      code: "markdownless_node",
    });
  return encode(decoded.doc);
}

/** Spans as stored, for comparing forms: plain data with sorted keys, marks
 * always present, and adjacent text runs with the same marks joined, the
 * way Automerge reads them back. */
function storedForm(spans) {
  const sorted = (value) =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted(value[key])]),
          )
        : value;
  const out = [];
  for (const span of JSON.parse(JSON.stringify(spans))) {
    const last = out.at(-1);
    const marks = span.marks ?? {};
    if (span.type !== "text") out.push(sorted(span));
    else if (last?.type === "text" && JSON.stringify(last.marks) === JSON.stringify(sorted(marks)))
      last.value += span.value;
    else out.push({ type: "text", value: span.value, marks: sorted(marks) });
  }
  return JSON.stringify(out);
}

/** Whether `spans` are in the editor's form: exactly what `encode` writes
 * for the tree they decode to, with nothing the editor can't hold. Every
 * writer in this build stores that form, and admission refuses anything
 * else (comment-authority.mjs). Unmarked text, which only a merge leaves
 * (decode in wordgard-doc.mjs), is in the form: the comparison is with the
 * markers a writer gives it in place. */
export function isEditorForm(spans) {
  try {
    const decoded = decode(spans);
    return (
      !decoded.lossy &&
      storedForm(withMarkers(spans, decoded.unmarked)) === storedForm(encode(decoded.doc))
    );
  } catch {
    return false;
  }
}

/** `spans` with the markers decode's `unmarked` names inserted at their text
 * offsets, as markUnmarkedText (richtext-page.mjs) stores them. */
function withMarkers(spans, unmarked) {
  if (!unmarked.length) return spans;
  const out = [];
  let at = 0,
    next = 0;
  const insert = () => {
    while (next < unmarked.length && unmarked[next].at === at) {
      for (const { type, parents } of unmarked[next].markers)
        out.push({
          type: "block",
          value: {
            type: new A.ImmutableString(type),
            parents: parents.map((parent) => new A.ImmutableString(parent)),
            attrs: {},
            isEmbed: false,
          },
        });
      next++;
    }
  };
  for (const span of spans) {
    if (span.type !== "text") {
      insert();
      out.push(span);
      at++;
      continue;
    }
    let value = span.value;
    while (next < unmarked.length && unmarked[next].at < at + value.length) {
      const cut = unmarked[next].at - at;
      if (cut > 0) out.push({ ...span, value: value.slice(0, cut) });
      value = value.slice(cut);
      at += cut;
      insert();
    }
    insert();
    if (value) out.push({ ...span, value });
    at += value.length;
  }
  insert();
  return out;
}

/** Literal text as a comment's spans: one paragraph, each newline a hard
 * break, no marks. `*` stays a `*`. */
export const plainCommentSpans = (text) =>
  encode(
    schema.doc([
      Paragraph.create(
        String(text)
          .split("\n")
          .flatMap((part, i) => [...(i ? [LineBreak] : []), ...(part ? [Leaf.text(part)] : [])]),
      ),
    ]),
  );

/** An agent's Markdown as a comment's spans, through the Page body's path
 * (pageSpans): math and HTML are refused with `unsupported_markdown`. */
export const markdownCommentSpans = (source) => pageSpans(parseAgentMarkdown(source));

const LENGTH_MESSAGE = `Comment must contain 1–${COMMENT_MAX_LENGTH} characters`;

/**
 * The one content rule for a comment message, shared by tool writes, the
 * browser and native admission (comment-authority.mjs), so none of them
 * accepts what another refuses.
 *
 * A message is its spans. They need non-whitespace text or at least one
 * valid embed (an image), so an image-only comment is content. They hold at
 * most 16000 text characters; block markers don't count, so the span form
 * never changes a message's length. They fit in 64 KiB and pass the Page's
 * rich-text validation.
 *
 * Throws an Error naming the problem.
 */
const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const isLineBreak = (span) =>
  span?.type === "block" &&
  span.value?.isEmbed === true &&
  String(span.value.type) === "hard-break";

/** How many lines `spans` hold: one more than their hard breaks. */
export const commentLines = (spans) => spans.filter(isLineBreak).length + 1;

export function validateCommentSpans(spans) {
  if (!Array.isArray(spans)) throw Error("Rich comment content is not rich text");
  if (bytesOf(spans) > COMMENT_MAX_BYTES) {
    // Each line break is a block marker of its own (about 90 bytes stored),
    // so many short lines can pass the length limit and still overflow.
    if (bytesOf(spans.filter((span) => !isLineBreak(span))) <= COMMENT_MAX_BYTES)
      throw Object.assign(
        Error(
          `This comment has too many lines for one comment: ${commentLines(spans)} lines take more than 64 KiB, because each line break is stored as its own marker. Split it into replies.`,
        ),
        { code: "comment_too_many_lines" },
      );
    throw Error("Rich comment exceeds 64 KiB content limit");
  }
  for (const span of spans)
    if (span?.type === "block") {
      if (String(span.value?.type) === DATAFRAME_BLOCK)
        throw Error("Comments can't hold a dataframe");
      if (String(span.value?.type) === "image" && span.value?.attrs?.dark_src != null)
        throw Error("Comments can't hold theme image variants; use a Page image instead");
    }
  const { length, content } = commentSpansMeasure(spans);
  if (!content || length > COMMENT_MAX_LENGTH) throw Error(LENGTH_MESSAGE);
  // Embeds are checked here too: an image needs a safe URL.
  validateRichSpans(spans, COMMENT_MAX_BYTES);
}

/** The format a write without `body_format` keeps: plain for a message
 * written as plain text or not written yet, Markdown otherwise. */
const currentFormat = (message) =>
  message?.richText !== undefined && String(message.bodyFormat ?? "") !== PLAIN_FORMAT
    ? "markdown"
    : PLAIN_FORMAT;

/**
 * Write a message's content at `path`, inside the caller's change. Every
 * message is stored as rich text in the editor's form, the same spans a
 * Page body holds:
 *
 * - `nativeSpans` (the browser composer's draft) are stored as they are, in
 *   the editor's form.
 * - Otherwise `input.body` is parsed per `input.body_format`: `markdown`
 *   through the Page body's Markdown path, `plain` as literal text. Without
 *   a format, an edit keeps the message's current one, and a new message is
 *   plain.
 *
 * A plain write records `bodyFormat: "plain"` so reads return the text
 * literally; a rich write removes it. No Markdown copy (`body`) is kept.
 */
export function setCommentContent(doc, path, input, nativeSpans) {
  const message = path.reduce((value, key) => value[key], doc);
  const format = nativeSpans ? "markdown" : (input.body_format ?? currentFormat(message));
  if (!["plain", "markdown"].includes(format)) throw Error("body_format must be plain or markdown");
  let spans;
  if (nativeSpans) spans = editorCommentSpans(nativeSpans);
  else {
    const body = input.body;
    if (typeof body !== "string" || !body.trim()) throw Error(LENGTH_MESSAGE);
    if (new TextEncoder().encode(body).length > COMMENT_MAX_SOURCE)
      throw Error("Comment source exceeds 64 KiB (65,536 bytes of UTF-8)");
    spans = format === "markdown" ? markdownCommentSpans(body) : plainCommentSpans(body);
  }
  // Check before writing, so a refused comment leaves nothing behind.
  validateCommentSpans(spans);
  writeCommentSpans(doc, path, spans, { plain: format === PLAIN_FORMAT });
}

/** Store editor-form `spans` as the message at `path`, inside the caller's
 * change, keeping the message's identity: its id, author and timestamps,
 * and the unchanged characters of its text. A new message (no content yet)
 * gets its rich text here. */
export function writeCommentSpans(doc, path, spans, { plain = false } = {}) {
  const message = path.reduce((value, key) => value[key], doc);
  if (message.richText === undefined) message.richText = "";
  A.updateSpans(doc, [...path, "richText"], spans, updateSpansConfig);
  if (plain) {
    if (message.bodyFormat !== PLAIN_FORMAT) message.bodyFormat = PLAIN_FORMAT;
  } else if (message.bodyFormat !== undefined) delete message.bodyFormat;
  // Comments share the Page's mark and block registry, so they share its stamp.
  stampSpans(doc, spans);
  validateCommentSpans(A.spans(message, ["richText"]));
}
