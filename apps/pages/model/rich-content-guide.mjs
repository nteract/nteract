// What agents are told about rich content. The MCP server instructions read
// markdownRules(); /llms.txt reads the full guide in this
// module, so an agent learns about every mark, block and diagram language the
// editor offers people. The lists derive from marks.json, features.json and
// shared/code-languages.mjs; rich-content-guide.test.mjs fails when one of
// them gains an entry this module can't describe.
import featureFile from "./features.json" with { type: "json" };
import { HIGHLIGHT_COLORS, MARK_REGISTRY } from "./marks.mjs";
import { CODE_LANGUAGES, DIAGRAM_LANGUAGE } from "../shared/code-languages.mjs";
import { OUTLINE_MAX_ITEMS } from "./read-content.mjs";

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

/** How to link to a heading (model/heading-anchors.mjs), in one sentence. */
export function headingLinks() {
  return "Link to a heading with [text](#anchor), using the anchor read_page's outline reports for it, or [text](/p/<page_id>#anchor) for a heading on another Page; people go straight to it.";
}

/** How to link another Page or a Project (viewer/page-chits.mjs), in a few
 * sentences. A bare link, whose text is its URL, draws for each person as a
 * chit with the target's current title; a label freezes one title for
 * everyone. */
export function pageLinks() {
  return "To link another Page or a Project, write its full URL as an autolink, <https://…/p/<page_id>> or <https://…/project/<project_id>>: each person sees it as a chip with the title they can see now, or Page unavailable, so a rename never leaves it stale. Write [label](url) only when the sentence needs other words, and don't turn an autolink into [Title](url). Its stored text is the URL, so match_text and selected_text use the URL, not the title people see.";
}

/** The Markdown Pages accepts, in a few sentences. */
export function markdownSyntax() {
  return `Pages stores Markdown as native rich text: ${join(inlineList())}; ${join(blockList())}. Highlight colors are ${HIGHLIGHT_COLORS.join(", ")} or #rrggbb. ${diagram}. ${headingLinks()} ${pageLinks()} Math ($…$) and raw HTML are refused with unsupported_markdown; escape a literal $ or < with a backslash.`;
}

/** Where Pages Markdown differs from what an agent already writes, in a few
 * sentences. The MCP server instructions carry this; the full syntax list
 * stays in /llms.txt. */
export function markdownRules() {
  return `Write ordinary Markdown; Pages stores it as native rich text. Pages-specific: highlights are ${MARK_SYNTAX.highlight} (${HIGHLIGHT_COLORS.join(", ")} or #rrggbb). ${diagram}. ${headingLinks()} ${pageLinks()} Math ($…$) and raw HTML are refused with unsupported_markdown; escape a literal $ or < with a backslash.`;
}

/** The typed fields read_page's outline entries and read_page_changes'
 * changed nodes carry, in one paragraph. Every description of them reads this
 * function, so they can't disagree. */
export function typedReadFields() {
  return `read_page's outline entries and read_page_changes' changed nodes carry typed fields beside the Markdown. node_id names a top-level node for as long as it exists: it stays the same while the node's text, marks and attributes change and nodes are added or removed around it, unlike node_index. It is null for every node of a block holding a node this version can't place, and for a paragraph of unmarked text: text a merge left with no marker of its own, as when one person deletes a paragraph while another types into it. Text-matching operations still reach such a paragraph, and any edit_page or patch_page write to its block gives it a node_id. A list has no marker of its own, so its id is its first item's: when that item goes (deleted or moved, or a replace_block_markdown rewrite replaces it), the list gets a new id. A quote has its own marker. If a peer types into a node while it's deleted, the new characters survive at the end of the node before it. node_id is meaningful only with its block_id. Their type is the name set_node and insert_node take: the stored block name (code-block, heading, dataframe), bullet-list, ordered-list or task-list for a list, and unknown for a node this version doesn't know, including a pages-opaque block an older build stored. attrs holds a node's own stored attributes under the names set_node and insert_node take: {level} for a heading, {language} for a code block, {asset_id, src, media_type, title} for a dataframe on this Page. summary holds values computed from a node's children: {items, checked_count, checked} for a task list (one boolean per direct item) and {rows, columns, align} for a table (rows counts the header row, columns is the widest row, align has one entry per column). An outline lists at most ${OUTLINE_MAX_ITEMS} values in checked or align, with checked_truncated or align_truncated past that; read_page_changes lists all of them, and they count toward its max_bytes. A dataframe this version can't show, such as one naming another Page's asset, reads as an [Unsupported node: dataframe] paragraph with none of its stored values, and a node this version doesn't know carries node_type.`;
}

/** The targeted rich-text operations, in one paragraph. */
export function richEditOperations() {
  return "To change existing content without rewriting it, use patch_page: format_match adds or removes formatting on matched text (occurrence:n picks one match, all:true formats every match in the block); replace_match with replacement_markdown rewrites text with inline formatting; set_node takes {type, attrs} with the names read_page reports: it checks a task (attrs.checked), sets a code block's language (attrs.language), makes a paragraph a heading or changes its level (type heading, attrs.level) or aligns a table column (attrs.align). edit_page's delete_node removes one top-level node by its node_id, including a node with no text, such as a rule or a dataframe.";
}

/** The rich-content paragraph for the MCP server instructions. */
export function richContentInstructions(origin) {
  return `${markdownRules()} Full guide, including typed read fields and node operations: ${origin}/llms.txt.`;
}

/** The rich-content section of /llms.txt. */
export function richContentGuide() {
  return `## Rich content

${markdownSyntax()}

Code block languages in the editor's menu: ${CODE_LANGUAGES.join(", ")}. Other
languages are stored as written. A known language gets syntax highlighting.
Mermaid diagrams render from the code block's source when people view the
Page; the rendered SVG is never stored. Upload images to the Page and place
them with insert_image (see Images below). Its optional dark_asset_id names
a second image uploaded to the same Page. summary.images includes bounded
src, dark_src, asset_id, dark_asset_id, alt, title and live image_id facts;
images_truncated or truncated explicitly signals omitted data. image_id names
the inline marker in its block, not the top-level node_id. Use edit_page
set_image at exact current heads to change a source or shared metadata;
dark_asset_id:null removes the alternate. Child-index paths remain revision-local.

Pages stores native nodes, not Markdown. Each paragraph, heading, list item,
code block, table cell, image and dataframe is a node with typed attributes,
and formatting is a native mark on its characters. Markdown is one way to read
and write them; node operations (insert_image, insert_node, set_node, delete_node) are the
other. Some nodes have no Markdown form: ${NODE_OPERATIONS.map(([, text]) => text).join("; ")}
(see Datasets below). They read back as a labeled link on its own line;
replace_block_markdown keeps the node when that line is unchanged and stays
where the node is stored: at the top level of the block, or inside the same kind
of quote or list item. It refuses with markdownless_node a rewrite that drops or edits the
line, takes it into or out of a quote, list, table or heading, has more copies
of it than the block has such nodes, or adds a line that reads like a node the
block doesn't hold: Markdown never creates or copies a node. Moving the line
among its neighbours keeps the node's attrs but writes it as a new node.
${typedReadFields()}
${richEditOperations()}
These operations keep comment anchors and untouched characters in place, so
prefer them to replace_block_markdown for small changes.
`;
}
