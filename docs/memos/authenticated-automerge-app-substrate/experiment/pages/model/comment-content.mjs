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
  richSize,
  schema,
  validateRich,
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

export function validateCommentContent(message) {
  if (!isRich(message)) return;
  if (richSize(message) > COMMENT_MAX_BYTES)
    throw Error("Rich comment exceeds 64 KiB content limit");
  if (message.richText.length > COMMENT_MAX_LENGTH)
    throw Error("Comment must contain 1–16000 characters");
  validateRich(message);
}

/** The native body is authoritative; body retains literal import provenance for old readers. */
export function setCommentContent(doc, path, input, nativeSpans, { literal = false } = {}) {
  const message = path.reduce((value, key) => value[key], doc);
  const body = String(input.body ?? "");
  const format = input.body_format ?? (isRich(message) ? "markdown" : "plain");
  if (!["plain", "markdown"].includes(format)) throw Error("body_format must be plain or markdown");
  if (!body.trim() || body.length > COMMENT_MAX_LENGTH)
    throw Error("Comment must contain 1–16000 characters");
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
  if (new TextEncoder().encode(JSON.stringify(spans)).length > COMMENT_MAX_BYTES)
    throw Error("Rich comment exceeds 64 KiB content limit");
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
