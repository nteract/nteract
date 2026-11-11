// Page block writers and readers: a block's Markdown projection, and the
// writes that replace a block's rich text from Markdown, an image or a node.
import * as A from "@automerge/automerge/slim";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { imageAttrs } from "./image-attrs.mjs";
import {
  DATAFRAME_BLOCK,
  dataframeAttrs,
  parseAssetPath,
  readDataframe,
} from "../shared/dataset-assets.mjs";
import { schema, Paragraph, PagesImage, PagesDataframe, PagesLink } from "./wordgard-doc.mjs";
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import { textPath } from "./richtext-format.mjs";
import { pageSpans, richDoc } from "./richtext-spans.mjs";
import { nativeRead, readMarkdown, readKind } from "./native-read.mjs";
import { dataframeLabel, unknownNodeNotice } from "./richtext-notices.mjs";

/** A block's Markdown projection. `pageId` is the Page holding the block; a
 * dataframe naming another Page's asset then reads as an unknown-node
 * notice. The read projection does not change or validate stored content. */
export function blockMarkdown(block, pageId) {
  return readMarkdown(nativeRead(block, pageId).nodes);
}

// Rich writers stamp the schema features their spans need in the same change.
function writeMarkdownSpans(doc, id, spans) {
  // Compare stored values, not their Markdown or tolerant read projection.
  // Keep marker/attribute representation and every hidden field significant.
  const key = (value) => {
    if (A.isImmutableString(value)) return ["immutable", String(value)];
    if (Array.isArray(value)) return ["array", value.map(key)];
    if (value && typeof value === "object")
      return [
        "object",
        Object.keys(value)
          .sort()
          .map((name) => [name, key(value[name])]),
      ];
    return [typeof value, value];
  };
  const runs = (input) => {
    const out = [];
    for (const span of input) {
      if (span.type !== "text") {
        out.push(span);
        continue;
      }
      const last = out.at(-1),
        marks = span.marks ?? {};
      if (last?.type === "text" && JSON.stringify(key(last.marks)) === JSON.stringify(key(marks)))
        last.value += span.value;
      else if (span.value) out.push({ type: "text", value: span.value, marks });
    }
    return JSON.stringify(key(out));
  };
  const path = textPath(id);
  // updateSpans can re-mark an unchanged multi-span mark, defeating a peer's
  // concurrent unmark. Only exact restored runs qualify: markers and their
  // attrs compare as stored.
  if (runs(A.spans(doc, path)) === runs(spans)) return;
  A.updateSpans(doc, path, spans, updateSpansConfig);
  stampSpans(doc, spans);
}

// Agent-written Markdown refuses math and HTML (`parseAgentMarkdown`); pass
// `literal: true` for stored source, which keeps them as text instead.
export function setRichMarkdown(doc, id, source, { literal = false } = {}) {
  const tree = literal ? parseMarkdown(source) : parseAgentMarkdown(source);
  const spans = pageSpans(tree);
  A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}
/** Write one empty paragraph, with its marker, as a block's whole content. */
export function setRichEmpty(doc, id) {
  const spans = pageSpans(schema.doc([Paragraph.create([])]));
  A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
}
export function setRichImage(doc, id, { src, dark_src = null, alt, title = null }) {
  // Construct the embed directly: alt text is content, never Markdown syntax.
  const attrs = { src, alt, title, ...(dark_src == null ? {} : { dark_src }) };
  const tree = schema.doc([Paragraph.create([PagesImage.of(attrs)])]);
  const spans = pageSpans(tree);
  A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}
/** Write one node with no Markdown form as a block's whole content. */
export function setRichNode(doc, id, { type, attrs }) {
  if (type !== DATAFRAME_BLOCK) throw Error(`Unsupported node type: ${type}`);
  const tree = schema.doc([PagesDataframe.of(dataframeAttrs(attrs))]);
  const spans = pageSpans(tree);
  A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}

/**
 * Rewrite a block from agent Markdown, keeping its dataframes. Applies only
 * when the block holds one; otherwise this is a plain Markdown rewrite, and a
 * dataframe-like line stays a link.
 *
 * Each dataframe must appear in `source` as its read-back line, unchanged, in
 * the same place in the block's structure: at the top level, or inside the
 * same kind of quote or list item it's stored in. That line becomes the
 * original node again, unknown attrs included. Lines may move among their
 * siblings. Throws `markdownless_node`, rather than dropping or inventing a
 * node, when a line:
 *
 * - moves into or out of a quote, list or table, or sits in a heading;
 * - is missing or edited;
 * - outnumbers the block's dataframes with that line;
 * - reads like a dataframe the block doesn't hold.
 */
