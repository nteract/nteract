// What agents are told about rich content. The MCP server instructions, the
// create_page/edit_page markdown description and /llms.txt all read this
// module, so an agent learns about every mark, block and diagram language the
// editor offers people. The lists derive from marks.json, features.json and
// shared/code-languages.mjs; rich-content-guide.test.mjs fails when one of
// them gains an entry this module can't describe.
import featureFile from "./features.json" with { type: "json" };
import { HIGHLIGHT_COLORS, MARK_REGISTRY } from "./marks.mjs";
import { CODE_LANGUAGES, DIAGRAM_LANGUAGE } from "../shared/code-languages.mjs";

/** Markdown for each inline mark in marks.json. */
export const MARK_SYNTAX = Object.freeze({
  link: "[text](url)",
  em: "*italic*",
  strong: "**bold**",
  strike: "~~strike~~",
  highlight: '<mark data-color="yellow">highlight</mark>',
  code: "`code`",
});

/** Markdown for each block type, in reading order. Every block a features.json
 * feature lists needs an entry. */
export const BLOCK_SYNTAX = Object.freeze([
  ["heading", "# … ###### headings"],
  ["unordered-list-item", "- bulleted lists"],
  ["ordered-list-item", "1. numbered lists"],
  ["task-list-item", "- [ ] / - [x] task lists"],
  ["blockquote", "> quotes"],
  ["table", "pipe tables (the first row is the header; |:---:| aligns a column)"],
  ["horizontal-rule", "--- rules"],
  ["code-block", "fenced code blocks with a language"],
]);

/** Block types with no Markdown form, and the node operation that writes
 * each. A feature block needs an entry here or in BLOCK_SYNTAX. */
export const NODE_OPERATIONS = Object.freeze([
  [
    "dataframe",
    'insert_node with node {type: "dataframe", attrs: {asset_id, title}} shows an uploaded Parquet dataset as a table',
  ],
]);

const markNames = (marks = MARK_REGISTRY) => marks.marks.map((mark) => mark.name);

/** Throws when a registry entry has no agent write path here: Markdown syntax,
 * or for a block, a node operation. Runs at import, so a new mark or feature
 * block can't ship without agent guidance. */
export function checkCoverage(marks = MARK_REGISTRY, features = featureFile) {
  const unmarked = markNames(marks).filter((name) => !Object.hasOwn(MARK_SYNTAX, name));
  if (unmarked.length) throw Error(`No agent syntax for marks: ${unmarked.join(", ")}`);
  const known = new Set([...BLOCK_SYNTAX, ...NODE_OPERATIONS].map(([type]) => type));
  const blocks = features.features
    .flatMap((feature) => feature.blocks ?? [])
    .filter((type) => !known.has(type));
  if (blocks.length) throw Error(`No agent write path for blocks: ${blocks.join(", ")}`);
}
checkCoverage();

const inlineList = () => markNames().map((name) => MARK_SYNTAX[name]);
const blockList = () => BLOCK_SYNTAX.map(([, syntax]) => syntax);
const join = (items) => `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const diagram = `A \`\`\`${DIAGRAM_LANGUAGE} code block renders as a diagram for people (its language must be exactly ${DIAGRAM_LANGUAGE})`;

/** The Markdown Pages accepts, in one sentence. */
export function markdownSyntax() {
  return `Pages stores Markdown as native rich text: ${join(inlineList())}; ${join(blockList())}. Highlight colors are ${HIGHLIGHT_COLORS.join(", ")} or #rrggbb. ${diagram}. Math ($…$) and raw HTML are refused with unsupported_markdown; escape a literal $ or < with a backslash.`;
}

/** The targeted rich-text operations, in one paragraph. */
export function richEditOperations() {
  return "To change existing content without rewriting it, use patch_page: format_match adds or removes formatting on matched text (occurrence:n picks one match, all:true formats every match in the block); replace_match with replacement_markdown rewrites text with inline formatting; set_node (experimental) checks a task, sets a code block's language, changes a heading level or aligns a table column.";
}

/** The rich-content paragraph for the MCP server instructions. */
export function richContentInstructions(origin) {
  return `${markdownSyntax()} ${richEditOperations()} Full guide: ${origin}/llms.txt.`;
}

/** The rich-content section of /llms.txt. */
export function richContentGuide() {
  return `## Rich content

${markdownSyntax()}

Code block languages in the editor's menu: ${CODE_LANGUAGES.join(", ")}. Other
languages are stored as written. A known language gets syntax highlighting.
Mermaid diagrams render from the code block's source when people view the
Page; the rendered SVG is never stored. Upload images to the Page and place
them with insert_image (see Images below).

Pages stores native nodes, not Markdown. Each paragraph, heading, list item,
code block, table cell, image and dataframe is a node with typed attributes,
and formatting is a native mark on its characters. Markdown is one way to read
and write them; node operations (insert_image, insert_node, set_node) are the
other. Some nodes have no Markdown form: ${NODE_OPERATIONS.map(([, text]) => text).join("; ")}
(see Datasets below). They read back as a labeled link on its own line;
replace_block_markdown keeps the node when that line is unchanged and refuses
a rewrite that drops or edits it.
${richEditOperations()}
These operations keep comment anchors and untouched characters in place, so
prefer them to replace_block_markdown for small changes.
`;
}
