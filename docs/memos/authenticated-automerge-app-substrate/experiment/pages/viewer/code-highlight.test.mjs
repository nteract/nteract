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

async function harness() {
  const { GardState } = await import("wordgard/state");
  const { schema, decode } = await import("./wordgard-model.mjs");
  const { wordgardCodeNewlines } = await import("./wordgard-binding.mjs");
  const { projectChanges } = await import("./wordgard-projection.mjs");
  const { codeHighlighting } = await import("./code-highlight.mjs");
  const config = [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, codeHighlighting];
  const field = codeHighlighting[0];
  const block = (type, params) => ({
    type: "block",
    value: { type, parents: [], attrs: params === undefined ? {} : { params }, isEmbed: false },
  });
  // Every decoration as [from, to, class], for comparing two fields.
  const ranges = (state) => {
    const out = [];
    const cursor = state.field(field).cursor(0);
    while (cursor.value) {
      out.push([cursor.from, cursor.to, JSON.stringify(cursor.value.spec ?? cursor.value)]);
      cursor.next();
    }
    return out;
  };
  return { GardState, decode, projectChanges, config, block, ranges };
}

test("the highlight cap applies before tokenizing", async () => {
  const { GardState, decode, config, block, ranges } = await harness();
  for (const source of [
    // One string token far longer than the cap.
    `x = "${"a".repeat(30_000)}"\ny = 1`,
    // Blank lines past the cap, then code.
    `x = 1${"\n".repeat(12_000)}y = 2`,
  ]) {
    const state = GardState.create({
      doc: decode([block("code-block", "python"), { type: "text", value: source }]).doc,
      config,
    });
    const found = ranges(state);
    assert.ok(found.length > 0);
    assert.ok(found.every(([, to]) => to <= 1 + 10_000), `every range ends within the cap`);
  }
});

test("structural edits leave the same decorations as a freshly built field", async () => {
  const { GardState, decode, projectChanges, config, block, ranges } = await harness();
  const py = (text) => [block("code-block", "python"), { type: "text", value: text }];
  const para = (text) => [block("paragraph"), { type: "text", value: text }];
  const cases = [
    {
      name: "a code block deleted in the same transaction as an edit",
      before: [...py("a = 1"), ...para("middle"), ...py("b = 2")],
      after: [...py("a = 10"), ...para("middle")],
    },
    {
      name: "a code block split in two",
      before: py("def f():\n  return 1\nx = f()"),
      after: [...py("def f():\n  return 1"), ...py("x = f()")],
    },
    {
      name: "two code blocks merged",
      before: [...py("a = 1"), ...py("b = 2")],
      after: py("a = 1\nb = 2"),
    },
    {
      name: "one edit spanning two blocks",
      before: [...py("first = 1"), ...para("prose"), ...py("second = 2")],
      after: [...py("first = 'changed'"), ...para("prose here"), ...py("second = 3")],
    },
    {
      name: "a paragraph turned into code",
      before: [...para("x = 1"), ...py("y = 2")],
      after: [...py("x = 1"), ...py("y = 2")],
    },
  ];
  for (const item of cases) {
    let state = GardState.create({ doc: decode(item.before).doc, config });
    const target = decode(item.after).doc;
    state = state.update({ changes: projectChanges(state.doc, target) }).state;
    assert.ok(state.doc.eq(target), `${item.name}: edit applied`);
    const fresh = GardState.create({ doc: target, config });
    assert.deepEqual(ranges(state), ranges(fresh), item.name);
  }
});
