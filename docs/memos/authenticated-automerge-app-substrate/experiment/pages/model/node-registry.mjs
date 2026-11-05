// The block types a Page's rich text can hold, declared once.
//
// Plain data with no ProseMirror or Wordgard import, so the Worker, the viewer
// and the agent guidance can all read it. Each entry names a stored block
// marker type and what every layer needs to know about it:
//
// - `block`: the Automerge block marker type, as stored.
// - `pm`: the ProseMirror node in model/pm-adapter.mjs. `wrapper` names the list
//   node a list item sits in; the wrapper has no marker of its own.
// - `kind`:
//     text            holds inline content (paragraph, heading)
//     text-container  holds only text and line breaks, so a block inside one
//                     can't be drawn where it was stored (code block, cell)
//     container       holds blocks (quote, aside, list item, table, row)
//     leaf            a block with no content (rule, dataframe)
//     embed           an inline marker (image, hard break)
// - `governsFirstParagraph`: the container's own marker governs its first
//   paragraph, which has no marker of its own (model/set-node.mjs). True for
//   quotes, asides and list items; a list item's label already names the item,
//   a quote's says "first paragraph".
// - `feature`: the model/features.json feature that gates it, or null.
// - `readOnly`: no writer creates it (preserved Markdown).
// - `label` / `plural`: how a refusal names a node, or several, of this type.
// - `retype`: set_node may change a node between types that share this group
//   (a paragraph and a heading).
// - `attrs`: stored attribute name → { type, values | min/max, agent, set,
//   scope, nullable }. `agent` is the name agents read and write when it
//   differs from the stored one; `set` names the operation that may change
//   it; `scope: "column"` applies the change to the whole table column;
//   `nullable` lets null clear it.
// - `insert`: how agents create it, and which stored asset it names, so the
//   host can check the asset before the change (worker/index.mjs prepare).
//
// Agent-facing names are the same everywhere: a node's `type` is its stored
// block name (`code-block`), and its attrs are the `agent` names. read_page
// reports them, set_node and insert_node take them.
//
// node-registry.test.mjs checks the entries against the ProseMirror adapter,
// features.json and the Wordgard model, so a new type can't be added in one
// place only.

export const ALIGNMENTS = Object.freeze(["left", "center", "right"]);
export const HEADING_LEVELS = Object.freeze({ min: 1, max: 6 });

const entry = (block, fields) =>
  Object.freeze({
    block,
    wrapper: null,
    retype: null,
    plural: null,
    governsFirstParagraph: false,
    feature: null,
    readOnly: false,
    attrs: Object.freeze({}),
    insert: null,
    ...fields,
  });

export const NODE_TYPES = Object.freeze([
  entry("paragraph", {
    pm: "paragraph",
    kind: "text",
    retype: "text",
    label: "a paragraph",
    plural: "paragraphs",
  }),
  entry("heading", {
    pm: "heading",
    kind: "text",
    retype: "text",
    label: "a heading",
    plural: "headings",
    attrs: Object.freeze({
      level: { type: "integer", ...HEADING_LEVELS, set: "set_node", required: true },
    }),
  }),
  entry("code-block", {
    pm: "code_block",
    kind: "text-container",
    label: "a code block",
    plural: "code blocks",
    attrs: Object.freeze({ params: { type: "language", agent: "language", set: "set_node" } }),
  }),
  entry("blockquote", {
    pm: "blockquote",
    kind: "container",
    governsFirstParagraph: true,
    label: "a quote's first paragraph",
  }),
  entry("aside", {
    pm: "aside",
    kind: "container",
    governsFirstParagraph: true,
    label: "an aside's first paragraph",
  }),
  entry("unordered-list-item", {
    pm: "list_item",
    governsFirstParagraph: true,
    wrapper: "bullet_list",
    kind: "container",
    label: "a bulleted list item",
  }),
  entry("ordered-list-item", {
    pm: "list_item",
    governsFirstParagraph: true,
    wrapper: "ordered_list",
    kind: "container",
    label: "a numbered list item",
  }),
  entry("task-list-item", {
    pm: "list_item",
    governsFirstParagraph: true,
    wrapper: "task_list",
    kind: "container",
    label: "a task list item",
    plural: "task list items",
    attrs: Object.freeze({ checked: { type: "boolean", set: "set_node" } }),
  }),
  entry("table", { pm: "table", kind: "container", label: "a table" }),
  entry("table-row", { pm: "table_row", kind: "container", label: "a table row" }),
  entry("table-cell", {
    pm: "table_cell",
    kind: "text-container",
    label: "a table cell",
    plural: "table cells",
    attrs: Object.freeze({
      align: { type: "enum", values: ALIGNMENTS, nullable: true, scope: "column", set: "set_node" },
    }),
  }),
  entry("table-header", {
    pm: "table_header",
    kind: "text-container",
    label: "a table header cell",
    plural: "table cells",
    attrs: Object.freeze({
      align: { type: "enum", values: ALIGNMENTS, nullable: true, scope: "column", set: "set_node" },
    }),
  }),
  entry("horizontal-rule", {
    pm: "horizontal_rule",
    kind: "leaf",
    feature: "horizontal-rule",
    label: "a horizontal rule",
  }),
  entry("image", {
    pm: "image",
    kind: "embed",
    label: "an image",
    attrs: Object.freeze({
      src: { type: "string", agent: "asset_id" },
      alt: { type: "string" },
      title: { type: "string" },
    }),
    insert: Object.freeze({ op: "insert_image", asset: "image" }),
  }),
  entry("hard-break", { pm: "hard_break", kind: "embed", label: "a line break" }),
  entry("pages-opaque", {
    pm: "raw",
    kind: "leaf",
    readOnly: true,
    label: "preserved Markdown",
  }),
  entry("dataframe", {
    pm: "dataframe",
    kind: "leaf",
    feature: "dataframe",
    label: "a dataframe",
    attrs: Object.freeze({
      src: { type: "string", agent: "asset_id" },
      media_type: { type: "string" },
      title: { type: "string" },
    }),
    insert: Object.freeze({ op: "insert_node", asset: "dataset" }),
  }),
]);

