import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { applyPageOperation } from "../model/page.mjs";
import { applyComment, projectComments } from "../model/comments.mjs";
import { RICH_FORMAT, richDoc, setRichMarkdown, textPath } from "../model/richtext.mjs";
import { bindRichEditor } from "./rich-binding.mjs";
import { commentRanges } from "./rich-comments.mjs";
import { attributionKey, richAttribution } from "./rich-attribution.mjs";

const ordered = "Intro.\n\n1. First item.\n\n2. Second item.\n\nAfter.";
const heading = "## Heading\n\nOne paragraph.\n\nAnother paragraph.";

// Real Automerge/model changes, synchronously delivered at the binding boundary.
// No transport is needed to reproduce an invalid intermediate ProseMirror step.
function fixture(t, sources) {
  let doc = A.from({ page_id: "projection", title: "Projection", blocks: {}, comments: {} });
  doc = A.change(doc, (d) => {
    Object.entries(sources).forEach(([id, source], index) => {
      d.blocks[id] = {
        id,
        position: `a${index}`,
        kind: "markdown",
        format: RICH_FORMAT,
        markdown: "",
        richText: "",
        metadata: {},
      };
      setRichMarkdown(d, id, source);
    });
  });
  const observers = new Set();
  let localChanges = 0;
  const notify = (before, remote) => {
    const change = {
      doc,
      patches: A.diff(doc, A.getHeads(before), A.getHeads(doc)),
      patchInfo: { before, after: doc },
      remote,
    };
    for (const fn of observers) fn(change);
  };
  const replica = {
    get doc() {
      return doc;
    },
    get localChanges() {
      return localChanges;
    },
    actorDisplayName: () => "Fixture agent",
    change(fn) {
      const before = doc;
      localChanges++;
      doc = A.change(doc, fn);
      notify(before, false);
    },
    remote(fn) {
      const before = doc;
      doc = A.change(A.clone(doc), fn);
      const expectedHeads = A.getHeads(doc);
      notify(before, true);
      assert.deepEqual(A.getHeads(doc), expectedHeads, "projection must not author CRDT changes");
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
  const mount = (id, { plugins = [], dispatchError } = {}) => {
    const binding = bindRichEditor(replica, id);
    const view = {
      dispatches: 0,
      state: EditorState.create({
        schema: binding.schema,
        doc: binding.pmDoc,
        plugins: [binding.plugin, history(), richAttribution(replica), ...plugins],
      }),
      dispatch(tr) {
        view.dispatches++;
        if (dispatchError) throw dispatchError;
        view.state = view.state.apply(tr);
      },
    };
    const projection = binding.plugin.spec.view(view);
    t.after(() => {
      projection.destroy();
      binding.destroy();
    });
    return view;
  };
  const edit = (...operations) =>
    replica.remote((d) =>
      applyPageOperation(d, { operation: "edit_page", arguments: { operations } }),
    );
  return { replica, mount, edit };
}
const replace = (block_id, markdown) => ({ op: "replace_block_markdown", block_id, markdown });

for (const [name, before, after] of [
  ["ordered list to heading and paragraphs", ordered, heading],
  [
    "ordered list to paragraphs",
    ordered,
    "Updated intro.\n\nChanged paragraph.\n\nLast paragraph.",
  ],
  [
    "bullet list to heading",
    "Intro.\n\n- First item.\n- Second item.\n\nAfter.",
    "## Heading\n\nOne paragraph.",
  ],
]) {
  test(`remote structural rewrite projects ${name} without CRDT echo`, (t) => {
    const { replica, mount, edit } = fixture(t, { block: before });
    const view = mount("block");
    edit(replace("block", after));
    assert.ok(view.state.doc.eq(richDoc(replica.doc.blocks.block)));
    assert.equal(replica.localChanges, 0);
    assert.equal(view.dispatches, 1, "the failed intermediate transaction was never dispatched");
    assert.ok(
      attributionKey.getState(view.state).find().length,
      "recovered incoming text illuminates",
    );
  });
}

test("recovery keeps other mounted blocks current and accepts later local, remote and undo edits", (t) => {
  const { replica, mount, edit } = fixture(t, { block: ordered, adjacent: "Unchanged passage." });
  const view = mount("block"),
    adjacent = mount("adjacent");
  edit(replace("block", heading), replace("adjacent", "Adjacent updated."));
  for (const [id, editor] of [
    ["block", view],
    ["adjacent", adjacent],
  ])
    assert.ok(editor.state.doc.eq(richDoc(replica.doc.blocks[id])));
  assert.equal(replica.localChanges, 0);

  view.dispatch(view.state.tr.insertText("Local ", 1));
  assert.equal(replica.localChanges, 1);
  assert.match(replica.doc.blocks.block.richText, /Local Heading/);
  replica.remote((d) =>
    A.splice(d, textPath("block"), d.blocks.block.richText.length, 0, " agent"),
  );
  assert.match(view.state.doc.textContent, /agent$/);
  assert.equal(replica.localChanges, 1);
  assert.ok(undo(view.state, view.dispatch));
  assert.doesNotMatch(view.state.doc.textContent, /Local /);
  assert.match(view.state.doc.textContent, /^Heading/);
  assert.match(view.state.doc.textContent, /agent$/);
  assert.ok(view.state.doc.eq(richDoc(replica.doc.blocks.block)));
  edit(replace("adjacent", "Still connected."));
  assert.equal(adjacent.state.doc.textContent, "Still connected.");
});

test("a surviving selected and commented suffix stays anchored across structural recovery", (t) => {
  const { replica, mount, edit } = fixture(t, { block: ordered });
  replica.remote((d) =>
    applyComment(
      d,
      { action: "add", block_id: "block", selected_text: "After.", body: "Keep this passage" },
      { principal: "fixture", displayName: "Kyle" },
    ),
  );
  const view = mount("block");
  const [before] = commentRanges(replica.doc, "block", projectComments(replica.doc));
  assert.ok(before);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, before.from, before.to)),
  );
  edit(replace("block", `${heading}\n\nAfter.`));
  assert.equal(
    view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    "After.",
  );
  const [after] = commentRanges(replica.doc, "block", projectComments(replica.doc));
  assert.ok(after);
  assert.equal(view.state.doc.textBetween(after.from, after.to), "After.");
  assert.equal(projectComments(replica.doc)[0].selectionContext.status, "attached");
  assert.equal(replica.localChanges, 0);
});

