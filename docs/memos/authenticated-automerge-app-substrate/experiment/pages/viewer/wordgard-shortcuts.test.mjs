import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Command, enter, setTextblockType, toggleList } from "wordgard/command";
import { history, undo } from "wordgard/history";
import { blockquote, bulletList, code, codeBlock, heading, orderedList } from "wordgard/schema";
import { textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { applyComment, projectComments } from "../model/comments.mjs";
import {
  schema,
  decode,
  BulletList,
  Code,
  CodeBlock,
  Heading,
  LineBreak,
  Paragraph,
  TaskList,
} from "./wordgard-model.mjs";
import {
  createWordgardBinding,
  insertPlainLineBreak,
  wordgardCodeNewlines,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { taskLists } from "./wordgard-task-lists.mjs";
import { markdownShortcuts } from "./wordgard-shortcuts.mjs";

// The editor configuration WordgardEditor installs, minus the DOM.
function fixture(markdown, { comment } = {}) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Shortcuts" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  const id = orderedBlockIds(doc)[0];
  if (comment)
    doc = A.change(doc, (d) =>
      applyComment(
        d,
        { action: "add", block_id: id, selected_text: comment, body: "About this" },
        { principal: "account:one", displayName: "Kyle", driver: "Browser" },
      ),
    );
  const path = textPath(id);
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
    config: [
      GardState.schemaElement.of(schema.elements),
      heading(),
      code(),
      bulletList(),
      orderedList(),
      taskLists(),
      blockquote(),
      codeBlock(),
      markdownShortcuts(),
      wordgardCodeNewlines,
      wordgardListStarts,
      history(),
    ],
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(spec) {
      for (const tr of Transaction.append(state.update(spec))) {
        binding.applyEditorTransaction(tr);
        state = tr.state;
      }
      assert.ok(decode(A.spans(doc, path)).doc.eq(state.doc), "editor and native document agree");
      validateRich(doc.blocks[id]);
    },
    select(anchor, head = anchor) {
      this.dispatch({ selection: GardSelection.Text.create({ anchor, head }) });
    },
    type(text) {
      for (const character of text) {
        const from = state.selection.from,
          to = state.selection.to;
        this.dispatch({
          changes: { from, to, insert: [Leaf.text(character, state.sel.activeMarks)] },
          selection: { anchor: from + character.length },
          userEvent: "input.type",
        });
      }
    },
    run(command, param) {
      return Command.dispatch(this, command, param);
    },
  };
  // Every Automerge character of the block text, by its current offset.
  const markdownOf = () => blockMarkdown(doc.blocks[id]);
  return { binding, editor, id, path, replica, markdownOf };
}

function countBreaks(doc) {
  let count = 0;
  doc.iterate((node) => {
    if (node.type === LineBreak.type) count++;
  });
  return count;
}

const outline = (doc) =>
  doc.content.map((node) => {
    const name = node.type === Heading ? `h${node.tag.param}` : node.name;
    return node.isTextblock
      ? [name, node.content.map((child) => (child.isText ? child.param : "<br>")).join("")]
      : [name, outline(node)];
  });

function at(state, text, offset = 0) {
  let found;
  state.doc.iterate((node, position) => {
    if (found === undefined && node.isText && String(node.param).includes(text))
      found = position + String(node.param).indexOf(text) + offset;
  });
  assert.notEqual(found, undefined, text);
  return found;
}

// Native text identity is the contract: each recorded character survives by
// Automerge identity, not as an equal character written in its place.
function cursorsFor(fixture, words) {
  const { replica, path, id } = fixture;
  const text = replica.doc.blocks[id].richText;
  return words.flatMap((word) => {
    const start = text.indexOf(word);
    assert.ok(start >= 0, word);
    return [...word].map((character, i) => ({
      character,
      cursor: A.getCursor(replica.doc, path, start + i),
    }));
  });
}
function assertSameCharacters(fixture, recorded) {
  const { replica, path, id } = fixture;
  const native = replica.doc,
    text = native.blocks[id].richText;
  for (const { character, cursor } of recorded) {
    const position = A.getCursorPosition(native, path, cursor);
    assert.equal(text[position], character, `${character} at ${position}`);
    assert.equal(A.getCursor(native, path, position), cursor, `${character} keeps its identity`);
  }
}

