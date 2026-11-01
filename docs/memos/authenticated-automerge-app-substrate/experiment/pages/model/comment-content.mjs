import * as A from "@automerge/automerge/slim";
import { pmNodeToSpans, pmDocFromSpans } from "@automerge/prosemirror";
import {
  codeTextUnmarked,
  adapter,
  RICH_FORMAT,
  isRich,
  parseAgentMarkdown,
  parseMarkdown,
  exportMarkdown,
  richDoc,
  schema,
  validateRichSpans,
} from "./richtext.mjs";
import { stampSpans } from "./schema-features.mjs";

export const COMMENT_MAX_LENGTH = 16000;
export const COMMENT_MAX_BYTES = 65536;

export function commentMarkdown(message) {
  return commentBodyProjection(message).body;
}

export function commentBodyProjection(message) {
  if (!isRich(message)) return { body: String(message.body ?? "") };
  try {
    return { body: exportMarkdown(richDoc(message)), body_format: "markdown" };
  } catch {
    // Keep the rest of a Page readable without presenting frozen import text as
    // the latest native content. Never repair or overwrite shared data on read.
    return {
      body: String(message.body ?? ""),
      body_format: "plain",
      content_error: "rich_text_unavailable",
    };
  }
}

/** Comment Markdown as native spans, with the Page body's policy: an agent's
 * Markdown refuses math and HTML with `unsupported_markdown`; `literal: true`
 * (browser drafts, stored source) keeps them as text. */
export function markdownCommentSpans(source, { literal = false } = {}) {
  return pmNodeToSpans(adapter, literal ? parseMarkdown(source) : parseAgentMarkdown(source));
}

export function commentSpansMarkdown(spans) {
  return exportMarkdown(pmDocFromSpans(adapter, codeTextUnmarked(spans)));
}

const LENGTH_MESSAGE = `Comment must contain 1–${COMMENT_MAX_LENGTH} characters`;

/**
 * The one content rule for a comment message, shared by tool writes, the
 * browser and native admission (comment-authority.mjs), so none of them
 * accepts what another refuses.
 *
 * A literal body needs 1–16000 characters that aren't all whitespace. Rich
 * content is its spans: it needs non-whitespace text or at least one valid
 * embed (an image), so an image-only comment is content. Its length counts
 * each text character and each block marker, at most 16000, and its spans
 * fit in 64 KiB and pass the Page's rich-text validation.
 *
 * Throws an Error naming the problem.
 */
export function validateCommentSpans(spans) {
  if (!Array.isArray(spans)) throw Error("Rich comment content is not rich text");
  if (new TextEncoder().encode(JSON.stringify(spans)).length > COMMENT_MAX_BYTES)
    throw Error("Rich comment exceeds 64 KiB content limit");
  let length = 0,
    content = false;
  for (const span of spans) {
    if (span?.type === "text") {
      const text = String(span.value ?? "");
      length += text.length;
      if (text.trim()) content = true;
    } else if (span?.type === "block") {
      length += 1;
      if (span.value?.isEmbed === true) content = true;
    }
  }
  if (!content || length > COMMENT_MAX_LENGTH) throw Error(LENGTH_MESSAGE);
  // Embeds are checked here too: an image needs a safe URL.
  validateRichSpans(spans, COMMENT_MAX_BYTES);
}

/** The literal-body half of the rule. */
export function validateCommentBody(body) {
  const text = String(body ?? "");
  if (!text.trim() || text.length > COMMENT_MAX_LENGTH) throw Error(LENGTH_MESSAGE);
}

/** Validate a stored message's current content: its spans once it's rich,
 * its literal body otherwise. */
export function validateCommentContent(message) {
  if (!isRich(message)) return validateCommentBody(message.body);
  validateCommentSpans(A.spans(message, ["richText"]));
}

/** The native body is authoritative; body retains literal import provenance for old readers. */
export function setCommentContent(doc, path, input, nativeSpans, { literal = false } = {}) {
  const message = path.reduce((value, key) => value[key], doc);
  const body = String(input.body ?? "");
  const format = input.body_format ?? (isRich(message) ? "markdown" : "plain");
  if (!["plain", "markdown"].includes(format)) throw Error("body_format must be plain or markdown");
  // The source is what readers without rich text see; it's never blank.
  validateCommentBody(body);
  if (!nativeSpans && format === "plain" && !isRich(message)) {
    A.updateText(doc, [...path, "body"], body);
    return;
  }
  const spans =
    nativeSpans ??
    (format === "markdown"
      ? markdownCommentSpans(body, { literal })
      : pmNodeToSpans(
          adapter,
          schema.node("doc", null, [schema.node("paragraph", null, [schema.text(body)])]),
        ));
  // Check before writing, so a refused comment leaves nothing behind.
  validateCommentSpans(spans);
  if (!isRich(message)) {
    message.format = RICH_FORMAT;
    message.richText = "";
  }
  A.updateSpans(doc, [...path, "richText"], spans, adapter.updateSpansConfig());
  // Comments share the Page's mark and block registry, so they share its stamp.
  stampSpans(doc, spans);
  validateCommentContent(message);
}

// JSON values omit marks and table marker attributes; change feeds must include spans.
export function commentMessageState(message) {
  if (!isRich(message)) return { ...message };
  try {
    return { ...message, spans: A.spans(message, ["richText"]) };
  } catch {
    return { ...message, content_error: "rich_text_unavailable" };
  }
}
export function commentThreadState(thread) {
  return {
    ...thread,
    messages: Object.fromEntries(
      Object.entries(thread.messages ?? {}).map(([id, message]) => [
        id,
        commentMessageState(message),
      ]),
    ),
  };
}
