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
import { tablePreviewFragment } from "./table-fragment.mjs";

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

test("non-table Markdown does not produce a table preview", (t) => {
  const doc = fixture(t);
  for (const source of [
    "A | B",
    "| A | B |\n| not a delimiter |\n| C | D |",
    "```\n| A |\n| --- |\n| B |\n```",
    "| A | B |\n| --- |\n| C | D |",
  ]) {
    assert.equal(parseTableMarkdown(source), null);
    assert.equal(tablePreviewFragment(source, doc), null);
  }
});
