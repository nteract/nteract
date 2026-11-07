// Stored spans and the trees they read as: projection reads (richDoc),
// canonical Page-body spans (pageSpans) and the schema check every rich text
// passes on admission (validateRichSpans).
import * as A from "@automerge/automerge/slim";
import { markSpec, safeUrl, validateMarkValue } from "./marks.mjs";
import {
  TEXT_CONTAINERS,
  isKnownBlock,
  nodeType,
  validAlignment,
  validHeadingLevel,
} from "./node-registry.mjs";
import { DATAFRAME_BLOCK, parseAssetPath, readDataframe } from "../shared/dataset-assets.mjs";
import { decode, encode } from "./wordgard-doc.mjs";
import { adapter, pmDocFromSpans, pmNodeToSpans } from "./pm-adapter.mjs";
import { exportMarkdown } from "./markdown-serializer.mjs";
import { codeTextUnmarked, isRich } from "./richtext-format.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";

const knownBlock = isKnownBlock;
/** Spans the ProseMirror adapter can read, for a projection only. Unknown
 * embeds in a code block always become their notice as text (a code block
 * serializes only its text). With `all`, every unknown marker does: one
 * outside a text container becomes a paragraph holding its notice, and
 * unknown parents are dropped. Writers never store these spans. */
const dataframeInText = (type, parents) =>
  type === DATAFRAME_BLOCK && parents.some((parent) => TEXT_CONTAINERS.has(parent));
/** A dataframe naming an asset on a Page other than `pageId`. No Pages
 * writer stores one; a synced document can. It reads like a node this build
 * doesn't know, so a read never offers the other Page's asset path. */
const foreignDataframe = (span, pageId) =>
  pageId !== undefined &&
  String(span.value?.type) === DATAFRAME_BLOCK &&
  parseAssetPath(String(span.value?.attrs?.src ?? ""))?.pageId !== pageId;
// Text or an inline node stored right after a rule or a dataframe, as when a
// peer types into a node another peer deletes: the editor draws it as a
// paragraph beside the leaf, and the adapter can't place it at all.
// Preserved Markdown keeps text after it as its own content. A leaf inside a
// text container reads as a notice instead (dataframeInText).
export const textlessLeaf = ({ type, parents, isEmbed }) =>
  !isEmbed &&
  nodeType(type)?.kind === "leaf" &&
  String(type) !== "pages-opaque" &&
  !parents.some((parent) => TEXT_CONTAINERS.has(String(parent)));
const paragraphMarker = (parents) => ({
  type: "block",
  value: { type: new A.ImmutableString("paragraph"), parents, attrs: {}, isEmbed: false },
});
function readableSpans(spans, all, pageId) {
  const known = (types) => types.filter(knownBlock).map((p) => new A.ImmutableString(p));
  const out = [];
  for (const span of spans) {
    const leaf = out.at(-1)?.type === "block" ? out.at(-1).value : null;
    if ((span.type !== "block" || span.value?.isEmbed) && leaf && textlessLeaf(leaf))
      out.push(paragraphMarker(leaf.parents));
    if (span.type !== "block") {
      out.push(span);
      continue;
    }
    const type = String(span.value.type);
    const parents = (span.value.parents ?? []).map(String);
    // A dataframe inside a text container can't be placed; it reads like a
    // node this build doesn't know (dataframeInText).
    const foreign = foreignDataframe(span, pageId);
    const unknown = !knownBlock(type) || dataframeInText(type, parents) || foreign;
    if (unknown && (all || foreign || (span.value.isEmbed && parents.includes("code-block")))) {
      if (!span.value.isEmbed && !parents.some((parent) => TEXT_CONTAINERS.has(parent)))
        out.push({
          type: "block",
          value: {
            type: new A.ImmutableString("paragraph"),
            parents: known(parents),
            attrs: {},
            isEmbed: false,
          },
        });
      out.push({ type: "text", value: unknownNodeNotice(type), marks: {} });
    } else if (all && parents.some((parent) => !knownBlock(parent)))
      out.push({ ...span, value: { ...span.value, parents: known(parents) } });
    else out.push(span);
  }
  return out;
}
/** A block's ProseMirror tree. Unknown nodes the adapter can't place, such as
 * one stored inside a table cell or code block, are read through
 * readableSpans, so a Page from a newer build always projects. */
export const richDoc = (block, pageId) => {
  const spans = codeTextUnmarked(A.spans(block, ["richText"]));
  try {
    return pmDocFromSpans(adapter, readableSpans(spans, false, pageId));
  } catch (error) {
    if (!markdownlessNode(block, pageId)) throw error;
    return pmDocFromSpans(adapter, readableSpans(spans, true, pageId));
  }
};
/** A block's Wordgard tree, read through the same rules as richDoc: a
 * dataframe naming another Page's asset, or one inside a text container,
 * reads as a notice, and so does an unknown node in a code block. A block the
 * first reading can't place falls back to notices for every unknown node. */
