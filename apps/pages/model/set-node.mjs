// set_node: change a rich-text node's type or attributes without rewriting
// its text.
//
// A node is the paragraph, heading, list item, code block or table cell whose
// block marker governs the addressed text. set_node rewrites that marker (or,
// for a column-scoped attribute, every cell marker in its table column) in
// place through updateSpans, the same path the browser editor writes. Text
// characters, marks and comment anchors keep their CRDT identity, and the
// marker keeps its own.
//
// The shape is `{ type?, attrs? }`, with type and attribute names from
// model/node-registry.mjs: the same names read_page reports. A top-level
// checked, language, heading_level or align is refused with the typed field
// that replaces it.
import * as A from "@automerge/automerge/slim";
import { markerParents, textPath, updateSpansExactly } from "./richtext-format.mjs";
import { unreadableMarker } from "./wordgard-doc.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { locateRange } from "./replace-match.mjs";
import {
  ALIGNMENTS,
  markerType,
  SETTABLE_ATTRS,
  nodeLabel,
  nodeType,
  pluralLabel,
  retypeTargets,
  settableAttr,
} from "./node-registry.mjs";

/** Top-level fields set_node refuses, each with the typed field to use. */
export const REFUSED_FIELDS = Object.freeze({
  checked: "attrs.checked",
  language: "attrs.language",
  heading_level: 'type "heading" with attrs.level, or type "paragraph"',
  align: "attrs.align",
});
/** Agent names set_node's attrs take, from the registry. */
export const NODE_ATTRS = Object.freeze(Object.keys(SETTABLE_ATTRS));
export { ALIGNMENTS };
const MAX_LANGUAGE = 64;
const RETYPES = retypeTargets("paragraph");

/** A settable attribute value, normalized for storage, or a thrown refusal. */
function attrValue(name, value) {
  const { spec } = SETTABLE_ATTRS[name];
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") throw Error(`${name} takes true or false`);
    return value;
  }
  if (spec.type === "integer") {
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max)
      throw Error(`${name} takes an integer from ${spec.min} to ${spec.max}`);
    return value;
  }
  if (spec.type === "enum") {
    if (value === null && spec.nullable) return null;
    if (!spec.values.includes(value))
      throw Error(`${name} takes ${spec.values.join(", ")}${spec.nullable ? " or null" : ""}`);
    return value;
  }
  if (spec.type === "language") {
    if (typeof value !== "string") throw Error(`${name} must be a string`);
    const language = value.trim();
    const control = [...language].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    if (language.length > MAX_LANGUAGE || control || language.includes("`"))
      throw Error(
        `${name} must be at most ${MAX_LANGUAGE} characters, without backticks or line breaks`,
      );
    return language;
  }
  throw Error(`set_node can't set ${name}`);
}

/** Validate set_node's change. Returns `{ type?, attrs }`, with attr values
 * normalized for storage. */
export function nodeChange(input) {
  for (const [field, use] of Object.entries(REFUSED_FIELDS))
    if (input[field] !== undefined)
      throw Error(`set_node takes type and attrs, not a top-level ${field}; use ${use}`);
  const type = input.type;
  const attrs = input.attrs ?? {};
  if (type !== undefined && (typeof type !== "string" || !RETYPES.includes(type)))
    throw Error(`set_node's type takes ${RETYPES.join(" or ")}`);
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs))
    throw Error("set_node's attrs must be an object");
  const names = Object.keys(attrs);
  if (type === undefined && !names.length)
    throw Error(`set_node takes type, attrs (${NODE_ATTRS.join(", ")}), or both`);
  const values = {};
  for (const name of names) {
    if (!Object.hasOwn(SETTABLE_ATTRS, name))
      throw Error(`set_node's attrs take ${NODE_ATTRS.join(", ")}; ${name} isn't one`);
    values[name] = attrValue(name, attrs[name]);
  }
  return { ...(type !== undefined && { type }), attrs: values };
}

/** The spans array index of the block marker governing native offset `at`.
 * The write marks a block's unmarked text before it runs (page.mjs), so a
 * marker governs every character. Inline
 * embeds (a hard break, an image) take a position but govern nothing: text
 * after a line break still belongs to the node before it. */
function governingMarker(spans, at) {
  let pos = 0,
    index = -1;
  for (let i = 0; i < spans.length && pos <= at; i++) {
    if (spans[i].type === "block") {
      if (!spans[i].value.isEmbed) index = i;
      pos += 1;
    } else pos += spans[i].value.length;
  }
  if (index < 0) throw Error("set_node found no marker for this text");
  return index;
}

const spanType = (span) => markerType(span.value);
const parentsOf = (span) => markerParents(span.value);

