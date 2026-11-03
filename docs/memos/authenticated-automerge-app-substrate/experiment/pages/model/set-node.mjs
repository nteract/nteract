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
// model/node-registry.mjs: the same names read_page reports. The flat fields
// checked, language, heading_level and align are aliases accepted for one
// deploy; nodeChange turns them into the typed shape.
import * as A from "@automerge/automerge/slim";
import { richDoc, textPath } from "./richtext.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { locateRange } from "./replace-match.mjs";
import {
  ALIGNMENTS,
  SETTABLE_ATTRS,
  nodeLabel,
  nodeType,
  pluralLabel,
  retypeTargets,
  settableAttr,
} from "./node-registry.mjs";

/** The flat aliases, accepted for one deploy. */
export const LEGACY_FIELDS = Object.freeze(["checked", "language", "heading_level", "align"]);
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

/** The flat alias in `input` as the typed shape, or null. */
function legacyChange(input) {
  const present = LEGACY_FIELDS.filter((field) => input[field] !== undefined);
  if (!present.length) return null;
  if (present.length !== 1 || input.type !== undefined || input.attrs !== undefined)
    throw Error(
      `set_node takes type and attrs, or exactly one of ${LEGACY_FIELDS.join(", ")}, not both`,
    );
  const [field] = present;
  const value = input[field];
  if (field !== "heading_level") return { attrs: { [field]: value }, label: field };
  if (!Number.isSafeInteger(value) || value < 0 || value > 6)
    throw Error("heading_level takes 1 to 6 for a heading, or 0 for a paragraph");
  return value
    ? { type: "heading", attrs: { level: value }, label: field }
    : { type: "paragraph", attrs: {}, label: field };
}

/** Validate set_node's change. Returns `{ type?, attrs, label }`, with attr
 * values normalized for storage. `label` names the field a refusal quotes. */
export function nodeChange(input) {
  const change = legacyChange(input) ?? { type: input.type, attrs: input.attrs ?? {}, label: null };
  const { type, attrs } = change;
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
  return { ...(type !== undefined && { type }), attrs: values, label: change.label };
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
// Table cells are the markers a column-scoped attribute (align) sets.
const COLUMN_BLOCKS = new Set(SETTABLE_ATTRS.align.blocks);
const isCell = (span) => span?.type === "block" && COLUMN_BLOCKS.has(markerType(span));

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

/** Change the type or attributes of the node that holds match_text. */
export function setNode(doc, id, input, trace, { anchor } = {}) {
  const change = nodeChange(input);
  const { path, start, end } = locateRange(doc, id, { ...input, op: "set_node" }, anchor);
  const spans = A.spans(doc, textPath(id));
  let index = governingMarker(spans, start);
  const implicit = index < 0;
  const result = { op: "set_node", block_id: id, matched: 1 };
  const names = Object.keys(change.attrs);
  if (implicit && change.type === "paragraph" && !names.length) {
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
  const current = markerType(marker);
  const refuse = (label, blocks) => {
    throw Error(
      `${label} applies to ${pluralLabel(blocks)}; match_text is in ${nodeLabel(current)}`,
    );
  };
  const target = change.type ?? current;
  if (target !== current && !retypeTargets(current).includes(target))
    refuse(change.label ?? "type", retypeTargets(target));
  // Attributes the target type keeps: a retype drops the old type's own.
  const attrs = target === current ? { ...marker.value.attrs } : {};
  let column = null;
  for (const name of names) {
    const found = settableAttr(target, name);
    if (!found) refuse(change.label ?? name, SETTABLE_ATTRS[name].blocks);
    const value = change.attrs[name];
    if (found.spec.scope === "column") {
      column = { stored: found.stored, value };
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
  let cells = 0;
  if (column) {
    for (const cell of columnCells(spans, index)) {
      const { [column.stored]: _old, ...rest } = spans[cell].value.attrs;
      spans[cell] = withAttrs(
        spans[cell],
        column.value === null
          ? rest
          : { ...rest, [column.stored]: new A.ImmutableString(column.value) },
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
