import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { exportMarkdown, parseMarkdown, schema } from "../model/richtext.mjs";
import {
  changeTargetLink,
  linkDestination,
  linkRangeAt,
  linkTargetKey,
  observeLinkTarget,
} from "./rich-links.mjs";

const base = "https://page3.runtimed.run/p/example";
function state(markdown = 'Before [a **useful** link](https://nteract.io/docs "Notes") after.') {
  return EditorState.create({
    schema,
    doc: parseMarkdown(markdown),
    plugins: [observeLinkTarget(() => {}), history()],
  });
}
function activate(editor) {
  const target = linkRangeAt(editor.doc, 9);
  assert.ok(target);
  return editor.apply(editor.tr.setMeta(linkTargetKey, target).setMeta("addToHistory", false));
}

test("link activation resolves relative links and rejects unsafe destinations", () => {
  for (const [href, expected] of [
    ["https://nteract.io/docs", "https://nteract.io/docs"],
    ["/p/second", "https://page3.runtimed.run/p/second"],
    ["#details", "https://page3.runtimed.run/p/example#details"],
    ["mailto:hello@example.com", "mailto:hello@example.com"],
    ["tel:+1234567", "tel:+1234567"],
  ])
    assert.equal(linkDestination(href, base), expected);
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,test",
    "file:///tmp/test",
    "blob:https://page3.runtimed.run/id",
    "java\nscript:alert(1)",
    " https://nteract.io",
    "",
    "https:javascript:alert(1)",
  ]) {
    assert.equal(linkDestination(href, base), null, href);
  }
});

test("link range spans inline formatting without absorbing unlinked text", () => {
  const editor = state();
  for (const position of [8, 9, 12, 20]) {
    const target = linkRangeAt(editor.doc, position);
    assert.equal(editor.doc.textBetween(target.from, target.to), "a useful link");
    assert.equal(target.attrs.title, "Notes");
  }
  assert.equal(linkRangeAt(editor.doc, 3), null);
});

test("link edits use mapped range after another writer inserts before and inside it", () => {
  let editor = activate(state());
  editor = editor.apply(editor.tr.insertText("New prefix. ", 1).setMeta("addToHistory", false));
  let target = linkTargetKey.getState(editor);
  assert.equal(editor.doc.textBetween(target.from, target.to), "a useful link");
  editor = editor.apply(
    editor.tr.insertText("very ", target.from + 2).setMeta("addToHistory", false),
  );
  target = linkTargetKey.getState(editor);
  assert.equal(editor.doc.textBetween(target.from, target.to), "a very useful link");
  assert.equal(
    changeTargetLink(
      editor,
      (tr) => {
        editor = editor.apply(tr);
      },
      "/p/new",
      base,
    ),
    true,
  );
  assert.equal(linkTargetKey.getState(editor), null);
  assert.match(exportMarkdown(editor.doc), /\[a very \*\*useful\*\* link\]\(\/p\/new "Notes"\)/);
  assert.equal(
    undo(editor, (tr) => {
      editor = editor.apply(tr);
    }),
    true,
  );
  assert.match(exportMarkdown(editor.doc), /https:\/\/nteract.io\/docs/);
  assert.match(editor.doc.textContent, /^New prefix/);
});

test("deleting or replacing an active link invalidates its target", () => {
  for (const action of ["delete", "href", "title", "replacement"]) {
    let editor = activate(state());
    const target = linkTargetKey.getState(editor);
    let tr = editor.tr;
    if (action === "delete") tr = tr.delete(target.from, target.to);
    else if (action === "replacement") tr = tr.insertText("a useful link", target.from, target.to);
    else
      tr = tr.removeMark(target.from, target.to, schema.marks.link).addMark(
        target.from,
        target.to,
        schema.marks.link.create({
          ...target.attrs,
          [action]: action === "href" ? "https://example.com" : "New title",
        }),
      );
    editor = editor.apply(tr);
    assert.equal(linkTargetKey.getState(editor), null, action);
    assert.equal(
      changeTargetLink(editor, () => assert.fail("must not edit stale link"), "/p/elsewhere", base),
      false,
    );
  }
});

test("removing a link preserves its text and other marks and is undoable", () => {
  let editor = activate(state());
  const content = editor.doc.textContent;
  changeTargetLink(
    editor,
    (tr) => {
      editor = editor.apply(tr);
    },
    null,
    base,
  );
  assert.equal(editor.doc.textContent, content);
  assert.equal(linkRangeAt(editor.doc, 9), null);
  assert.match(exportMarkdown(editor.doc), /a \*\*useful\*\* link/);
  assert.equal(
    undo(editor, (tr) => {
      editor = editor.apply(tr);
    }),
    true,
  );
  assert.equal(linkRangeAt(editor.doc, 9).attrs.href, "https://nteract.io/docs");
});

test("a new text selection closes the menu; unsafe edits preserve target and text", () => {
  let editor = activate(state());
  const before = editor.doc;
  assert.throws(
    () =>
      changeTargetLink(
        editor,
        () => assert.fail("unsafe edit dispatched"),
        "javascript:alert(1)",
        base,
      ),
    /valid web/,
  );
  assert.equal(editor.doc, before);
  assert.ok(linkTargetKey.getState(editor));
  editor = editor.apply(editor.tr.setSelection(TextSelection.create(editor.doc, 2)));
  assert.equal(linkTargetKey.getState(editor), null);
});
