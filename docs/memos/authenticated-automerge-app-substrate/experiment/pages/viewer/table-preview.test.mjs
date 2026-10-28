import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { MarkdownParser, defaultMarkdownParser } from "prosemirror-markdown";
import {
  adapter,
  blockMarkdown,
  parseMarkdown,
  richDoc,
  RICH_FORMAT,
  schema,
  textPath,
} from "../model/richtext.mjs";
import { parseTableMarkdown } from "../model/table-markdown.mjs";
import {
  PreservedTableView,
  preservedTablePreview,
  tablePreviewFragment,
} from "./table-preview.mjs";

const table = `Before the table.\n\n| **Choice** | Value | Notes |\n| :--- | ---: | :---: |\n| *Pages* | 12 | [Details](/llms.txt) and \`code\` |\n| Notebook | 7 | Escaped \\| pipe |\n\nAfter the table.\n`;
const rawTable = (source) => schema.nodes.raw.create({ source, importId: "", kind: "markdown" });
function fixture(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://pages.example/p/one",
  });
  t.after(() => dom.window.close());
  return dom.window.document;
}

test("preserved pipe tables keep exact source through Automerge save/load", () => {
  for (const source of [table, "| Only |\n| --- |\n| Cell |\n"]) {
    const parsed = schema.node("doc", null, [rawTable(source)]);
    assert.equal(parsed.firstChild.type.name, "raw");
    assert.equal(parsed.firstChild.attrs.source, source);
    let doc = A.from({
      blocks: { one: { kind: "markdown", format: RICH_FORMAT, richText: "", markdown: source } },
    });
    doc = A.change(doc, (d) => A.updateSpans(d, textPath("one"), pmNodeToSpans(adapter, parsed)));
    const reloaded = A.load(A.save(doc));
    assert.equal(blockMarkdown(reloaded.blocks.one), source);
    assert.equal(richDoc(reloaded.blocks.one).firstChild.attrs.source, source);
  }
});

test("existing rich imports without outer pipes keep their Markdown projection", () => {
  const source = "Name | Value\n--- | ---\nPages | 1\n";
  const legacyParser = new MarkdownParser(
    schema,
    defaultMarkdownParser.tokenizer,
    defaultMarkdownParser.tokens,
  );
  let doc = A.from({
    blocks: { one: { kind: "markdown", format: RICH_FORMAT, richText: "", markdown: source } },
  });
  doc = A.change(doc, (d) =>
    A.updateSpans(
      d,
      textPath("one"),
      pmNodeToSpans(adapter, legacyParser.parse(source)),
      adapter.updateSpansConfig(),
    ),
  );
  assert.equal(parseMarkdown(source).firstChild.type.name, "table");
  const reloaded = A.load(A.save(doc));
  assert.equal(richDoc(reloaded.blocks.one).firstChild.type.name, "paragraph");
  assert.equal(blockMarkdown(reloaded.blocks.one), source);
  doc = A.change(doc, (d) =>
    A.updateSpans(
      d,
      textPath("one"),
      pmNodeToSpans(adapter, legacyParser.parse(source.replace("Pages | 1", "Pages | 2"))),
      adapter.updateSpansConfig(),
    ),
  );
  assert.match(blockMarkdown(doc.blocks.one), /Pages \| 2/);
});

test("a preview renders semantic table cells, alignment, marks, links and surrounding prose", (t) => {
  const doc = fixture(t);
  const fragment = tablePreviewFragment(table, doc);
  assert.equal(fragment.querySelectorAll("table").length, 1);
  assert.equal(fragment.querySelectorAll("thead th[scope=col]").length, 3);
  assert.equal(fragment.querySelectorAll("tbody tr").length, 2);
  assert.deepEqual(
    [...fragment.querySelectorAll("thead th")].map((el) => el.dataset.align),
    ["left", "right", "center"],
  );
  assert.equal(fragment.querySelector("th strong").textContent, "Choice");
  assert.equal(fragment.querySelector("td em").textContent, "Pages");
  assert.equal(fragment.querySelector("td code").textContent, "code");
  assert.match(fragment.textContent, /Escaped \| pipe/);
  assert.match(fragment.textContent, /Before the table/);
  assert.match(fragment.textContent, /After the table/);
  const link = fragment.querySelector("a");
  assert.equal(link.href, "https://pages.example/llms.txt");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  const region = fragment.querySelector('[role="region"]');
  assert.equal(region.getAttribute("aria-label"), "Table");
  assert.equal(region.tabIndex, 0);
});

