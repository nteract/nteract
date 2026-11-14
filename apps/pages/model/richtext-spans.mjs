// Native span validation and editor-tree encoding. Read projections live in native-read.
import * as A from "@automerge/automerge/slim";
import { markSpec, safeUrl, validateMarkValue } from "./marks.mjs";
import {
  TEXT_CONTAINERS,
  isKnownBlock,
  nodeType,
  validAlignment,
  validHeadingLevel,
  markerType,
} from "./node-registry.mjs";
import { DATAFRAME_BLOCK, parseAssetPath, readDataframe } from "../shared/dataset-assets.mjs";
import { VIEW_BLOCK, readViewNode } from "../shared/views.mjs";
import { PagesUnknownBlock, PagesUnknownEmbed, decode, encode, schema } from "./wordgard-doc.mjs";
import { noticeNode, treeMarkdown } from "./markdown-serializer.mjs";
import { UNREADABLE_NAME, codeTextUnmarked, markerParents, textPath } from "./richtext-format.mjs";

export const readTree = (block) => decode(codeTextUnmarked(A.spans(block, ["richText"]))).doc;
export const richDoc = readTree;
export const pageSpans = encode;

/** The first stored type a Markdown rewrite cannot reproduce: a dataframe
 * or view out of place, a type this build doesn't know, or anything else the
 * serializer draws as a notice (noticeNode), which a rewrite would turn
 * into literal notice text. A notice with no quotable name answers null
 * from noticeNode and refuses as UNREADABLE_NAME. */
export function markdownlessNode(block, pageId) {
  for (const span of A.spans(block, ["richText"])) {
    if (span.type !== "block") continue;
    const type = markerType(span.value) ?? UNREADABLE_NAME,
      parents = markerParents(span.value),
      src = span.value?.attrs?.src;
    if (
      type === DATAFRAME_BLOCK &&
      (parents.some((parent) => TEXT_CONTAINERS.has(parent)) ||
        (!span.value?.attrs?.binding &&
          pageId !== undefined &&
          parseAssetPath(
            A.isImmutableString(src) ? String(src) : typeof src === "string" ? src : "",
          )?.pageId !== pageId))
    )
      return DATAFRAME_BLOCK;
    if (type === VIEW_BLOCK && parents.some((parent) => TEXT_CONTAINERS.has(parent)))
      return VIEW_BLOCK;
    for (const name of [type, ...parents]) if (!isKnownBlock(name)) return name;
  }
  const notice = noticeNode(readTree(block));
  return notice === undefined ? null : (notice ?? UNREADABLE_NAME);
}

/** Whether decode draws the stored marker `value` as a node this build
 * reads. How decode draws a marker depends only on the marker: its type,
 * its attrs and its own parents. A known node under a container this build
 * doesn't know still reads. */
export function readableMarker(value) {
  let readable = true;
  decode([{ type: "block", value }]).doc.iterate((node) => {
    if (node.type === PagesUnknownBlock || node.type === PagesUnknownEmbed) readable = false;
  });
  return readable;
}
/** The index in `spans` of the node marker whose text holds native offset
 * `at`: the last marker before it that isn't an embed, or -1 for unmarked
 * text at the start of the block, which reads as a paragraph. Text after a
 * marker this build can't read is that node's own content. */
export function textOwner(spans, at) {
  let pos = 0,
    index = -1;
  for (let i = 0; i < spans.length && pos <= at; i++) {
    if (spans[i].type === "block") {
      if (!spans[i].value?.isEmbed) index = i;
      pos += 1;
    } else pos += spans[i].value.length;
  }
  return index;
}
export const newerContent = (message) =>
  Object.assign(Error(message), { status: 409, code: "newer_content" });
/** Refuse a host write to text that belongs to a node this build can't read:
 * text after its marker, which decode draws only in part. A match never
 * crosses a marker, so the text's owner decides. Text in the nodes this
 * build reads stays editable in a block that also holds newer content: the
 * write splices characters and marks and leaves every marker as stored. */