/** The spans index of the marker set_node changes for text that marker
 * `index` governs: that marker, or the container whose first paragraph it
 * opens, for a container whose marker governs that paragraph
 * (`governsFirstParagraph` in node-registry.mjs): a task is checked through
 * its text, and a list item's first paragraph isn't retyped on its own. */
function targetMarker(spans, index) {
  const marker = spans[index];
  if (spanType(marker) !== "paragraph") return index;
  const container = spans[index - 1];
  if (container?.type !== "block" || container.value.isEmbed) return index;
  const type = spanType(container);
  const own = parentsOf(container),
    parents = parentsOf(marker);
  const firstChild =
    parents.length === own.length + 1 &&
    parents.at(-1) === type &&
    own.every((parent, i) => parent === parents[i]);
  return firstChild && nodeType(type)?.governsFirstParagraph ? index - 1 : index;
}
// Table cells are the markers a column-scoped attribute (align) sets.
const COLUMN_BLOCKS = new Set(SETTABLE_ATTRS.align.blocks);
const isCell = (span) => span?.type === "block" && COLUMN_BLOCKS.has(spanType(span));

/** Spans indexes of every cell marker in the same table column as the cell
 * marker at `index`. Rows and cells follow their table's marker in order;
 * tables can't nest, because cells hold only inline content. */
function columnCells(spans, index) {
  const tables = [];
  let row = null;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span.type !== "block") continue;
    const type = spanType(span);
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

/** Change the type or attributes of the node that holds match_text. */
export function setNode(doc, id, input, trace, { anchor } = {}) {
  const change = nodeChange(input);
  const { path, start, end } = locateRange(doc, id, { ...input, op: "set_node" }, anchor);
  const spans = A.spans(doc, textPath(id));
  const index = targetMarker(spans, governingMarker(spans, start));
  const result = { op: "set_node", block_id: id, matched: 1 };
  const names = Object.keys(change.attrs);
  const marker = spans[index];
  const current = spanType(marker);
  const refuse = (label, blocks) => {
    throw Error(
      `${label} applies to ${pluralLabel(blocks)}; match_text is in ${nodeLabel(current)}`,
    );
  };
  const target = change.type ?? current;
  if (target !== current && !retypeTargets(current).includes(target))
    refuse("type", retypeTargets(target));
  // A retype drops the attributes the old type registers (a heading's level)
  // and keeps the rest, including any a newer build wrote.
  const attrs = { ...marker.value.attrs };
  if (target !== current)
    for (const stored of Object.keys(nodeType(current).attrs)) delete attrs[stored];
  // Column-scoped attributes, by stored name, written to every cell below.
  const column = {};
  for (const name of names) {
    const found = settableAttr(target, name);
    if (!found && target !== current)
      // A retype: name the type the node would become, not the one it is.
      throw Error(
        `type ${target} has no ${name}; ${name} applies to ${pluralLabel(SETTABLE_ATTRS[name].blocks)}`,
      );
    if (!found) refuse(name, SETTABLE_ATTRS[name].blocks);
    const value = change.attrs[name];
    if (found.spec.scope === "column") {
      column[found.stored] = value;
      continue;
    }
    if (value === null) delete attrs[found.stored];
    else attrs[found.stored] = typeof value === "string" ? new A.ImmutableString(value) : value;
  }
  // A type that requires an attribute gets it from the change, or from the
  // node when it already has that type.
  for (const [stored, spec] of Object.entries(nodeType(target).attrs))
    if (spec.required && attrs[stored] === undefined)
      throw Error(`${target} needs attrs.${spec.agent ?? stored}`);
  const typeValue = target === current ? marker.value.type : new A.ImmutableString(target);
  spans[index] = withAttrs(marker, attrs, typeValue);
  const written = [index];
  if (Object.keys(column).length) {
    for (const cell of columnCells(spans, index)) {
      written.push(cell);
      const cellAttrs = { ...spans[cell].value.attrs };
      for (const [stored, value] of Object.entries(column))
        if (value === null) delete cellAttrs[stored];
        else cellAttrs[stored] = new A.ImmutableString(value);
      spans[cell] = withAttrs(spans[cell], cellAttrs);
    }
  }
  // Every reader draws a marker it can't read as a notice, so nothing
  // downstream refuses one. A marker this write leaves unreadable (a stored
  // attribute a newer build wrote that this one can't read) is refused here.
  if (written.some((i) => unreadableMarker(spans[i].value)))
    throw Error(`set_node can't write ${nodeLabel(target)} with attributes this build can't read`);
  updateSpansExactly(doc, path, spans, updateSpansConfig);
  trace?.push({ type: "text", block_id: id, start, end });
  const cells = written.length - 1;
  return { ...result, ...(cells ? { cells } : {}) };
}