export function setRichMarkdownKeepingNodes(doc, id, source) {
  const block = doc.blocks[id];
  const images = A.spans(block, ["richText"]).filter(
    (s) => s.type === "block" && String(s.value.type) === "image",
  );
  const refuseImage = () => {
    throw Object.assign(
      Error(
        "This block holds image attributes Markdown cannot reproduce. Keep each image unchanged in an unambiguous container, or use targeted edits instead.",
      ),
      { code: "markdownless_node" },
    );
  };
  if (images.some((s) => !imageAttrs(s.value.attrs))) refuseImage();
  const opaqueImages = images.filter((s) =>
    Object.keys(s.value.attrs).some((k) => !["src", "alt", "title"].includes(k)),
  );
  const keepImages = (spans) => {
    const key = (s) =>
      JSON.stringify([
        s.value.parents.map(String),
        ...["src", "alt", "title"].map((k) => String(s.value.attrs[k] ?? "")),
      ]);
    for (const original of opaqueImages) {
      const identity = key(original);
      const candidates = spans.filter(
        (s) => s.type === "block" && String(s.value.type) === "image" && key(s) === identity,
      );
      // Even identical duplicates have no stable correspondence in Markdown.
      // Do not guess which hidden attrs belong to which occurrence.
      if (images.filter((s) => key(s) === identity).length !== 1 || candidates.length !== 1)
        refuseImage();
      candidates[0].value.attrs = original.value.attrs;
    }
    return spans;
  };
  // Each dataframe with its container path: the node types from the block's
  // root down to it, "" at the top level.
  const existing = [];
  (function collect(node, path) {
    for (const child of node.content ?? []) {
      if (child.type === PagesDataframe) existing.push({ node: child, path });
      else if (child.isPlot && !child.type.spec.inlineContent)
        collect(child, path ? `${path}/${readKind(child)}` : readKind(child));
    }
  })(richDoc(block), "");
  // Every dataframe counts, readable or not: one whose attrs this build can't
  // read never matches a line, so the rewrite is refused rather than dropping
  // it.
  const storedCount = A.spans(block, ["richText"]).filter(
    (span) => span.type === "block" && String(span.value.type) === "dataframe",
  ).length;
  if (existing.length !== storedCount)
    throw Object.assign(Error("A stored dataframe cannot be restored losslessly"), {
      code: "markdownless_node",
    });
  const tree = parseAgentMarkdown(source);
  const unmatched = [...existing];
  const refuse = (message) => {
    throw Object.assign(Error(message), { code: "markdownless_node" });
  };
  // Look-alike lines the walk found; the most specific one is reported.
  const problems = new Set();
  // The link a textblock holds when its whole text is one link: the shape of
  // a dataframe's read-back line. Table cells hold their text directly.
  const lineLink = (node) => {
    const only = node.type.spec.inlineContent && node.content.length === 1 ? node.content[0] : null;
    const link = only?.isText ? only.mark(PagesLink) : null;
    return link ? { href: link.href, text: only.param } : null;
  };
  const sameNode = (candidate, line) =>
    candidate.param.src === line.href && dataframeLabel(candidate.param.title) === line.text;
  // A line that reads as a dataframe's read-back line: a "Dataframe" label
  // linking a Page asset. Kept as a plain link it would read exactly like the
  // node, so it's refused unless it brings a node back.
  const looksLikeNode = (line) =>
    /^Dataframe(: .*)?$/.test(line.text) && parseAssetPath(line.href) !== null;
  const restore = (node, path) => {
    const line = node.type.spec.inlineContent ? lineLink(node) : null;
    if (line) {
      const matches = existing.filter((entry) => entry.path === path && sameNode(entry.node, line));
      if (matches.some((entry) => !entry.node.eq(matches[0].node)))
        refuse(
          "Duplicate dataframe lines carry different hidden attributes. Use targeted edits instead of guessing their correspondence.",
        );
      // Only a paragraph can stand where a dataframe was: a heading, code
      // block or table cell can't hold one.
      const index =
        node.type === Paragraph.type
          ? unmatched.findIndex((entry) => entry.path === path && sameNode(entry.node, line))
          : -1;
      if (index !== -1) {
        const [original] = unmatched.splice(index, 1);
        return original.node;
      }
      const same = existing.filter((entry) => sameNode(entry.node, line));
      if (same.some((entry) => entry.path === path && node.type === Paragraph.type))
        problems.add("duplicate");
      else if (same.length) problems.add("moved");
      else if (looksLikeNode(line)) problems.add("foreign");
      return node;
    }
    if (!node.isPlot || node.type.spec.inlineContent) return node;
    const inner = node === tree ? "" : path ? `${path}/${readKind(node)}` : readKind(node);
    const children = node.content.map((child) => restore(child, inner));
    return node === tree ? schema.doc(children) : node.tag.create(children);
  };
  // Without stored dataframes, dataframe-like lines are ordinary links.
  const kept = existing.length ? restore(tree, "") : tree;
  if (problems.has("moved"))
    refuse(
      "A dataframe's line can't go inside a quote, list or table, into a heading, or out of the quote or list item it's stored in. Keep it where read_page shows it; it may move among its neighbours.",
    );
  if (unmatched.length) {
    const line = (node) =>
      readDataframe(node.param)
        ? `[${dataframeLabel(node.param.title)}](${node.param.src})`
        : unknownNodeNotice("dataframe");
    const lines = [...new Set(unmatched.map((entry) => line(entry.node)))];
    const counted = lines.map((text) => {
      const total = existing.filter((entry) => line(entry.node) === text).length;
      return total > 1 ? `${text} (the block holds ${total}; keep one line for each)` : text;
    });
    throw Object.assign(
      Error(
        `This block holds ${unmatched.length === 1 ? "a dataframe" : `${unmatched.length} dataframes`} with no line in your Markdown. A dataframe has no Markdown form; keep its line unchanged to keep it: ${counted.join(", ")}. To remove one, use edit_page delete_node with its node_id from read_page's outline.`,
      ),
      { code: "markdownless_node" },
    );
  }
  if (problems.has("duplicate"))
    refuse(
      "A dataframe's line appears more times than the block has dataframes with that line. Each dataframe keeps exactly one line; to copy one, use insert_node with its asset_id.",
    );
  if (problems.has("foreign"))
    refuse(
      "This line reads as a dataframe this block doesn't hold. Markdown can't create or move a dataframe; use insert_node with its asset_id.",
    );
  const spans = keepImages(pageSpans(kept));
  writeMarkdownSpans(doc, id, spans);
}
/** A block as a response carries it. The map key is the block's id. */
export function projectedBlock(doc, id) {
  const block = doc.blocks[id];
  return { id, position: block.position, markdown: blockMarkdown(block, doc.page_id) };
}
