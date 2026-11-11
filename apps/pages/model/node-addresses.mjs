// Top-level node addresses for a rich-text block, computed from its stored
// spans through the Pages document model (model/wordgard-doc.mjs). DOM-free
// and ProseMirror-free: decode builds the tree and the maps between Automerge
// text indexes and tree positions; this module reads both.
//
// A block's top-level nodes are the children of its decoded document: a
// paragraph, heading, code block, list, quote, table, rule, dataframe or a
// node this build doesn't know. Each has:
//
// - `start`, `end`: its text range `[start, end)`, from its opening marker up
//   to the next node's opening marker, or the end of the text for the last
//   node.
// - `at`: the index of its opening marker, the same as `start`. A list's
//   opening marker is its first item's; a quote stored without its own marker
//   opens with its first child's.
//
// `node_index` is a node's position in this list. node-ids.mjs names a node by
// a cursor at `at`. nodeIndexAt and ancestryAt address a single character, as
// a target-scoped passage edit compares it across revisions.
//
// Text stored right after a marker this build doesn't know is that node's own
// content. decode draws it as a separate paragraph; here it stays part of the
// unknown node, so the node count and every later node_index match what the
// Markdown projection reads (one unknown node holding the text).
import * as A from "@automerge/automerge/slim";
import { codeTextUnmarked } from "./richtext-format.mjs";
import {
  CodeBlock,
  decode,
  PagesUnknownBlock,
  PagesUnknownEmbed,
  Paragraph,
} from "./wordgard-doc.mjs";

const width = (span) => (span.type === "text" ? span.value.length : 1);

/** The top-level node addresses of a block whose stored spans are `spans`
 * (`A.spans(doc, textPath(blockId))`): `{ nodes, length, placed, ... }`.
 * `nodes` is `[{ start, end, at, wgStart, wgEnd }]` in document order, the
 * last two the node's span in decode's tree positions; `length` is the
 * text's length. `placed` is false when decode had to draw a stored node
 * somewhere other than where it was stored: a block marker inside a table
 * cell or code block (a dataframe, or a node this build doesn't know), or an
 * inline node other than a line break inside a code block. Such a block's
 * nodes get no ids (node-ids.mjs). The rest is for nodeIndexAt and
 * ancestryAt. Throws what decode throws on a marker it refuses (an invalid
 * heading level, image URL or mark value, a container left with no content). */
export function blockAddresses(spans) {
  const plain = codeTextUnmarked(spans);
  const { doc: tree, map } = decode(plain);
  // Non-embed block markers by index: the only characters that open a node.
  const opening = new Map();
  let length = 0;
  let placed = true;
  for (const span of plain) {
    if (span.type === "block") {
      if (!span.value.isEmbed) opening.set(length, span.value);
      // decode draws an unknown inline node in a code block as plain text.
      else if (
        placed &&
        String(span.value.type) !== "hard-break" &&
        tree.resolve(map.amToWg[length]).parent.node.type === CodeBlock.type
      )
        placed = false;
    }
    length += width(span);
  }
  tree.iterate((node) => {
    if (node.type === PagesUnknownEmbed && !node.param.isEmbed) placed = false;
  });
  const nodes = [];
  // Unknown blocks that may still take the text stored after their marker.
  const unknown = new Set();
  let wg = 0;
  for (const node of tree.content) {
    const from = wg;
    wg += node.length;
    const start = map.wgToAm[from];
    const end = map.wgToAm[wg];
    const prior = nodes.at(-1);
    // A markerless paragraph right after an unknown block is that block's text.
    if (prior && unknown.has(prior) && node.type === Paragraph.type && !opening.has(start)) {
      unknown.delete(prior);
      Object.assign(prior, { end, wgEnd: wg, text: from });
      continue;
    }
    // decode refuses any other content before its node's marker.
    if (!opening.has(start)) throw Error("A top-level node has no opening marker");
    const entry = { start, end, at: start, wgStart: from, wgEnd: wg };
    if (node.type === PagesUnknownBlock) unknown.add(entry);
    nodes.push(entry);
  }
  return {
    nodes,
    length,
    placed,
    tree,
    map,
    opening,
  };
}

/** The node_index of the node holding text index `am`. */
export function nodeIndexAt({ nodes, map }, am) {
  const wg = map.amToWg[am];
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (nodes[mid].wgStart <= wg) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The containers holding text index `am`, outermost first, as plain data
 * per level: its type and the attrs of the stored marker that opens it, `{}`
 * for a container drawn without one (a list, a quote stored without its own
 * marker). Two ancestries compare equal when the character sits in the same
 * structure with the same stored attributes, including attributes this
 * build doesn't know. */
export function ancestryAt(addresses, am) {
  const { tree, map, opening, nodes } = addresses;
  const chain = [];
  for (let level = tree.resolve(map.amToWg[am]).parent; level?.parent; level = level.parent)
    chain.unshift(level);
  const ancestry = chain.map(({ node, before }) => {
    const at = map.wgToAm[before];
    const marker = map.wgToAm[before + 1] > at ? opening.get(at) : undefined;
    return { type: node.name, attrs: storedAttrs(marker?.attrs) };
  });
  // Text an unknown node holds (`text`: where decode's paragraph for it
  // starts) sits inside that node.
  const node = nodes[nodeIndexAt(addresses, am)];
  if (node.text !== undefined && map.amToWg[am] >= node.text)
    ancestry.unshift({
      type: PagesUnknownBlock.name,
      attrs: storedAttrs(opening.get(node.at).attrs),
    });
  return ancestry;
}

const storedAttrs = (attrs = {}) =>
  Object.fromEntries(
    Object.keys(attrs)
      .sort()
      .map((key) => [key, A.isImmutableString(attrs[key]) ? String(attrs[key]) : attrs[key]]),
  );
