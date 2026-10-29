import { orderedBlockIds } from "./order.mjs";
import {
  exportMarkdown,
  isRich,
  parseMarkdown,
  projectedBlock,
  richDoc,
  schema,
} from "./richtext.mjs";

const utf8 = new TextEncoder();
const fail = (status, code, message, details) => {
  throw Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
};
const invalid = (message) => fail(400, "invalid_read_selector", message);
const missing = (message) => fail(404, "read_target_not_found", message);
const boundedString = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function validateSelectors(doc, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    invalid("Read arguments must be an object");
  if (args.include_content !== undefined && typeof args.include_content !== "boolean")
    invalid("include_content must be a boolean");
  const modes = ["section", "search", "node_range"].filter((key) => args[key] !== undefined);
  if (modes.length > 1) invalid("Use only one of section, search, or node_range");
  if (args.block_ids !== undefined) {
    if (
      !Array.isArray(args.block_ids) ||
      args.block_ids.length < 1 ||
      args.block_ids.length > 100 ||
      args.block_ids.some((id) => !boundedString(id, 128)) ||
      new Set(args.block_ids).size !== args.block_ids.length
    )
      invalid("block_ids must contain 1 to 100 unique block IDs of up to 128 characters");
    if (args.node_range !== undefined) invalid("node_range cannot be combined with block_ids");
  }
  if (args.section !== undefined && !boundedString(args.section, 1024))
    invalid("section must be a nonempty heading text of up to 1024 characters");
  if (
    args.section_occurrence !== undefined &&
    (args.section === undefined ||
      !Number.isSafeInteger(args.section_occurrence) ||
      args.section_occurrence < 1)
  )
    invalid("section_occurrence requires section and a positive one-based integer");
  if (
    args.search !== undefined &&
    (!Array.isArray(args.search) ||
      args.search.length < 1 ||
      args.search.length > 8 ||
      args.search.some((term) => !boundedString(term, 512)))
  )
    invalid("search must contain 1 to 8 nonempty literal strings of up to 512 characters");
  if (
    args.context_nodes !== undefined &&
    (args.search === undefined ||
      !Number.isInteger(args.context_nodes) ||
      args.context_nodes < 0 ||
      args.context_nodes > 2)
  )
    invalid("context_nodes requires search and an integer from 0 to 2");
  if (args.node_range !== undefined) {
    const range = args.node_range;
    if (
      !range ||
      typeof range !== "object" ||
      Array.isArray(range) ||
      Object.keys(range).some((key) => !["block_id", "from", "to"].includes(key)) ||
      !boundedString(range.block_id, 128) ||
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from < 0 ||
      range.to <= range.from
    )
      invalid("node_range requires block_id and zero-based integers 0 <= from < to");
  }
  for (const id of args.block_ids ?? [])
    if (!Object.hasOwn(doc.blocks ?? {}, id)) missing(`Block not found: ${id}`);
  if (args.node_range && !Object.hasOwn(doc.blocks ?? {}, args.node_range.block_id))
    missing(`Block not found: ${args.node_range.block_id}`);
}

function visibleText(node) {
  if (node.type.name === "raw") return node.attrs.source;
  if (node.type.name === "image") return node.attrs.alt ?? "";
  if (node.type.name === "hard_break") return "\n";
  if (node.isText) return node.text;
  const parts = [];
  node.forEach((child) => parts.push(visibleText(child)));
  return parts.join(node.inlineContent ? "" : "\n");
}

const markdownFor = (nodes) => exportMarkdown(schema.node("doc", null, nodes));

// Addresses refer to top-level rich-text nodes in this captured document version.
// Lists, tables, and other containers stay intact; these are not stable node IDs.
function indexNodes(doc) {
  const nodes = [],
    trees = new Map(),
    headings = [];
  for (const blockId of orderedBlockIds(doc)) {
    const block = doc.blocks[blockId],
      tree = isRich(block)
        ? richDoc(block)
        : parseMarkdown(block.markdown ?? "", blockId, block.kind ?? "markdown");
    trees.set(blockId, tree);
    tree.forEach((node, _offset, nodeIndex) => {
      const entry = { blockId, nodeIndex, node };
      if (node.type.name === "heading") {
        entry.heading = visibleText(node);
        entry.level = node.attrs.level;
        while (headings.length && headings.at(-1).level >= entry.level) headings.pop();
        headings.push(entry);
      }
      entry.headingPath = headings.map((heading) => heading.heading);
      nodes.push(entry);
    });
  }
  return { nodes, trees };
}