test("Enter splits the textblock in every editing state", () => {
  const cases = [
    [
      "middle of a paragraph",
      "alpha beta",
      (s) => at(s, "beta"),
      [
        ["Paragraph", "alpha "],
        ["Paragraph", "beta"],
      ],
    ],
    [
      "end of the document",
      "alpha",
      (s) => at(s, "alpha", 5),
      [
        ["Paragraph", "alpha"],
        ["Paragraph", ""],
      ],
    ],
    [
      "empty new Page",
      "",
      () => 1,
      [
        ["Paragraph", ""],
        ["Paragraph", ""],
      ],
    ],
    [
      "end of a heading",
      "# Title",
      (s) => at(s, "Title", 5),
      [
        ["h1", "Title"],
        ["Paragraph", ""],
      ],
    ],
    [
      "after a hard break",
      "alpha\\\nbeta",
      (s) => at(s, "beta"),
      [
        ["Paragraph", "alpha<br>"],
        ["Paragraph", "beta"],
      ],
    ],
    [
      "end of a list item",
      "- one",
      (s) => at(s, "one", 3),
      [
        [
          "BulletList",
          [
            ["ListItem", [["Paragraph", "one"]]],
            ["ListItem", [["Paragraph", ""]]],
          ],
        ],
      ],
    ],
  ];
  for (const [name, markdown, cursor, expected] of cases) {
    const { binding, editor } = fixture(markdown);
    const breaks = countBreaks(editor.state.doc);
    editor.select(cursor(editor.state));
    assert.equal(editor.run(enter), true, name);
    assert.deepEqual(outline(editor.state.doc), expected, name);
    assert.equal(countBreaks(editor.state.doc), breaks, `${name}: Enter adds no LineBreak`);
    binding.destroy();
  }
});

test("Enter then ## makes a heading; Shift+Enter then ## does too", () => {
  for (const newline of [enter, insertPlainLineBreak]) {
    const f = fixture("");
    f.editor.select(1);
    f.editor.type("Intro");
    f.editor.run(newline);
    f.editor.type("## Title");
    assert.deepEqual(outline(f.editor.state.doc), [
      ["Paragraph", "Intro"],
      ["h2", "Title"],
    ]);
    assert.equal(f.markdownOf(), "Intro\n\n## Title");
    f.binding.destroy();
  }
});

test("a block shortcut after a hard break splits out only that line", () => {
  const cases = [
    ["# ", [["h1", "new"]]],
    ["###### ", [["h6", "new"]]],
    ["- ", [["BulletList", [["ListItem", [["Paragraph", "new"]]]]]]],
    ["1. ", [["OrderedList", [["ListItem", [["Paragraph", "new"]]]]]]],
    ["[ ] ", [["PagesTaskList", [["ListItem", [["Paragraph", "new"]]]]]]],
    ["- [x] ", [["PagesTaskList", [["ListItem", [["Paragraph", "new"]]]]]]],
    ["> ", [["Blockquote", [["Paragraph", "new"]]]]],
  ];
  for (const [prefix, middle] of cases) {
    const f = fixture("alpha\\\n\\\nomega", { comment: "omega" });
    const before = cursorsFor(f, ["alpha", "omega"]);
    // The caret sits on the blank line between the two hard breaks.
    f.editor.select(at(f.editor.state, "alpha", 6));
    f.editor.type(prefix + "new");
    assert.deepEqual(
      outline(f.editor.state.doc),
      [["Paragraph", "alpha"], ...middle, ["Paragraph", "omega"]],
      prefix,
    );
    assertSameCharacters(f, before);
    const [thread] = projectComments(f.replica.doc);
    assert.equal(thread.selectionContext.status, "attached", prefix);
    assert.equal(thread.selectionContext.text, "omega", prefix);
    f.binding.destroy();
  }
});

