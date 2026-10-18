import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import {
  blockMarkdown,
  enableRich,
  exportMarkdown,
  parseMarkdown,
  richDoc,
  validateRich,
} from "../src/richtext.mjs";

await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);

test("CommonMark structure and marks survive rich storage and Markdown export", () => {
  const source = [
    "# A shared 🌍 document",
    'A **bold** and *emphasized* passage with `code` and [a link](https://example.com "Title").',
    "first line  \nsecond line",
    "> A quoted paragraph",
    "- one\n- two",
    "1. first\n2. second",
    "```python\nprint('日本語')\n```",
    '![An image](https://example.com/image.png "Caption")',
  ].join("\n\n");
  const parsed = parseMarkdown(source);
  assert.deepEqual(
    Array.from({ length: parsed.childCount }, (_, i) => parsed.child(i).type.name),
    [
      "heading",
      "paragraph",
      "paragraph",
      "blockquote",
      "bullet_list",
      "ordered_list",
      "code_block",
      "paragraph",
    ],
  );
  const types = new Set<string>();
  const marks = new Set<string>();
  parsed.descendants((node) => {
    types.add(node.type.name);
    for (const mark of node.marks) marks.add(mark.type.name);
  });
  assert.ok(types.has("hard_break"));
  assert.ok(types.has("image"));
  assert.deepEqual([...marks].sort(), ["code", "em", "link", "strong"]);
  assert.equal(parsed.child(5).attrs.order, 1);
  assert.equal(parsed.child(6).attrs.params, "python");

  let doc = A.from({ blocks: { prose: { kind: "markdown", markdown: source } } });
  doc = A.change(doc, (draft) => enableRich(draft, "prose"));
  const restored = A.load<typeof doc>(A.save(doc));
  validateRich(restored.blocks.prose);
  assert.equal(
    exportMarkdown(richDoc(restored.blocks.prose)),
    exportMarkdown(parsed),
    "Automerge preserves Markdown semantics",
  );
  assert.equal(
    blockMarkdown(restored.blocks.prose),
    source,
    "unchanged import retains exact source",
  );
  assert.ok(parseMarkdown(exportMarkdown(richDoc(restored.blocks.prose))).eq(parsed));
});

test("bare addresses stay prose while explicit safe links retain marks", () => {
  const plain = "https://example.com user@example.com mailto:user@example.com a://a://";
  const doc = parseMarkdown(
    `${plain}\n\n[Website](https://example.com) and [Email](mailto:user@example.com)`,
  );
  assert.equal(doc.firstChild!.textContent, plain);
  doc.firstChild!.descendants((node) => assert.equal(node.marks.length, 0));
  const links: string[] = [];
  doc.lastChild!.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "link") links.push(mark.attrs.href);
  });
  assert.deepEqual(links, ["https://example.com", "mailto:user@example.com"]);

  const unsafe = parseMarkdown("[click](javascript:alert(1)) ![image](data:text/html,hello)");
  unsafe.descendants((node) => {
    assert.notEqual(node.type.name, "image");
    assert.ok(node.marks.every((mark) => mark.type.name !== "link"));
  });
});

test("unsupported HTML and Markdown extensions remain opaque and export unchanged", () => {
  for (const source of [
    '<script>alert("hello")</script>',
    "| left | right |\n| --- | --- |\n| a | b |",
    "- [x] complete",
    "~~deleted~~",
    "$$x^2$$",
    "[reference][id]\n\n[id]: https://example.com",
  ]) {
    const doc = parseMarkdown(source);
    assert.equal(doc.childCount, 1);
    assert.equal(doc.firstChild!.type.name, "raw");
    assert.equal(exportMarkdown(doc), source);
  }
});
