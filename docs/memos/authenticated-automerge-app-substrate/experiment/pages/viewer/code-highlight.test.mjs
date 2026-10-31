import test from "node:test";
import assert from "node:assert/strict";
import { CODE_LANGUAGES, languageFor } from "./code-highlight.mjs";

test("a stored language finds its highlighter by first word, any case", () => {
  for (const [stored, name] of [
    ["python", "Python"],
    ["Python", "Python"],
    ["  py  ", "Python"],
    ["python title=demo.py", "Python"],
    ["js", "JavaScript"],
    ["tsx", "TypeScript"],
    ["bash", "Shell"],
    ["sh", "Shell"],
    ["console", "Shell"],
    ["rs", "Rust"],
    ["yml", "YAML"],
    ["JSON", "JSON"],
    ["golang", "Go"],
  ])
    assert.equal(languageFor(stored)?.name, name, stored);
  for (const stored of [
    undefined,
    null,
    "",
    "   ",
    "mermaid",
    "markdown",
    "brainfuck",
    // Object.prototype names must not resolve to inherited properties.
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
  ])
    assert.equal(languageFor(stored), null, String(stored));
});

test("every menu language highlights except Mermaid and Markdown", () => {
  const plain = CODE_LANGUAGES.filter((name) => !languageFor(name));
  assert.deepEqual(plain, ["Mermaid", "Markdown"]);
});

test("highlighting writes nothing: code spans stay unmarked and comments stay attached", async () => {
  const A = await import("@automerge/automerge");
  const { GardState, GardSelection } = await import("wordgard/state");
  const { Command, insertText } = await import("wordgard/command");
  const { createPageData, initializePage, orderedBlockIds } = await import("../model/page.mjs");
  const { applyComment, projectComments } = await import("../model/comments.mjs");
  const { textPath } = await import("../model/richtext.mjs");
  const { schema } = await import("./wordgard-model.mjs");
  const { createWordgardBinding, wordgardCodeNewlines } = await import("./wordgard-binding.mjs");
  const { codeHighlighting } = await import("./code-highlight.mjs");

  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Code" }));
  doc = A.change(doc, (d) =>
    initializePage(d, "```python\ndef count(text):\n    return len(text)\n```"),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) =>
    applyComment(
      d,
      { action: "add", block_id: id, selected_text: "count", body: "Rename?" },
      { principal: "account:one", displayName: "Kyle", driver: "Browser" },
    ),
  );
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, id);
  let state = GardState.create({
    doc: binding.current.doc,
    config: [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, codeHighlighting],
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(spec) {
      const tr = state.update(spec);
      binding.applyEditorTransaction(tr);
      state = tr.state;
    },
  };
  // Type at the end of the code, through the highlighted editor config.
  const end = state.doc.length - 1;
  state = state.update({ selection: GardSelection.Text.create({ anchor: end }) }).state;
  Command.dispatch(editor, insertText, { from: end, to: end, insert: "  # done" });
  const spans = A.spans(doc, textPath(id)).filter((span) => span.type === "text");
  assert.ok(spans.length);
  assert.deepEqual(
    spans.map((span) => span.marks ?? {}),
    spans.map(() => ({})),
  );
  assert.match(spans.map((span) => span.value).join(""), /# done$/);
  const [thread] = projectComments(doc);
  assert.equal(thread.selectionContext.status, "attached");
  assert.equal(thread.selectionContext.text, "count");
  binding.destroy();
});
