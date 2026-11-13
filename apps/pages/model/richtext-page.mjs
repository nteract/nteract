// Page block writers and readers: a block's Markdown projection, and the
// writes that replace a block's rich text from Markdown, an image or a node.
import { markerType } from "./node-registry.mjs";
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
import { VIEW_BLOCK, readViewNode, viewLine } from "../shared/views.mjs";
import {
  decode,
  schema,
  Paragraph,
  PagesImage,
  PagesDataframe,
  PagesView,
  PagesLink,
} from "./wordgard-doc.mjs";
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import { markerParents, textPath, updateSpansExactly } from "./richtext-format.mjs";
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
  updateSpansExactly(doc, path, spans, updateSpansConfig);
  stampSpans(doc, spans);
}

// Agent-written Markdown refuses math and HTML (`parseAgentMarkdown`); pass
// `literal: true` for stored source, which keeps them as text instead.
export function setRichMarkdown(doc, id, source, { literal = false } = {}) {
  const tree = literal ? parseMarkdown(source) : parseAgentMarkdown(source);
  const spans = pageSpans(tree);
  updateSpansExactly(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}
/** Repair block `id`'s markers in place, inside the caller's change, so
 * the block stores what every reader draws. Two repairs, in one pass:
 *
 * - Adjusted nesting: a node marker whose parents no writer wrote (decode
 *   in model/wordgard-doc.mjs re-homed it, or dropped or skipped a parent)
 *   gets the parents it is drawn with. The tree every reader draws doesn't
 *   change. The markers keep their identity, so their node ids stay, unless
 *   Automerge can't store a marker's parents in place (updateSpansExactly):
 *   that marker is replaced, and its node id changes.
 * - Unmarked text, which a merge can leave with no marker opening it, gets
 *   the markers a writer writes. Each goes in before the text, which keeps
 *   its characters, marks and comment anchors.
 *
 * A block decode draws only in part because it holds content from a newer
 * build (`newer` and `lossy`) is left alone. A container whose own marker a
 * merge deleted (decode's `rebuilt`) is left as it is too: every reader
 * draws it from its surviving child's parents and names it by that child's
 * marker, so restoring its marker would only move its node id. Returns
 * whether it wrote. */
export function repairBlockMarkers(doc, id) {
  const path = textPath(id);
  let spans = A.spans(doc, path);
  let decoded = decode(spans);
  if (decoded.lossy && decoded.newer) return false;
  let wrote = false;
  if (decoded.moved.length) {
    const drawn = new Map(decoded.moved.map(({ at, parents }) => [at, parents]));
    let at = 0;
    const repaired = spans.map((span) => {
      const parents = span.type === "block" ? drawn.get(at) : undefined;
      at += span.type === "text" ? span.value.length : 1;
      return parents
        ? {
            ...span,
            value: { ...span.value, parents: parents.map((name) => new A.ImmutableString(name)) },
          }
        : span;
    });
    updateSpansExactly(doc, path, repaired, updateSpansConfig);
    stampSpans(doc, repaired);
    wrote = true;
    spans = A.spans(doc, path);
    decoded = decode(spans);
    if (decoded.lossy) return wrote;
  }
  for (const { at, markers } of [...decoded.unmarked].reverse())
    markers.forEach(({ type, parents }, i) =>
      A.splitBlock(doc, path, at + i, {
        type: new A.ImmutableString(type),
        parents: parents.map((parent) => new A.ImmutableString(parent)),
        attrs: {},
        isEmbed: false,
      }),
    );
  return wrote || decoded.unmarked.length > 0;
}
/** Write one empty paragraph, with its marker, as a block's whole content. */
export function setRichEmpty(doc, id) {
  const spans = pageSpans(schema.doc([Paragraph.create([])]));
  updateSpansExactly(doc, textPath(id), spans, updateSpansConfig);
}
export function setRichImage(doc, id, { src, dark_src = null, alt, title = null }) {
  // Construct the embed directly: alt text is content, never Markdown syntax.
  const attrs = { src, alt, title, ...(dark_src == null ? {} : { dark_src }) };
  const tree = schema.doc([Paragraph.create([PagesImage.of(attrs)])]);
  const spans = pageSpans(tree);
  updateSpansExactly(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}
/** Write one node with no Markdown form as a block's whole content. */
export function setRichNode(doc, id, { type, attrs }) {
  const node =
    type === DATAFRAME_BLOCK
      ? PagesDataframe.of(dataframeAttrs(attrs))
      : type === VIEW_BLOCK && readViewNode(attrs)
        ? PagesView.of(readViewNode(attrs))
        : null;
  if (!node) throw Error(`Unsupported node type: ${type}`);
  const spans = pageSpans(schema.doc([node]));
  updateSpansExactly(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}

// The nodes with no Markdown form that a rewrite keeps, each read back as a
// line of its own: `line(param)` is that line's `{ text, href }`, a link
// (a dataframe's) or plain text with `href` null (a view's), or null for
// attrs this build can't read; `looksLike(line)` is true for a line
// that reads as one of them; the rest name it in a refusal.
const KEPT_NODES = Object.freeze([
  {
    type: PagesDataframe,
    name: DATAFRAME_BLOCK,
    one: "a dataframe",
    line: (param) =>
      readDataframe(param) ? { text: dataframeLabel(param.title), href: param.src } : null,
    looksLike: (line) => /^Dataframe(: .*)?$/.test(line.text) && parseAssetPath(line.href) !== null,
    insert: "insert_node with its asset_id",
  },
  {
    type: PagesView,
    name: VIEW_BLOCK,
    one: "a view",
    line: (param) => {
      const view = readViewNode(param);
      return view ? { text: viewLine(view.view_id), href: null } : null;
    },
    looksLike: (line) => line.href === null && /^\[View: [^\]]*\]$/.test(line.text),
    insert: "insert_node with its view_id",
  },
]);
const keptKind = (node) => KEPT_NODES.find((kind) => kind.type === node.type);
const capital = (text) => text[0].toUpperCase() + text.slice(1);

/**
 * Rewrite a block from agent Markdown, keeping its dataframes and views.
 * Applies only when the block holds one; otherwise this is a plain Markdown
 * rewrite, and a line that looks like one stays a link.
 *
 * Each such node must appear in `source` as its read-back line, unchanged,
 * in the same place in the block's structure: at the top level, or inside
 * the same kind of quote or list item it's stored in. That line becomes the
 * original node again, unknown attrs included. Lines may move among their
 * siblings. Throws `markdownless_node`, rather than dropping or inventing a
 * node, when a line:
 *
 * - moves into or out of a quote, list or table, or sits in a heading;
 * - is missing or edited;
 * - outnumbers the block's nodes with that line;
 * - reads like a node the block doesn't hold.
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
        markerParents(s.value),
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
  // Each kept node with its container path: the node types from the block's
  // root down to it, "" at the top level.
  const existing = [];
  (function collect(node, path) {
    for (const child of node.content ?? []) {
      const kind = keptKind(child);
      if (kind) existing.push({ node: child, path, kind });
      else if (child.isPlot && !child.type.spec.inlineContent)
        collect(child, path ? `${path}/${readKind(child)}` : readKind(child));
    }
  })(richDoc(block), "");
  // Every stored one counts, readable or not: one whose attrs this build
  // can't read never matches a line, so the rewrite is refused rather than
  // dropping it.
  for (const kind of KEPT_NODES) {
    const storedCount = A.spans(block, ["richText"]).filter(
      (span) => span.type === "block" && markerType(span.value) === kind.name,
    ).length;
    if (existing.filter((entry) => entry.kind === kind).length !== storedCount)
      throw Object.assign(Error(`A stored ${kind.name} cannot be restored losslessly`), {
        code: "markdownless_node",
      });
  }
  const tree = parseAgentMarkdown(source);
  const unmatched = [...existing];
  const refuse = (message) => {
    throw Object.assign(Error(message), { code: "markdownless_node" });
  };
  // Look-alike lines the walk found, `problem → kind`; the most specific
  // problem is reported.
  const problems = new Map();
  // The line a textblock holds when its whole text is one link, or one run
  // of unformatted text (href null): the shapes of a kept node's read-back
  // line. Table cells hold their text directly.
  const lineLink = (node) => {
    const only = node.type.spec.inlineContent && node.content.length === 1 ? node.content[0] : null;
    if (!only?.isText) return null;
    const link = only.mark(PagesLink);
    if (link) return { href: link.href, text: only.param };
    return only.marks.length ? null : { href: null, text: only.param };
  };
  const sameNode = (entry, line) => {
    const own = entry.kind.line(entry.node.param);
    return !!own && own.href === line.href && own.text === line.text;
  };
  const restore = (node, path) => {
    const line = node.type.spec.inlineContent ? lineLink(node) : null;
    if (line) {
      const matches = existing.filter((entry) => entry.path === path && sameNode(entry, line));
      if (matches.some((entry) => !entry.node.eq(matches[0].node)))
        refuse(
          `Duplicate ${matches[0].kind.name} lines carry different hidden attributes. Use targeted edits instead of guessing their correspondence.`,
        );
      // Only a paragraph can stand where a kept node was: a heading, code
      // block or table cell can't hold one.
      const index =
        node.type === Paragraph.type
          ? unmatched.findIndex((entry) => entry.path === path && sameNode(entry, line))
          : -1;
      if (index !== -1) {
        const [original] = unmatched.splice(index, 1);
        return original.node;
      }
      const same = existing.filter((entry) => sameNode(entry, line));
      // A line that reads as a kept node's line is kept as a plain link
      // that would read exactly like the node, so it's refused unless it
      // brings a node back.
      const lookalike = KEPT_NODES.find((kind) => kind.looksLike(line));
      if (same.some((entry) => entry.path === path && node.type === Paragraph.type))
        problems.set("duplicate", same[0].kind);
      else if (same.length) problems.set("moved", same[0].kind);
      else if (lookalike) problems.set("foreign", lookalike);
      return node;
    }
    if (!node.isPlot || node.type.spec.inlineContent) return node;
    const inner = node === tree ? "" : path ? `${path}/${readKind(node)}` : readKind(node);
    const children = node.content.map((child) => restore(child, inner));
    return node === tree ? schema.doc(children) : node.tag.create(children);
  };
  // Without stored kept nodes, lines that look like them are ordinary links.
  const kept = existing.length ? restore(tree, "") : tree;
  if (problems.has("moved"))
    refuse(
      `${capital(problems.get("moved").one)}'s line can't go inside a quote, list or table, into a heading, or out of the quote or list item it's stored in. Keep it where read_page shows it; it may move among its neighbours.`,
    );
  if (unmatched.length) {
    const line = (entry) => {
      const own = entry.kind.line(entry.node.param);
      if (!own) return unknownNodeNotice(entry.kind.name);
      return own.href === null ? own.text : `[${own.text}](${own.href})`;
    };
    const lines = [...new Set(unmatched.map(line))];
    const counted = lines.map((text) => {
      const total = existing.filter((entry) => line(entry) === text).length;
      return total > 1 ? `${text} (the block holds ${total}; keep one line for each)` : text;
    });
    const kinds = [...new Set(unmatched.map((entry) => entry.kind))];
    const noun = kinds.length === 1 ? kinds[0].name : "node";
    throw Object.assign(
      Error(
        `This block holds ${unmatched.length === 1 ? (kinds[0].one ?? `a ${noun}`) : `${unmatched.length} ${noun}s`} with no line in your Markdown. A ${noun} has no Markdown form; keep its line unchanged to keep it: ${counted.join(", ")}. To remove one, use edit_page delete_node with its node_id from read_page's outline.`,
      ),
      { code: "markdownless_node" },
    );
  }
  if (problems.has("duplicate")) {
    const kind = problems.get("duplicate");
    refuse(
      `${capital(kind.one)}'s line appears more times than the block has ${kind.name}s with that line. Each ${kind.name} keeps exactly one line; to copy one, use ${kind.insert}.`,
    );
  }
  if (problems.has("foreign")) {
    const kind = problems.get("foreign");
    refuse(
      `This line reads as ${kind.one} this block doesn't hold. Markdown can't create or move ${kind.one}; use ${kind.insert}.`,
    );
  }
  const spans = keepImages(pageSpans(kept));
  writeMarkdownSpans(doc, id, spans);
}
/** A block as a response carries it. The map key is the block's id. */
export function projectedBlock(doc, id) {
  const block = doc.blocks[id];
  return { id, position: block.position, markdown: blockMarkdown(block, doc.page_id) };
}
