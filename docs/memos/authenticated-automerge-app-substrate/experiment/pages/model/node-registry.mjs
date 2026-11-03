// The block types a Page's rich text can hold, declared once.
//
// Plain data with no ProseMirror or Wordgard import, so the Worker, the viewer
// and the agent guidance can all read it. Each entry names a stored block
// marker type and what every layer needs to know about it:
//
// - `block`: the Automerge block marker type, as stored.
// - `pm`: the ProseMirror node in model/richtext.mjs. `wrapper` names the list
//   node a list item sits in; the wrapper has no marker of its own.
// - `kind`:
//     text            holds inline content (paragraph, heading)
//     text-container  holds only text and line breaks, so a block inside one
//                     can't be drawn where it was stored (code block, cell)
//     container       holds blocks (quote, aside, list item, table, row)
//     leaf            a block with no content (rule, dataframe)
//     embed           an inline marker (image, hard break)
// - `governsFirstParagraph`: the container's own marker governs its first
//   paragraph, which has no marker (model/set-node.mjs).
// - `feature`: the model/features.json feature that gates it, or null.
// - `readOnly`: no writer creates it (preserved Markdown).
// - `label`: how a refusal names a node of this type.
// - `attrs`: stored attribute name → { type, values | min/max, agent, set }.
//     `agent` is the name agents read and write when it differs; `set` names
//     the operation that may change it.
// - `insert`: how agents create it, and which stored asset it names, so the
//   host can check the asset before the change (worker/index.mjs prepare).
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
    governsFirstParagraph: false,
    feature: null,
    readOnly: false,
    attrs: Object.freeze({}),
    insert: null,
    ...fields,
  });

export const NODE_TYPES = Object.freeze([
  entry("paragraph", { pm: "paragraph", kind: "text", label: "a paragraph" }),
  entry("heading", {
    pm: "heading",
    kind: "text",
    label: "a heading",
    attrs: Object.freeze({
      level: { type: "integer", ...HEADING_LEVELS, agent: "heading_level", set: "set_node" },
    }),
  }),
  entry("code-block", {
    pm: "code_block",
    kind: "text-container",
    label: "a code block",
    attrs: Object.freeze({ params: { type: "string", agent: "language", set: "set_node" } }),
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
    wrapper: "bullet_list",
    kind: "container",
    label: "a bulleted list item",
  }),
  entry("ordered-list-item", {
    pm: "list_item",
    wrapper: "ordered_list",
    kind: "container",
    label: "a numbered list item",
  }),
  entry("task-list-item", {
    pm: "list_item",
    wrapper: "task_list",
    kind: "container",
    label: "a task list item",
    attrs: Object.freeze({ checked: { type: "boolean", set: "set_node" } }),
  }),
  entry("table", { pm: "table", kind: "container", label: "a table" }),
  entry("table-row", { pm: "table_row", kind: "container", label: "a table row" }),
  entry("table-cell", {
    pm: "table_cell",
    kind: "text-container",
    label: "a table cell",
    attrs: Object.freeze({ align: { type: "enum", values: ALIGNMENTS, set: "set_node" } }),
  }),
  entry("table-header", {
    pm: "table_header",
    kind: "text-container",
    label: "a table header cell",
    attrs: Object.freeze({ align: { type: "enum", values: ALIGNMENTS, set: "set_node" } }),
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
