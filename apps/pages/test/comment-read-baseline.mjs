// Frozen READ exports from model/comment-content.mjs at
// 943115c13706ab28b6bd1ddda775e57f3acf1b65. Only import paths differ.
// This test-only oracle uses the actual PM reader, never the candidate reader.
import * as A from "@automerge/automerge/slim";
import { isRich } from "../model/richtext-format.mjs";
import { richDoc } from "../model/richtext-spans.mjs";
import { exportMarkdown } from "../model/markdown-serializer.mjs";
import { STORED_FORM_UNSUPPORTED } from "../model/stored-form.mjs";
import { PLAIN_FORMAT, plainCommentText } from "../model/comment-text.mjs";

export function commentMarkdown(message) {
  return commentBodyProjection(message).body;
}

export function commentBodyProjection(message) {
  if (isStoredFormMessage(message))
    return { body: "", body_format: "plain", content_error: STORED_FORM_UNSUPPORTED };
  try {
    if (String(message.bodyFormat ?? "") === PLAIN_FORMAT) {
      const text = plainCommentText(A.spans(message, ["richText"]));
      if (text !== null) return { body: text };
    }
    return { body: exportMarkdown(richDoc(message)), body_format: "markdown" };
  } catch {
    return {
      body:
        typeof message.richText === "string"
          ? message.richText.replaceAll("\ufffc", "\n").trim()
          : "",
      body_format: "plain",
      content_error: "rich_text_unavailable",
    };
  }
}

export function isStoredFormMessage(message) {
  return !isRich(message) || message.body !== undefined;
}

export function commentMessageState(message) {
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