const BY_BLOCK = new Map(NODE_TYPES.map((type) => [type.block, type]));

/** The registry entry for a stored block marker type, or undefined. */
export const nodeType = (block) => BY_BLOCK.get(String(block));

/** Whether this build knows a stored block marker type. */
export const isKnownBlock = (block) => BY_BLOCK.has(String(block));

/** Marker types whose content is only text and line breaks. */
export const TEXT_CONTAINERS = Object.freeze(
  new Set(NODE_TYPES.filter((type) => type.kind === "text-container").map((type) => type.block)),
);

/** How a refusal names a node of `block`'s type. */
export const nodeLabel = (block) => nodeType(block)?.label ?? `a ${block} node`;

/** Whether `level` is a heading level the schema accepts. */
export const validHeadingLevel = (level) =>
  Number.isInteger(level) && level >= HEADING_LEVELS.min && level <= HEADING_LEVELS.max;

/** Whether `value` is a stored table alignment (null clears it). */
export const validAlignment = (value) => ALIGNMENTS.includes(value);

/** Each node-creating operation and the stored asset kind it names. */
export const INSERT_OPERATIONS = Object.freeze(
  Object.fromEntries(
    NODE_TYPES.filter((type) => type.insert).map((type) => [
      type.insert.op,
      { block: type.block, asset: type.insert.asset },
    ]),
  ),
);

/** The node-creating operation `name`, as `{ block, asset }`, or undefined.
 * Own keys only, so an op named `constructor` or `__proto__` isn't one. */
export const insertOperation = (name) =>
  typeof name === "string" && Object.hasOwn(INSERT_OPERATIONS, name)
    ? INSERT_OPERATIONS[name]
    : undefined;

/** Agent-facing names of the list nodes that wrap list items. A wrapper has
 * no marker of its own; read_page reports the list under this name. */
export const LIST_TYPES = Object.freeze({
  bullet_list: "bullet-list",
  ordered_list: "ordered-list",
  task_list: "task-list",
});
const BY_PM = new Map(NODE_TYPES.filter((type) => !type.wrapper).map((type) => [type.pm, type]));

/** The agent-facing type of a ProseMirror node: its stored block name, a list
 * name, or `unknown` for a node this build doesn't know. */
export function agentType(pmName) {
  if (pmName === "unknownBlock" || pmName === "unknownLeaf") return "unknown";
  return LIST_TYPES[pmName] ?? BY_PM.get(pmName)?.block ?? pmName;
}

/** Every attribute set_node may change, by agent name: its spec and the block
 * types that hold it. One name has one spec across types. */
export const SETTABLE_ATTRS = Object.freeze(
  (() => {
    const out = {};
    for (const type of NODE_TYPES)
      for (const [stored, spec] of Object.entries(type.attrs)) {
        if (spec.set !== "set_node") continue;
        const name = spec.agent ?? stored;
        out[name] ??= { spec, stored, blocks: [] };
        out[name].blocks.push(type.block);
      }
    for (const value of Object.values(out)) Object.freeze(value.blocks);
    return out;
  })(),
);

/** The settable attribute `name` on `block`, as `{ stored, spec }`, or
 * undefined. */
export function settableAttr(block, name) {
  const type = nodeType(block);
  if (!type) return undefined;
  for (const [stored, spec] of Object.entries(type.attrs))
    if (spec.set === "set_node" && (spec.agent ?? stored) === name) return { stored, spec };
  return undefined;
}

/** "task list items", "paragraphs and headings": how a refusal names a set of
 * block types. */
export function pluralLabel(blocks) {
  const names = [...new Set(blocks.map((block) => nodeType(block)?.plural ?? `${block} nodes`))];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

/** Block types a node of `block`'s type may become through set_node. */
export const retypeTargets = (block) => {
  const group = nodeType(block)?.retype;
  return group ? NODE_TYPES.filter((type) => type.retype === group).map((type) => type.block) : [];
};
