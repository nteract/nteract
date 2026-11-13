// An editor over one Page's blocks, for code block command tests. It writes
// every transaction through the Wordgard binding to a native Automerge
// document and checks that the two agree.
//
// A fixture reads and writes a code block as its source with the selection
// drawn in: ▮ is a caret, « and » are a selection's anchor and head.
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Command } from "wordgard/command";
import { history } from "wordgard/history";
import { codeBlock } from "wordgard/schema";
import { textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { schema, decode, CodeBlockLanguage } from "../viewer/wordgard-model.mjs";
import { createWordgardBinding, wordgardCodeNewlines } from "../viewer/wordgard-binding.mjs";

const MARKS = /[▮«»]/g;

const sourceOf = (node) =>
  node.content.map((child) => (child.isText ? String(child.param) : "\n")).join("");

/** An editor over the first block of a Page made from `markdown`, with
 * `extensions` added to the code block schema, line breaks and history. */
export function fixture(markdown, extensions) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Code block" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  const id = orderedBlockIds(doc)[0];
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
      codeBlock(),
      extensions,
      wordgardCodeNewlines,
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
      assert.ok(decode(A.spans(doc, path)).doc.eq(state.doc), "editor and native agree");
      validateRich(doc.blocks[id]);
    },
    run(command, param = null) {
      return Command.dispatch(this, command, param);
    },
  };
  return {
    editor,
    markdown: () => blockMarkdown(doc.blocks[id]),
    outline: () => state.doc.content.map((node) => [node.type.name, sourceOf(node)]),
    language: (index) => state.doc.content[index].mark(CodeBlockLanguage),
    /** The first node's source, with the selection drawn in. */
    code() {
      const text = sourceOf(state.doc.content[0]);
      const { anchor, head } = state.selection;
      const marks =
        anchor === head
          ? [[head - 1, "▮"]]
          : [
              [anchor - 1, "«"],
              [head - 1, "»"],
            ];
      return marks
        .sort((a, b) => b[0] - a[0])
        .reduce((out, [at, mark]) => out.slice(0, at) + mark + out.slice(at), text);
    },
    destroy: () => binding.destroy(),
  };
}

/** A code block in `language` holding `drawn`, with its selection set. */
export function codeFixture(language, drawn, extensions) {
  const f = fixture("```" + language + "\n" + drawn.replace(MARKS, "") + "\n```", extensions);
  const caret = drawn.indexOf("▮");
  const anchor = caret < 0 ? drawn.replace("»", "").indexOf("«") : caret;
  const head = caret < 0 ? drawn.replace("«", "").indexOf("»") : caret;
  // The code block is the first node, so its content starts at position 1.
  f.editor.dispatch({
    selection: GardSelection.Text.create({ anchor: anchor + 1, head: head + 1 }),
  });
  assert.equal(f.code(), drawn, "the fixture draws its own selection");
  return f;
}