export const readTree = (block, pageId) => {
  const spans = codeTextUnmarked(A.spans(block, ["richText"]));
  try {
    return decodeOrRefuse(readableSpans(spans, false, pageId));
  } catch (error) {
    if (!markdownlessNode(block, pageId)) throw error;
    return decodeOrRefuse(readableSpans(spans, true, pageId));
  }
};
/** decode's tree, or a refusal with code `unreadable_rich_spans`. decode
 * and the Wordgard schema refuse spans they can't read or place (a heading
 * level out of range, an image inside a code block) with an Error, a
 * Wordgard ValidationError or a RangeError. A TypeError, ReferenceError or
 * SyntaxError is a bug and propagates unchanged. */
const BUGS = [TypeError, ReferenceError, SyntaxError];
function decodeOrRefuse(spans) {
  try {
    return decode(spans).doc;
  } catch (error) {
    if (!(error instanceof Error) || BUGS.some((type) => error instanceof type)) throw error;
    throw Object.assign(Error(error.message, { cause: error }), {
      code: "unreadable_rich_spans",
    });
  }
}
/** richDoc for read projections: outlines, slices and change reads. A block
 * the adapter can't place but readTree reads (a hard break stored in a code
 * block) reads as the adapter's tree for the editor's spans of that tree, so
 * read_page, read_page_changes and blockMarkdown read the same blocks. */
export function projectionDoc(block, pageId) {
  try {
    return richDoc(block, pageId);
  } catch (error) {
    if (adapterRead(block)) throw error;
    let tree;
    try {
      tree = readTree(block, pageId);
    } catch {
      // The adapter's refusal is the one to report.
      throw error;
    }
    return pmDocFromSpans(adapter, encode(tree));
  }
}
/** Whether a block's projection must read it through the ProseMirror
 * adapter (richDoc) instead of readTree, because the Wordgard tree reads it
 * differently:
 *
 * - a marker under a container this build doesn't know: richDoc reads the
 *   container as a notice before its content; decode leaves it out;
 * - a newline stored as text in prose (the adapter's form): richDoc keeps it
 *   as text, which projects as a line break inside the paragraph; decode
 *   reads it as a hard break.
 *
 * Neither is written by a current Pages writer. */
export function adapterRead(block) {
  let code = false;
  for (const span of A.spans(block, ["richText"])) {
    if (span.type === "text") {
      if (!code && span.value.includes("\n")) return true;
      continue;
    }
    if (span.type !== "block") continue;
    if ((span.value?.parents ?? []).some((parent) => !knownBlock(String(parent)))) return true;
    if (!span.value?.isEmbed) code = String(span.value?.type) === "code-block";
  }
  return false;
}
/** The spans the ProseMirror adapter writes for `tree`. pageSpans re-encodes
 * them with the editor's encoder. Fixtures for stored content in the
 * adapter's form, and fixtures whose history must not move with Pages'
 * writer form, use these directly. */
export const adapterSpans = (tree) => pmNodeToSpans(adapter, tree);
/** A Page block's spans for `tree`, written by the editor's own encoder
 * (encode in model/wordgard-doc.mjs), so the editor's first structural
 * edit (Enter, a cross-block delete, a block paste, a list toggle) in an
 * agent-written block rewrites the same spans. The adapter's form differs:
 * it writes a marker for a top-level first paragraph, leaves out the marker
 * of a quote whose first child isn't a paragraph, and keeps a newline in a
 * paragraph as text where the editor writes a hard break.
 *
 * A tree the editor model can't hold whole (decode reports `lossy`) is
 * refused: the editor would show that block read-only. */
export function pageSpans(tree) {
  const decoded = decode(adapterSpans(tree));
  if (decoded.lossy)
    throw Object.assign(
      Error(
        "This content has a node the Pages editor can't hold, so it can't be written. Leave that node out, or use targeted edits.",
      ),
      { code: "markdownless_node" },
    );
  return encode(decoded.doc);
}
/** The type of the first node in the block that Markdown can't reproduce, or
 * null. Today that is a node this build doesn't know: rewriting its block
 * from Markdown would delete it, so replace_block_markdown refuses. */
export function markdownlessNode(block, pageId) {
  if (!isRich(block)) return null;
  for (const span of A.spans(block, ["richText"])) {
    if (span.type !== "block") continue;
    const parents = (span.value?.parents ?? []).map(String);
    if (dataframeInText(String(span.value?.type), parents) || foreignDataframe(span, pageId))
      return DATAFRAME_BLOCK;
    for (const type of [span.value?.type, ...parents].map(String))
      if (!knownBlock(type)) return type;
  }
  return null;
}

// Bound the actual spans: JSON.stringify(doc) alone misses block-marker data.
export function validateRich(block) {
  validateRichSpans(A.spans(block, ["richText"]));
}

const attrsMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (value == null ? value : String(value));
/** Schema check for one stored block marker, on its own: its keys, a known
 * type and parents, and the attrs the ProseMirror adapter reads for that type
 * (model/pm-adapter.mjs), read the way the adapter reads them. Attrs a type
 * doesn't read are kept, unchecked, as the adapter keeps them. Placement in
 * the tree is validateRichSpans' tree check. */
export function validateMarkerValue(value) {
  if (
    !attrsMap(value) ||
    Object.keys(value).some((k) => !["type", "parents", "attrs", "isEmbed"].includes(k)) ||
    !Array.isArray(value.parents) ||
    value.parents.length > 32 ||
    !isKnownBlock(value.type) ||
    !attrsMap(value.attrs)
  )
    throw Error("Unsupported rich block marker");
  for (const parent of value.parents)
    if (!isKnownBlock(parent)) throw Error("Unsupported rich parent");
  const { attrs } = value;
  switch (String(value.type)) {
    case "task-list-item":
      if (typeof attrs.checked !== "boolean") throw Error("Invalid task checked state");
      break;
    case "heading":
      // The adapter's default level is 1.
      if (attrs.level !== undefined && !validHeadingLevel(attrs.level))
        throw Error("Invalid heading level");
      break;
    case "table-cell":
    case "table-header":
      if (attrs.align != null && !validAlignment(String(attrs.align)))
        throw Error("Invalid table alignment");
      break;
    case "image":
      if (
        !safeUrl(attrs.src?.toString() || null) ||
        (attrs.dark_src != null && !safeUrl(text(attrs.dark_src)))
      )
        throw Error("Invalid rich image URL");
      break;
    case DATAFRAME_BLOCK:
      if (
        !readDataframe({
          src: String(attrs.src ?? ""),
          media_type: String(attrs.media_type ?? ""),
          title: text(attrs.title) ?? null,
        })
      )
        throw Error("Invalid dataframe: src must be a Page asset path");
      break;
  }
}

/** Whether readers can read a block's spans: the ProseMirror tree richDoc
 * builds and the Wordgard tree readTree builds, both through readableSpans
 * (text or an inline node straight after a rule or dataframe reads as a
 * paragraph; on a second try every unknown node reads as a notice), plus
 * the Markdown export every projection makes. Marks are left out: Page
 * admission judges each mark it writes on its own. This is what concurrent
 * merges are held to, since readers repair what merging two valid edits
 * leaves; validateRichSpans is the stricter check writers' own output
 * passes. */
export function spansRead(spans, pageId) {
  const unmarked = spans.map((span) =>
    span.type === "text" ? { type: "text", value: span.value } : span,
  );
  const attempt = (all) => {
    const readable = readableSpans(unmarked, all, pageId);
    const tree = pmDocFromSpans(adapter, readable);
    tree.check();
    decodeOrRefuse(readable);
    exportMarkdown(tree);
  };
  for (const all of [false, true])
    try {
      attempt(all);
      return true;
    } catch {
      // Unreadable this way; the second try reads unknown nodes as notices.
    }
  return false;
}

/** Schema check for native rich-text spans read from any Automerge text
 * object: a Page block's `richText` or a comments-doc message `body`. */
export function validateRichSpans(spans, maxBytes = 262144) {
  if (new TextEncoder().encode(JSON.stringify(spans)).length > maxBytes)
    throw Error("Rich block exceeds content limit");
  for (const span of spans) {
    if (span.type === "text") {
      for (const [name, value] of Object.entries(span.marks ?? {})) {
        markSpec(name);
        try {
          validateMarkValue(name, value);
        } catch {
          throw Error(name === "link" ? "Invalid rich link" : "Invalid rich mark value");
        }
      }
    } else if (span.type === "block") validateMarkerValue(span.value);
    else throw Error("Unsupported rich span");
  }
  const tree = pmDocFromSpans(adapter, codeTextUnmarked(spans));
  tree.check();
  tree.descendants((node) => {
    if (
      ["table_cell", "table_header"].includes(node.type.name) &&
      node.attrs.align != null &&
      !validAlignment(node.attrs.align)
    )
      throw Error("Invalid table alignment");
    if (node.type.name === "heading" && !validHeadingLevel(node.attrs.level))
      throw Error("Invalid heading level");
    if (
      node.type.name === "image" &&
      (!safeUrl(node.attrs.src) || (node.attrs.dark_src != null && !safeUrl(node.attrs.dark_src)))
    )
      throw Error("Invalid rich image URL");
    // Lenient: a later build may add media types or attrs under the same
    // feature. Writers check strictly (dataframeAttrs) before writing.
    if (node.type.name === "dataframe" && !readDataframe(node.attrs))
      throw Error("Invalid dataframe: src must be a Page asset path");
    for (const mark of node.marks)
      if (mark.type.name === "link" && !safeUrl(mark.attrs.href)) throw Error("Invalid rich link");
  });
  exportMarkdown(tree);
}