for (const phase of ["dispatch", "plugin"]) {
  test(`recovery does not swallow a downstream ${phase} error with the same message`, (t) => {
    const { replica, mount, edit } = fixture(t, { block: "Original text." });
    const error = new RangeError("Invalid content for node doc");
    const view = mount(
      "block",
      phase === "dispatch"
        ? { dispatchError: error }
        : {
            plugins: [
              new Plugin({
                appendTransaction() {
                  throw error;
                },
              }),
            ],
          },
    );
    assert.throws(
      () => edit(replace("block", "Updated text.")),
      (actual) => actual === error,
    );
    assert.equal(view.dispatches, 1, "downstream failure must not trigger a second projection");
    assert.equal(replica.localChanges, 0);
  });
}

test("an invalid final rich document remains an error instead of being accepted by recovery", (t) => {
  const { replica, mount } = fixture(t, { block: "Text" });
  const view = mount("block");
  assert.throws(
    () =>
      replica.remote((d) =>
        A.updateBlock(d, textPath("block"), 0, {
          type: new A.ImmutableString("ordered-list-item"),
          parents: [],
          attrs: {},
          isEmbed: true,
        }),
      ),
    /Invalid content for node list_item/,
  );
  assert.throws(() => richDoc(replica.doc.blocks.block), /Invalid content for node list_item/);
  assert.equal(view.state.doc.textContent, "Text");
  assert.equal(view.dispatches, 0);
  assert.equal(replica.localChanges, 0);
});
