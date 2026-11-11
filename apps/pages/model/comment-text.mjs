// Comment limits and the text a comment's spans hold. No codec: the browser
// composer imports this without loading markdown-it or ProseMirror.

/** At most this many text characters (UTF-16 code units) in one message.
 * Block markers don't count, so a message's length doesn't depend on its
 * span form and matches what a person sees. */
export const COMMENT_MAX_LENGTH = 16000;
/** At most this many bytes of stored spans (their JSON) in one message. */
export const COMMENT_MAX_BYTES = 65536;
/** A message an author wrote as literal text (`body_format: "plain"`). Its
 * spans hold text and hard breaks only, and reads return that text. */
export const PLAIN_FORMAT = "plain";

/** What `spans` hold for the content rule: `length`, the text characters,
 * and `content`, whether any text isn't whitespace or any embed other than
 * a hard break (an image) is present. */
export function commentSpansMeasure(spans) {
  let length = 0,
    content = false;
  for (const span of spans ?? []) {
    if (span?.type === "text") {
      const text = String(span.value ?? "");
      length += text.length;
      if (text.trim()) content = true;
    } else if (
      span?.type === "block" &&
      span.value?.isEmbed === true &&
      String(span.value.type) !== "hard-break"
    )
      content = true;
  }
  return { length, content };
}

const plainBreak = (value) =>
  String(value?.type) === "hard-break" &&
  value.isEmbed === true &&
  (value.parents ?? []).every((parent) => String(parent) === "paragraph") &&
  (value.parents ?? []).length <= 1;

const plainParagraph = (value) =>
  String(value?.type) === "paragraph" &&
  value.isEmbed === false &&
  !(value.parents ?? []).length &&
  !Object.keys(value.attrs ?? {}).length;

/** The literal text of spans a plain write stores: one paragraph of text and
 * hard breaks, each break a `\n`, opened by its marker (or unmarked, as a
 * merge can leave it). Null when the spans hold anything else, so a reader
 * never presents formatted content as literal text. */
export function plainCommentText(spans) {
  let text = "";
  for (const [index, span] of spans.entries()) {
    if (index === 0 && span.type === "block" && plainParagraph(span.value)) continue;
    if (span.type === "text") {
      if (Object.keys(span.marks ?? {}).length) return null;
      text += span.value;
    } else if (plainBreak(span.value)) text += "\n";
    else return null;
  }
  return text;
}

/** A draft's readable text for copy and recovery: its text, with a newline
 * at each block and hard break and an image's alt text. */
export function commentDraftText(spans) {
  let text = "";
  for (const span of spans ?? []) {
    if (span.type === "text") text += span.value;
    else if (span.value?.isEmbed) {
      if (String(span.value.type) === "image") text += String(span.value.attrs?.alt ?? "");
      else text += "\n";
    } else if (text) text += "\n";
  }
  return text;
}
