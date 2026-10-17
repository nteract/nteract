import test from "node:test";
import assert from "node:assert/strict";
import {
  A,
  adapter,
  fixture,
  pair,
  exportMarkdown,
  parseMarkdown,
  synchronize,
  headsEqual,
  textPath,
  exportBlock,
} from "../model.mjs";
import { pmNodeToSpans, pmDocFromSpans } from "@automerge/prosemirror";

test("two offline replicas converge, concurrent formatting includes inserted text, cursor follows original quote", () => {
  const [a, b] = pair(),
    before = a.doc(),
    at = before.blocks["first-observation"].richText.indexOf("fox");
  const cursor = A.getCursor(before, textPath("first-observation"), at);
  a.change((d) =>
    A.mark(
      d,
      textPath("first-observation"),
      { start: at - 1, end: at + 4, expand: "both" },
      "em",
      true,
    ),
  );
  b.change((d) => A.splice(d, textPath("first-observation"), at, 0, "quick "));
  synchronize(a, b);
  assert.ok(headsEqual(a, b));
  assert.equal(
    a.doc().blocks["first-observation"].richText,
    b.doc().blocks["first-observation"].richText,
  );
  assert.ok(a.doc().blocks["first-observation"].richText.includes("quick fox"));
  assert.equal(
    a
      .doc()
      .blocks["first-observation"].richText.slice(
        A.getCursorPosition(a.doc(), textPath("first-observation"), cursor),
        A.getCursorPosition(a.doc(), textPath("first-observation"), cursor) + 3,
      ),
    "fox",
  );
  assert.deepEqual(
    A.spans(a.doc(), textPath("first-observation")),
    A.spans(b.doc(), textPath("first-observation")),
  );
  assert.ok(
    A.spans(a.doc(), textPath("first-observation"))
      .filter((s) => s.type === "text" && s.marks?.em)
      .map((s) => s.value)
      .join("")
      .includes("quick fox"),
  );
});
test("Unicode splice and deleted cursor resolve on both replicas", () => {
  const [a, b] = pair();
  a.change((d) => A.splice(d, textPath("first-observation"), 1, 0, "🦊"));
  synchronize(a, b);
  const index = a.doc().blocks["first-observation"].richText.indexOf("🦊");
  const cursor = A.getCursor(a.doc(), textPath("first-observation"), index);
  a.change((d) => A.splice(d, textPath("first-observation"), index, 2, "🐦"));
  b.change((d) => A.splice(d, textPath("first-observation"), 1, 0, "日本語 "));
  synchronize(a, b);
  assert.ok(headsEqual(a, b));
  assert.ok(a.doc().blocks["first-observation"].richText.includes("🐦"));
  assert.equal(
    A.getCursorPosition(a.doc(), textPath("first-observation"), cursor),
    A.getCursorPosition(b.doc(), textPath("first-observation"), cursor),
  );
});
test("opaque Markdown and unknown block metadata survive neighboring edits and save/load", () => {
  const [a, b] = pair();
  a.change((d) => A.splice(d, textPath("first-observation"), 2, 0, "A "));
  synchronize(a, b);
  const loaded = A.load(A.save(a.doc()));
  assert.deepEqual(
    loaded.blockOrder,
    fixture.map((b) => b.id),
  );
  for (const b of fixture) assert.deepEqual(loaded.blocks[b.id].metadata, b.metadata);
  const exported = loaded.blockOrder.map((id) => exportBlock(loaded, id)).join("\n\n");
  assert.ok(exported.includes(fixture.find((b) => b.id === "table-math").source));
  assert.ok(exported.includes("```python"));
});
test("supported Markdown has semantic formatting round trip; unsupported syntax is opaque", () => {
  for (const text of [
    "A **bold** and *emphasized* [link](https://nteract.io).",
    "## Heading",
    "- one\n- two",
    "```js\nconst x = 1\n```",
    "Inline `code`",
  ]) {
    const doc = parseMarkdown(text),
      spans = pmNodeToSpans(adapter, doc),
      restored = pmDocFromSpans(adapter, spans);
    assert.equal(exportMarkdown(restored), exportMarkdown(doc));
  }
  for (const text of ["<widget>unknown</widget>", "$$x^2$$", "| a | b |\n| - | - |", "~~strike~~"])
    assert.equal(parseMarkdown(text).firstChild.type.name, "raw");
});
test("replica merge notifies binding with real before/after patches and no-op merge is quiet", () => {
  const [a, b] = pair();
  let count = 0;
  b.on("change", (event) => {
    count++;
    assert.ok(event.patches.length);
    assert.notDeepEqual(A.getHeads(event.patchInfo.before), A.getHeads(event.doc));
  });
  a.change((d) => A.splice(d, textPath("first-observation"), 2, 0, "new "));
  synchronize(a, b);
  synchronize(a, b);
  assert.equal(count, 1);
});

test("unchanged blocks export original Markdown bytes", () => {
  const [a] = pair();
  for (const block of fixture) assert.equal(exportBlock(a.doc(), block.id), block.source);
});
