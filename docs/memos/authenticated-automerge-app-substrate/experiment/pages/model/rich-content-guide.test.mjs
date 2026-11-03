import test from "node:test";
import assert from "node:assert/strict";
import featureFile from "./features.json" with { type: "json" };
import { MARK_REGISTRY } from "./marks.mjs";
import {
  BLOCK_SYNTAX,
  MARK_SYNTAX,
  NODE_OPERATIONS,
  checkCoverage,
  markdownSyntax,
  richContentGuide,
  richContentInstructions,
} from "./rich-content-guide.mjs";
import { CODE_LANGUAGES } from "../shared/code-languages.mjs";
import { tools } from "../mcp.mjs";
import { agentGuide } from "../agent-guide.mjs";

test("a new mark or feature block can't ship without an agent write path", () => {
  assert.doesNotThrow(() => checkCoverage());
  const marks = {
    ...MARK_REGISTRY,
    marks: [...MARK_REGISTRY.marks, { name: "underline", value: { type: "flag" } }],
  };
  assert.throws(() => checkCoverage(marks), /No agent syntax for marks: underline/);
  const features = {
    ...featureFile,
    features: [...featureFile.features, { id: "callout", description: "x", blocks: ["callout"] }],
  };
  assert.throws(
    () => checkCoverage(MARK_REGISTRY, features),
    /No agent write path for blocks: callout/,
  );
});

test("a block with no Markdown form is covered by its node operation", () => {
  assert.ok(featureFile.features.some((feature) => feature.blocks?.includes("dataframe")));
  assert.equal(
    BLOCK_SYNTAX.some(([type]) => type === "dataframe"),
    false,
  );
  assert.ok(NODE_OPERATIONS.some(([type]) => type === "dataframe"));
  assert.match(richContentGuide(), /insert_node with node \{type: "dataframe"/);
});

const editOps = ["format_match", "occurrence", "all:true", "replacement_markdown", "set_node"];

test("every surface an MCP agent reads names the rich content people get", () => {
  const syntax = [...Object.values(MARK_SYNTAX), ...BLOCK_SYNTAX.map(([, text]) => text)];
  const markdown = tools.find((tool) => tool.name === "create_page").inputSchema.properties.markdown
    .description;
  const instructions = richContentInstructions("https://pages.example");
  for (const [name, text] of [
    ["create_page markdown", markdown],
    ["server instructions", instructions],
  ]) {
    for (const piece of syntax) assert.ok(text.includes(piece), `${name} lacks ${piece}`);
    assert.match(text, /```mermaid code block renders as a diagram/, name);
    assert.match(text, /unsupported_markdown/, name);
  }
  for (const op of editOps) assert.ok(instructions.includes(op), `instructions lack ${op}`);
  assert.ok(instructions.endsWith("https://pages.example/llms.txt."));
  assert.equal(markdown.includes(markdownSyntax()), true);
});

test("patch_page advertises set_node, occurrence, all and replacement_markdown", () => {
  const patch = tools.find((tool) => tool.name === "patch_page");
  const [replace, format, setNode] = patch.inputSchema.properties.operations.items.oneOf;
  assert.deepEqual(
    [replace, format, setNode].map((op) => op.properties.op.const),
    ["replace_match", "format_match", "set_node"],
  );
  assert.ok(replace.properties.replacement_markdown);
  assert.deepEqual(replace.required, ["op", "block_id", "match_text"]);
  for (const op of [replace, format, setNode]) assert.ok(op.properties.occurrence);
  assert.deepEqual(format.properties.all, { ...format.properties.all, const: true });
  assert.deepEqual(Object.keys(setNode.properties).slice(-4), [
    "checked",
    "language",
    "heading_level",
    "align",
  ]);
  assert.match(patch.description, /set_node/);
  // Agents learn the {type, attrs} shape; the flat fields are deprecated aliases.
  assert.match(patch.description, /type heading, attrs \{level\}/);
  for (const field of ["heading_level", "(checked)", "(language", "(align)"])
    assert.equal(patch.description.includes(field), false, `patch_page teaches ${field}`);
});

test("edit_page takes delete_node by node_id, and the guides say where the id comes from", async () => {
  const editPage = tools.find((tool) => tool.name === "edit_page");
  const deleteNode = editPage.inputSchema.properties.operations.items.oneOf.find(
    (variant) => variant.properties.op.const === "delete_node",
  );
  assert.deepEqual(deleteNode.required, ["op", "block_id", "node_id"]);
  assert.equal(deleteNode.additionalProperties, false);
  assert.match(editPage.description, /delete_node removes one top-level node/);
  const { typedReadFields } = await import("./rich-content-guide.mjs");
  assert.match(typedReadFields(), /node_id names a top-level node/);
  const guide = agentGuide({ NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" });
  assert.match(guide, /- node_not_found:/);
  assert.match(guide, /delete_node it by its node_id/);
});

test("the typed-field guide names every agent type a read can report", async () => {
  const { typedReadFields } = await import("./rich-content-guide.mjs");
  const { LIST_TYPES } = await import("./node-registry.mjs");
  const text = typedReadFields();
  for (const name of [...Object.values(LIST_TYPES), "pages-opaque", "unknown", "code-block"])
    assert.ok(text.includes(name), `typedReadFields lacks ${name}`);
});

test("/llms.txt has the rich content section with the language menu", () => {
  const guide = agentGuide({ NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" });
  assert.ok(guide.includes(richContentGuide()));
  for (const language of CODE_LANGUAGES) assert.ok(guide.includes(language), language);
  for (const op of editOps) assert.ok(guide.includes(op), op);
  assert.match(guide, /"op": "set_node".*"checked": true/);
});
