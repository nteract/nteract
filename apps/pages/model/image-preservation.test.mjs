import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { textPath, blockMarkdown, setRichMarkdownKeepingNodes } from "./richtext.mjs";
import { richFromSource } from "./richtext-test-support.mjs";

function fixture(markdown, extra = { future: "opaque", enabled: false, count: 2, empty: null }) {
  return A.change(A.from({ blocks: { one: { markdown } } }), (d) => {
    richFromSource(d, "one");
    const spans = A.spans(d, textPath("one"));
    for (const span of spans)
      if (span.type === "block" && String(span.value.type) === "image")
        Object.assign(span.value.attrs, extra);
    A.updateSpans(d, textPath("one"), spans);
  });
}
const attrs = (doc) =>
  A.spans(doc, textPath("one"))
    .filter((s) => s.type === "block" && String(s.value.type) === "image")
    .map((s) => s.value.attrs);
const image = '![Diagram](https://example.com/image.png "Title")';
test("opaque images do not turn ordinary dataframe-like links into dataframe nodes", () => {
  const link = `[Dataframe: report](/api/pages/11111111-1111-4111-8111-111111111111/assets/${"a".repeat(64)})`;
  for (const extra of [{}, { future: "x" }]) {
    const doc = fixture(`${image}\n\n${link}`, extra);
    const markdown = `${blockMarkdown(doc.blocks.one)}\n\nAfter`;
    const changed = A.change(doc, (d) => setRichMarkdownKeepingNodes(d, "one", markdown));
    assert.equal(blockMarkdown(changed.blocks.one), markdown);
    assert.deepEqual(attrs(changed), attrs(doc));
    assert.ok(
      !A.spans(changed, textPath("one")).some(
        (s) => s.type === "block" && String(s.value.type) === "dataframe",
      ),
    );
  }
});
test("Markdown rewrites preserve opaque image attrs in paragraphs, headings, quotes, lists and tables", () => {
  for (const source of [
    image,
    `## ${image}`,
    `> ${image}`,
    `- ${image}`,
    `> - ${image}`,
    `| A |\n| --- |\n| ${image} |`,
  ]) {
    const doc = fixture(source);
    const changed = A.change(doc, (d) =>
      setRichMarkdownKeepingNodes(d, "one", `${blockMarkdown(doc.blocks.one)}\n\nAfter`),
    );
    assert.deepEqual(attrs(changed), attrs(doc), source);
  }
});
test("Markdown refuses edited, removed, moved or ambiguous opaque images atomically", () => {
  for (const [source, replacement] of [
    [image, "Gone"],
    [image, image.replace("Diagram", "Changed")],
    [image, `> ${image}`],
    [image, `${image} ${image}`],
    [`${image} ${image}`, `${image} ${image}`],
  ]) {
    const doc = fixture(source);
    const heads = A.getHeads(doc);
    assert.throws(
      () => A.change(doc, (d) => setRichMarkdownKeepingNodes(d, "one", replacement)),
      (e) => e.code === "markdownless_node",
    );
    assert.deepEqual(A.getHeads(doc), heads);
  }
});
test("Markdown refuses unrepresentable image values, while ordinary images remain editable", () => {
  const doc = fixture(image, { future: { nested: "value" } });
  assert.throws(
    () => A.change(doc, (d) => setRichMarkdownKeepingNodes(d, "one", image)),
    (e) => e.code === "markdownless_node",
  );
  const plain = fixture(image, {});
  const changed = A.change(plain, (d) => setRichMarkdownKeepingNodes(d, "one", "Gone"));
  assert.equal(blockMarkdown(changed.blocks.one), "Gone");
});
