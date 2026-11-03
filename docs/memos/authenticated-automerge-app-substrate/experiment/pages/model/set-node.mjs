// set_node: change one rich-text node's attributes without rewriting its text.
//
// A node is the paragraph, heading, list item, code block or table cell whose
// block marker governs the addressed text. set_node rewrites that marker (or,
// for align, every cell marker in its table column) in place through
// updateSpans, the same path the browser editor writes. Text characters, marks
// and comment anchors keep their CRDT identity, and the marker keeps its own.
import * as A from "@automerge/automerge/slim";
import { richDoc, textPath } from "./richtext.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { locateRange } from "./replace-match.mjs";
import { ALIGNMENTS, nodeLabel } from "./node-registry.mjs";

export const NODE_FIELDS = Object.freeze(["checked", "language", "heading_level", "align"]);
const MAX_LANGUAGE = 64;
// Node labels and the alignment values live in model/node-registry.mjs. A
// container's first paragraph has no marker of its own, so the container's
// label says so.
export { ALIGNMENTS };
const nodeName = nodeLabel;

/** Validate set_node's one attribute field. Returns `{ field, value }` with
 * the value normalized for storage. */
export function nodeChange(input) {
  const present = NODE_FIELDS.filter((field) => input[field] !== undefined);
  if (present.length !== 1) throw Error(`set_node takes exactly one of ${NODE_FIELDS.join(", ")}`);
  const [field] = present;
  const value = input[field];
  if (field === "checked") {
    if (typeof value !== "boolean") throw Error("checked takes true or false");
    return { field, value };
  }
  if (field === "language") {
    if (typeof value !== "string") throw Error("language must be a string");
    const language = value.trim();
    const control = [...language].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    if (language.length > MAX_LANGUAGE || control || language.includes("`"))
      throw Error(
        `language must be at most ${MAX_LANGUAGE} characters, without backticks or line breaks`,
      );
    return { field, value: language };
  }
  if (field === "heading_level") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 6)
      throw Error("heading_level takes 1 to 6 for a heading, or 0 for a paragraph");
    return { field, value };
  }
  if (value !== null && !ALIGNMENTS.includes(value))
    throw Error(`align takes ${ALIGNMENTS.join(", ")} or null`);
  return { field, value };
}

/** The spans array index of the block marker governing native offset `at`,
 * or -1 when the text sits in the implicit first paragraph, which has none.
 * Inline embeds (a hard break, an image) take a position but govern nothing:
 * text after a line break still belongs to the node before it. */
function governingMarker(spans, at) {
  let pos = 0,
    index = -1;
  for (let i = 0; i < spans.length && pos <= at; i++) {
    if (spans[i].type === "block") {
      if (!spans[i].value.isEmbed) index = i;
      pos += 1;
    } else pos += spans[i].value.length;
  }
  return index;
}

const markerType = (span) => String(span.value.type);
const isCell = (span) =>
  span?.type === "block" && ["table-cell", "table-header"].includes(markerType(span));

/** Spans indexes of every cell marker in the same table column as the cell
 * marker at `index`. Rows and cells follow their table's marker in order;
 * tables can't nest, because cells hold only inline content. */
function columnCells(spans, index) {
  const tables = [];
  let row = null;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span.type !== "block") continue;
    const type = markerType(span);
    if (type === "table") {
      tables.push([]);
      row = null;
    } else if (type === "table-row") {
      row = [];
      tables.at(-1)?.push(row);
    } else if (isCell(span)) row?.push(i);
  }
  for (const rows of tables)
    for (const cells of rows) {
      const column = cells.indexOf(index);
      if (column >= 0) return rows.map((cells) => cells[column]).filter((i) => i !== undefined);
    }
  throw Error("set_node couldn't find this cell's table");
}

const withAttrs = (span, attrs, type = span.value.type) => ({
  type: "block",
  value: { ...span.value, type, attrs },
});

/** Change one node attribute for the text match_text addresses.
 *
 * Experimental: these four fields come before the typed node registry. When
 * block types declare their attributes there, set_node reads them from it. */
export function setNode(doc, id, input, trace, { anchor } = {}) {
  const { field, value } = nodeChange(input);
  const { path, start, end } = locateRange(doc, id, { ...input, op: "set_node" }, anchor);
  const spans = A.spans(doc, textPath(id));
  let index = governingMarker(spans, start);
  const implicit = index < 0;
  const result = { op: "set_node", block_id: id, matched: 1 };
  if (implicit && field === "heading_level" && value === 0) {
    // Already a paragraph. An explicit marker would change nothing, and the
    // editor drops it on the next keystroke.
    trace?.push({ type: "text", block_id: id, start, end });
    return result;
  }
  if (implicit) {
    // The implicit first paragraph. Give it an explicit marker to change.
    // That inserts a character at 0, as the editor does: two writers that
    // convert it concurrently each insert one and leave an empty paragraph
    // between them. Target scope refuses the second through its ancestry check.
    spans.unshift({
      type: "block",
      value: { type: new A.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false },
    });
    index = 0;
  }
  const marker = spans[index];
  const type = markerType(marker);
  const attrs = { ...marker.value.attrs };
  const refuse = (what) => {
    throw Error(`${field} applies to ${what}; match_text is in ${nodeName(type)}`);
  };
  let cells = 0;
  if (field === "checked") {
    if (type !== "task-list-item") refuse("task list items");
    spans[index] = withAttrs(marker, { ...attrs, checked: value });
  } else if (field === "language") {
    if (type !== "code-block") refuse("code blocks");
    spans[index] = withAttrs(marker, { ...attrs, params: new A.ImmutableString(value) });
  } else if (field === "heading_level") {
    if (type !== "paragraph" && type !== "heading") refuse("paragraphs and headings");
    const { level: _level, ...rest } = attrs;
    spans[index] = value
      ? withAttrs(marker, { ...rest, level: value }, new A.ImmutableString("heading"))
      : withAttrs(marker, rest, new A.ImmutableString("paragraph"));
  } else {
    if (!isCell(marker)) refuse("table cells");
    for (const cell of columnCells(spans, index)) {
      const { align: _align, ...rest } = spans[cell].value.attrs;
      spans[cell] = withAttrs(
        spans[cell],
        value === null ? rest : { ...rest, align: new A.ImmutableString(value) },
      );
      cells++;
    }
  }
  A.updateSpans(doc, path, spans, updateSpansConfig);
  // The schema accepts every change above; check the tree anyway, so a
  // malformed marker can never be committed.
  richDoc(doc.blocks[id]).check();
  const shift = implicit ? 1 : 0;
  trace?.push({ type: "text", block_id: id, start: start + shift, end: end + shift });
  return { ...result, ...(cells ? { cells } : {}) };
}