test("HTML, executable links, style payloads and resource embeds remain inert", (t) => {
  const doc = fixture(t);
  const source = `| Payload |\n| --- |\n| <img src=x onerror=alert(1)> |\n| <script>alert(2)</script> |\n| [run](javascript:alert%281%29) |\n| [file](file:///secret) |\n| <style>body{display:none}</style> |\n| ![tracking](https://tracker.example/pixel) |\n| [safe](https://example.com) |`;
  const fragment = tablePreviewFragment(source, doc);
  assert.equal(fragment.querySelectorAll("script, img, style, iframe, svg, form, input").length, 0);
  assert.equal(fragment.querySelectorAll("[style], [onerror]").length, 0);
  assert.equal(fragment.querySelectorAll("a").length, 1);
  assert.equal(fragment.querySelector("a").href, "https://example.com/");
  assert.match(fragment.textContent, /<script>alert\(2\)<\/script>/);
  assert.match(fragment.textContent, /Image: tracking/);
});

test("non-tables and instruction blocks keep the conservative preserved-source rendering", () => {
  const plugin = preservedTablePreview();
  for (const source of [
    "A | B",
    "| A | B |\n| not a delimiter |\n| C | D |",
    "```\n| A |\n| --- |\n| B |\n```",
    "| A | B |\n| --- |\n| C | D |",
  ])
    assert.equal(parseTableMarkdown(source), null);
  const instruction = schema.nodes.raw.create({ kind: "instruction", source: table });
  assert.equal(plugin.props.nodeViews.raw(instruction), null);
  const malformed = schema.nodes.raw.create({ kind: "markdown", source: "| not a table |" });
  assert.equal(plugin.props.nodeViews.raw(malformed), null);
});

test("Source is exact, incoming updates keep the selected view, and listeners clean up", (t) => {
  const doc = fixture(t);
  const node = rawTable(table);
  const view = new PreservedTableView(node, doc);
  doc.body.append(view.dom);
  assert.equal(view.source.hidden, true);
  assert.equal(view.source.textContent, table);
  assert.equal(view.dom.contentEditable, "false");
  view.toggle.click();
  assert.equal(view.source.hidden, false);
  assert.equal(view.preview.hidden, true);
  assert.equal(view.toggle.getAttribute("aria-expanded"), "true");
  const updated = table.replace("12", "123");
  assert.equal(view.update(rawTable(updated)), true);
  assert.equal(view.source.textContent, updated);
  assert.equal(view.source.hidden, false);
  assert.equal(view.preview.querySelectorAll("tbody tr")[0].children[1].textContent, "123");
  assert.equal(view.stopEvent({ type: "click", target: view.preview.querySelector("a") }), true);
  assert.equal(
    view.stopEvent({ type: "mousedown", target: view.preview.querySelector("td") }),
    true,
  );
  assert.equal(view.stopEvent({ type: "mousedown", target: view.dom }), false);
  assert.equal(view.stopEvent({ type: "mousedown", target: view.toolbar }), false);
  assert.equal(view.ignoreMutation({ type: "childList", target: view.preview }), true);
  assert.equal(view.update(schema.nodes.raw.create({ kind: "instruction", source: table })), false);
  assert.equal(view.update(parseMarkdown("Normal prose.").firstChild), false);
  assert.equal(
    view.update(schema.nodes.raw.create({ kind: "markdown", source: "| incomplete |" })),
    false,
  );
  view.destroy();
  view.toggle.click();
  assert.equal(view.source.hidden, false, "destroy removes the click listener");
});

test("preview links keep native navigation without reaching editor click handlers", (t) => {
  const doc = fixture(t);
  const view = new PreservedTableView(rawTable(table), doc);
  doc.body.append(view.dom);
  let editorClicks = 0;
  const onEditorClick = () => editorClicks++;
  doc.body.addEventListener("click", onEditorClick);
  t.after(() => doc.body.removeEventListener("click", onEditorClick));
  const link = view.preview.querySelector("a");
  for (const detail of [0, 1]) {
    const event = new doc.defaultView.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail,
    });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(editorClicks, 0);
  }
  view.destroy();
  link.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(editorClicks, 1, "destroy removes the preview click listener");
});