export function refuseUnreadableText(spans, at, op) {
  const owner = textOwner(spans, at);
  if (owner >= 0 && !readableMarker(spans[owner].value))
    throw newerContent(
      `match_text is in a node from a newer version of Pages that this version can't read, so ${op} can't edit it. Edit text in the nodes this version reads, remove the node with delete_node, or remove the block with delete_block and the block's id.`,
    );
}

export const validateRich = (block) => validateRichSpans(A.spans(block, ["richText"]));

/** Admission checks stored envelopes and attributes before asking the native schema
 * to validate structure. A tolerant read projection cannot authorize a write. */
export function validateRichSpans(spans, maxBytes = 262144) {
  if (new TextEncoder().encode(JSON.stringify(spans)).length > maxBytes)
    throw Error("Rich block exceeds content limit");
  for (const span of spans) {
    if (span.type === "text") {
      if (typeof span.value !== "string") throw Error("Invalid rich text");
      for (const [name, value] of Object.entries(span.marks ?? {})) {
        markSpec(name);
        try {
          validateMarkValue(name, value);
        } catch {
          throw Error(name === "link" ? "Invalid rich link" : "Invalid rich mark value");
        }
      }
    } else if (span.type === "block") {
      const value = span.value;
      if (
        !value ||
        Object.keys(value).some((k) => !["type", "parents", "attrs", "isEmbed"].includes(k)) ||
        !Array.isArray(value.parents) ||
        value.parents.length > 32 ||
        !isKnownBlock(value.type)
      )
        throw Error("Unsupported rich block marker");
      for (const parent of value.parents)
        if (!isKnownBlock(parent)) throw Error("Unsupported rich parent");
      const type = markerType(value),
        attrs = value.attrs ?? {};
      if (
        typeof value.isEmbed !== "boolean" ||
        value.isEmbed !== (nodeType(type).kind === "embed") ||
        typeof attrs !== "object" ||
        Array.isArray(attrs)
      )
        throw Error("Invalid rich block shape");
      if (type === "task-list-item" && typeof attrs.checked !== "boolean")
        throw Error("Invalid task checked state");
      if (type === "heading" && !validHeadingLevel(attrs.level === undefined ? 1 : attrs.level))
        throw Error("Invalid heading level");
      if (
        ["table-cell", "table-header"].includes(type) &&
        attrs.align != null &&
        !validAlignment(String(attrs.align))
      )
        throw Error("Invalid table alignment");
      if (
        type === "image" &&
        (!safeUrl(String(attrs.src ?? "")) ||
          (attrs.dark_src != null && !safeUrl(String(attrs.dark_src))))
      )
        throw Error("Invalid rich image URL");
      if (
        type === DATAFRAME_BLOCK &&
        !readDataframe(
          Object.fromEntries(
            Object.entries(attrs).map(([k, v]) => [k, A.isImmutableString(v) ? String(v) : v]),
          ),
        )
      )
        throw Error("Invalid dataframe: expected a Page asset path or source binding");
      if (
        type === VIEW_BLOCK &&
        !readViewNode(
          Object.fromEntries(
            Object.entries(attrs).map(([k, v]) => [k, A.isImmutableString(v) ? String(v) : v]),
          ),
        )
      )
        throw Error("Invalid view: view_id must be a view id");
    } else throw Error("Unsupported rich span");
  }
  const decoded = decode(codeTextUnmarked(spans));
  // decode reads what it can't draw as a notice; admission refuses it. A
  // notice stored by this write would never read as what was written.
  if (decoded.newer) throw Error("Rich text contains content this build can't read");
  if (decoded.lossy) throw Error("Rich text contains content the native schema cannot place");
  schema.validate(decoded.doc);
  treeMarkdown(decoded.doc);
}