test("a heading shortcut typed into Kyle's double-break layout converts the line", () => {
  const f = fixture("Intro text\\\n\\\nmore text", { comment: "Intro" });
  const before = cursorsFor(f, ["Intro text", "more text"]);
  f.editor.select(at(f.editor.state, "Intro text", 10));
  f.editor.run(insertPlainLineBreak);
  f.editor.run(insertPlainLineBreak);
  f.editor.type("## Heading");
  assert.deepEqual(outline(f.editor.state.doc), [
    ["Paragraph", "Intro text"],
    ["h2", "Heading"],
    ["Paragraph", "more text"],
  ]);
  assertSameCharacters(f, before);
  assert.equal(projectComments(f.replica.doc)[0].selectionContext.status, "attached");
  // The first undo removes the heading text; the second restores the typed
  // prefix and the hard breaks.
  f.editor.run(undo);
  assert.deepEqual(outline(f.editor.state.doc)[1], ["h2", ""]);
  f.editor.run(undo);
  assert.deepEqual(outline(f.editor.state.doc), [
    ["Paragraph", "Intro text<br><br>## <br><br>more text"],
  ]);
  f.binding.destroy();
});

test("a block shortcut in the middle of a line, or with text after it, stays text", () => {
  const f = fixture("alpha\\\nbeta");
  f.editor.select(at(f.editor.state, "beta", 2));
  f.editor.type("## ");
  assert.deepEqual(outline(f.editor.state.doc), [["Paragraph", "alpha<br>be## ta"]]);
  f.binding.destroy();
  const g = fixture("alpha\\\nbeta");
  g.editor.select(at(g.editor.state, "beta"));
  g.editor.type("## ");
  assert.deepEqual(outline(g.editor.state.doc), [["Paragraph", "alpha<br>## beta"]]);
  g.binding.destroy();
});

test("``` and Enter after a hard break opens a code block for that line", () => {
  const f = fixture("alpha\\\nomega");
  f.editor.select(at(f.editor.state, "alpha", 5));
  f.editor.run(insertPlainLineBreak);
  f.editor.type("```python");
  assert.equal(f.editor.run(enter), true);
  assert.deepEqual(outline(f.editor.state.doc), [
    ["Paragraph", "alpha"],
    ["CodeBlock", ""],
    ["Paragraph", "omega"],
  ]);
  f.editor.type("x = 1");
  assert.match(f.markdownOf(), /```python\nx = 1\n```/);
  f.binding.destroy();
});

test("a block command on one line of a hard-break paragraph converts only that line", () => {
  const f = fixture("first\\\nsecond\\\nthird", { comment: "second" });
  const before = cursorsFor(f, ["first", "second", "third"]);
  f.editor.select(at(f.editor.state, "second", 2));
  assert.equal(f.editor.run(setTextblockType, Heading.of(1)), true);
  assert.deepEqual(outline(f.editor.state.doc), [
    ["Paragraph", "first"],
    ["h1", "second"],
    ["Paragraph", "third"],
  ]);
  assert.equal(f.markdownOf(), "first\n\n# second\n\nthird");
  assertSameCharacters(f, before);
  const [thread] = projectComments(f.replica.doc);
  assert.equal(thread.selectionContext.status, "attached");
  assert.equal(thread.selectionContext.text, "second");
  // One undo puts the line back into the paragraph.
  f.editor.run(undo);
  assert.deepEqual(outline(f.editor.state.doc), [["Paragraph", "first<br>second<br>third"]]);
  f.binding.destroy();
});

test("a selection across lines splits at the surrounding breaks only", () => {
  const f = fixture("one\\\ntwo\\\nthree\\\nfour");
  const before = cursorsFor(f, ["one", "two", "three", "four"]);
  f.editor.select(at(f.editor.state, "two", 1), at(f.editor.state, "three", 2));
  assert.equal(f.editor.run(toggleList, BulletList), true);
  assert.deepEqual(outline(f.editor.state.doc), [
    ["Paragraph", "one"],
    ["BulletList", [["ListItem", [["Paragraph", "two<br>three"]]]]],
    ["Paragraph", "four"],
  ]);
  assertSameCharacters(f, before);
  f.binding.destroy();
});

