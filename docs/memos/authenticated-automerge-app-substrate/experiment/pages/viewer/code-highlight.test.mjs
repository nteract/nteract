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

// Wordgard 0.6.2's highlighter replaced a code block once per changed range,
// so a remote edit with two changed ranges in one block threw and never
// reached the editor. That broke Mermaid source sync between peers.
test("a remote edit with several changed ranges in one code block applies", async () => {
  const { GardState } = await import("wordgard/state");
  const { schema, decode } = await import("./wordgard-model.mjs");
  const { wordgardCodeNewlines } = await import("./wordgard-binding.mjs");
  const { projectChanges } = await import("./wordgard-projection.mjs");
  const { codeHighlighting } = await import("./code-highlight.mjs");
  const block = (params) => ({
    type: "block",
    value: { type: "code-block", parents: [], attrs: { params }, isEmbed: false },
  });
  const source = "def f(x):\n  A = 1  # Dashboard\n  return x";
  const edited = source.replace("Dashboard", "Overview").replace("A = 1", "B = 22");
  for (const [language, tokens] of [
    ["python", true],
    ["mermaid", false],
  ]) {
    let state = GardState.create({
      doc: decode([block(language), { type: "text", value: source }]).doc,
      config: [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, codeHighlighting],
    });
    const target = decode([block(language), { type: "text", value: edited }]).doc;
    const tr = state.update({ changes: projectChanges(state.doc, target) });
    let ranges = 0;
    tr.changes.iterChangedRanges(() => ranges++);
    assert.ok(ranges > 1, `${language}: the edit has several changed ranges`);
    state = tr.state;
    assert.ok(state.doc.eq(target), `${language}: the edit applied`);
    assert.equal(state.field(codeHighlighting[0]).length > 0, tokens, `${language}: tokens`);
  }
});