function outlineEntry(entry) {
  return {
    block_id: entry.blockId,
    node_index: entry.nodeIndex,
    type: entry.node.type.name,
    heading_path: entry.headingPath,
    // Bytes of this node's standalone Markdown projection, excluding inter-node separators.
    markdown_bytes: utf8.encode(markdownFor([entry.node])).byteLength,
    ...(entry.heading !== undefined ? { heading: entry.heading, level: entry.level } : {}),
  };
}

function selectedNodes(nodes, trees, args, inScope) {
  if (args.section !== undefined) {
    const candidates = nodes.filter((entry) => inScope(entry) && entry.heading === args.section);
    if (!candidates.length) missing("Section heading not found");
    if (candidates.length > 1 && args.section_occurrence === undefined)
      fail(
        409,
        "ambiguous_section",
        "Section heading occurs more than once; choose section_occurrence",
        {
          total: candidates.length,
          candidates: candidates.slice(0, 20).map((entry) => ({
            block_id: entry.blockId,
            node_index: entry.nodeIndex,
            level: entry.level,
          })),
        },
      );
    const occurrence = args.section_occurrence ?? 1,
      start = candidates[occurrence - 1];
    if (!start) missing("Section occurrence not found");
    const from = nodes.indexOf(start);
    let to = from + 1;
    while (to < nodes.length && !(nodes[to].level <= start.level)) to++;
    return {
      nodes: nodes.slice(from, to).filter(inScope),
      selection: { type: "section", section: args.section, section_occurrence: occurrence },
    };
  }
  if (args.search !== undefined) {
    const context = args.context_nodes ?? 1,
      included = new Set();
    let matched = 0;
    nodes.forEach((entry, index) => {
      if (!inScope(entry)) return;
      const text = visibleText(entry.node);
      if (!args.search.some((term) => text.includes(term))) return;
      matched++;
      for (
        let i = Math.max(0, index - context);
        i <= Math.min(nodes.length - 1, index + context);
        i++
      )
        if (inScope(nodes[i])) included.add(nodes[i]);
    });
    return {
      nodes: nodes.filter((entry) => included.has(entry)),
      selection: {
        type: "search",
        search: [...args.search],
        context_nodes: context,
        matched_nodes: matched,
      },
    };
  }
  const range = args.node_range;
  if (range) {
    if (range.to > trees.get(range.block_id).childCount)
      missing("node_range exceeds this block's top-level nodes");
    return {
      nodes: nodes.filter(
        (entry) =>
          entry.blockId === range.block_id &&
          entry.nodeIndex >= range.from &&
          entry.nodeIndex < range.to,
      ),
      selection: { type: "node_range", ...range },
    };
  }
  return { nodes: nodes.filter(inScope) };
}

function projectedSlices(doc, nodes) {
  const slices = [];
  for (const entry of nodes) {
    const prior = slices.at(-1);
    if (prior?.blockId === entry.blockId && prior.to === entry.nodeIndex) {
      prior.to++;
      prior.nodes.push(entry.node);
    } else
      slices.push({
        blockId: entry.blockId,
        from: entry.nodeIndex,
        to: entry.nodeIndex + 1,
        nodes: [entry.node],
      });
  }
  return slices.map(({ blockId, from, to, nodes: slice }) => {
    const { richText: _rich, ...block } = doc.blocks[blockId];
    return {
      ...block,
      markdown: markdownFor(slice),
      partial: true,
      node_range: { block_id: blockId, from, to },
    };
  });
}

/** Pure projection of one captured Automerge document. The caller binds the
 * response to its heads and enforces response/outline budgets. No bytes are
 * silently omitted here. Wrapper-only options are deliberately ignored.
 */
export function projectReadContent(doc, args = {}) {
  validateSelectors(doc, args);
  const { nodes, trees } = indexNodes(doc),
    ids = args.block_ids ? new Set(args.block_ids) : null,
    inScope = (entry) => !ids || ids.has(entry.blockId),
    chosen = selectedNodes(nodes, trees, args, inScope),
    outline = nodes.filter(inScope).map(outlineEntry),
    orderedIds = [...trees.keys()].filter((id) => !ids || ids.has(id));
  return {
    blocks:
      args.include_content === false
        ? []
        : chosen.selection
          ? projectedSlices(doc, chosen.nodes)
          : orderedIds.map((id) => projectedBlock(doc.blocks[id])),
    outline,
    ...(chosen.selection
      ? { selection: chosen.selection }
      : ids
        ? { selection: { type: "blocks", block_ids: orderedIds } }
        : {}),
  };
}