test("a selection that ends at the start of the next line leaves that line alone", () => {
  const f = fixture("one\\\ntwo\\\nthree");
  // From the start of "two" to the start of "three", as a line selection reports it.
  f.editor.select(at(f.editor.state, "two"), at(f.editor.state, "three"));
  f.editor.run(toggleList, TaskList);
  assert.deepEqual(outline(f.editor.state.doc), [
    ["Paragraph", "one"],
    ["PagesTaskList", [["ListItem", [["Paragraph", "two"]]]]],
    ["Paragraph", "three"],
  ]);
  f.binding.destroy();
});

test("block commands keep whole-paragraph behavior without breaks or with all lines selected", () => {
  const f = fixture("one\\\ntwo");
  f.editor.select(at(f.editor.state, "one"), at(f.editor.state, "two", 3));
  f.editor.run(setTextblockType, Heading.of(2));
  assert.deepEqual(outline(f.editor.state.doc), [["h2", "one<br>two"]]);
  f.binding.destroy();
  const g = fixture("plain words");
  g.editor.select(at(g.editor.state, "words"));
  g.editor.run(setTextblockType, CodeBlock);
  assert.deepEqual(outline(g.editor.state.doc), [["CodeBlock", "plain words"]]);
  g.binding.destroy();
  // Paragraph on a paragraph line is a no-op and does not split.
  const h = fixture("one\\\ntwo");
  h.editor.select(at(h.editor.state, "two"));
  assert.equal(h.editor.run(setTextblockType, Paragraph), false);
  assert.deepEqual(outline(h.editor.state.doc), [["Paragraph", "one<br>two"]]);
  h.binding.destroy();
});

test("typing `text` makes inline code, and undo brings the backticks back", () => {
  const f = fixture("Run");
  f.editor.select(at(f.editor.state, "Run", 3));
  f.editor.type(" `npm test`");
  assert.equal(f.editor.state.doc.textContent(), "Run npm test");
  assert.equal(f.markdownOf(), "Run `npm test`");
  // Typing continues as prose.
  f.editor.type(" now");
  assert.equal(f.markdownOf(), "Run `npm test` now");
  f.editor.run(undo);
  f.editor.run(undo);
  assert.equal(f.editor.state.doc.textContent(), "Run `npm test`");
  assert.equal(f.markdownOf(), "Run \\`npm test\\`");
  f.binding.destroy();
});

test("inline code keeps the typed characters' Automerge identity", () => {
  const f = fixture("say");
  f.editor.select(at(f.editor.state, "say", 3));
  f.editor.type(" `hel");
  const before = cursorsFor(f, ["say ", "hel"]);
  f.editor.type("lo`");
  assertSameCharacters(f, before);
  const spans = A.spans(f.replica.doc, f.path).filter((span) => span.type === "text");
  assert.deepEqual(
    spans.map((span) => [span.value, span.marks ?? {}]),
    [
      ["say ", {}],
      ["hello", { code: true }],
    ],
  );
  f.binding.destroy();
});

test("backticks stay literal in code, empty spans, fences, and across breaks; $ never converts", () => {
  for (const [markdown, typed, expected] of [
    ["", "``", "\\`\\`"],
    ["", "` `", "\\` \\`"],
    ["", "```", "\\`\\`\\`"],
    ["", "spent $30 and $25", "spent $30 and $25"],
    ["", "$x$", "$x$"],
  ]) {
    const f = fixture(markdown);
    f.editor.select(1);
    f.editor.type(typed);
    assert.equal(f.markdownOf(), expected, typed);
    f.binding.destroy();
  }
  const g = fixture("```\nlet\n```");
  g.editor.select(at(g.editor.state, "let", 3));
  g.editor.type(" `a`");
  assert.equal(g.markdownOf(), "```\nlet `a`\n```");
  g.binding.destroy();
  const h = fixture("`open\\\nclose");
  h.editor.select(at(h.editor.state, "close", 5));
  h.editor.type("`");
  assert.ok(!h.editor.state.doc.content[0].content.some((n) => Code.isInSet(n.marks)));
  h.binding.destroy();
});
