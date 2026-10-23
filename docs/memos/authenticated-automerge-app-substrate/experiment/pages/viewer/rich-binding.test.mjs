import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { createPeer, connectPeers, closePeers, eventually } from "../../backend.mjs";
import { createPageData, initializePage, applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { applyComment, projectComments } from "../model/comments.mjs";
import { textPath } from "../model/richtext.mjs";
import { bindRichEditor } from "./rich-binding.mjs";
import { commentRanges, commentsForSelection } from "./rich-comments.mjs";
import { richPresence } from "./rich-presence.mjs";
import { richAttribution, attributionKey } from "./rich-attribution.mjs";
function session(handle) {
  let local = 0;
  return {
    handle,
    get doc() {
      return handle.doc();
    },
    actorDisplayName: () => "Collaborator",
    change(fn) {
      local++;
      try {
        return handle.change(fn);
      } finally {
        local--;
      }
    },
    observeChange(fn) {
      const listener = (event) => fn({ ...event, remote: local === 0 });
      handle.on("change", listener);
      return () => handle.off("change", listener);
    },
  };
}
test("real Repo handles drive granular editor patches, peer-preserving undo and late batch attribution", async (t) => {
  const a = createPeer(),
    b = createPeer(),
    wires = [];
  let projection, binding;
  t.after(async () => {
    projection?.destroy?.();
    binding?.destroy();
    await closePeers([a, b], wires);
  });
  const first = await a.repo.create(createPageData({ pageId: "fixture", title: "Fixture" }));
  await first.change((d) => initializePage(d, "Original text"));
  wires.push(await connectPeers(a, b));
  const second = await b.repo.find(first.documentId);
  const replica = session(second);
  const id = orderedBlockIds(first.doc())[0];
  let time = 1000;
  binding = bindRichEditor(replica, id);
  const view = {
    state: EditorState.create({
      schema: binding.schema,
      doc: binding.pmDoc,
      plugins: [binding.plugin, history(), richAttribution(replica, () => time)],
    }),
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
  };
  projection = binding.plugin.spec.view(view);
  const marks = () => attributionKey.getState(view.state).find();
  assert.equal(marks().length, 0);
  view.dispatch(view.state.tr.insertText("Local ", 1));
  await b.repo.flush();
  await eventually(() => assert.match(first.doc().blocks[id].richText, /Local/));
  assert.equal(marks().length, 0, "local changes do not illuminate");
  await replica.change((d) =>
    applyComment(
      d,
      { action: "add", block_id: id, selected_text: "cal ", body: "Anchor" },
      { principal: "one", displayName: "Kyle" },
    ),
  );
  await first.change((d) => A.splice(d, textPath(id), d.blocks[id].richText.length, 0, " remote"));
  await eventually(() => assert.match(view.state.doc.textContent, /remote$/));
  const mark = marks()[0];
  assert.ok(mark);
  assert.equal(view.state.doc.textBetween(mark.from, mark.to), " remote");
  replica.actorDisplayName = () => "Kyle Kelley · Fixture agent";
  view.dispatch(view.state.tr.setMeta("addToHistory", false));
  assert.match(
    marks()[0].type.attrs.title,
    /Fixture agent/,
    "late identity updates the existing range",
  );
  view.dispatch(view.state.tr.insertText("Here ", 1));
  assert.equal(marks()[0].from, mark.from + 5);
  time += 2001;
  view.dispatch(view.state.tr.setMeta("addToHistory", false));
  assert.equal(marks().length, 0);
  undo(view.state, view.dispatch);
  assert.match(view.state.doc.textContent, / remote$/);
  assert.equal(projectComments(replica.doc)[0].selectionContext.status, "attached");
});

test("a mounted editor ignores its remotely deleted block while another editor still updates", async (t) => {
  const a = createPeer(),
    b = createPeer(),
    wires = [],
    mounted = [],
    errors = [];
  t.after(async () => {
    for (const { binding, projection } of mounted) {
      projection?.destroy?.();
      binding.destroy();
    }
    await closePeers([a, b], wires);
  });
  const first = await a.repo.create(createPageData({ pageId: "deletion", title: "Deletion" }));
  await first.change((d) => {
    initializePage(d, "Delete me");
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "Keep me" }] },
    });
  });
  wires.push(await connectPeers(a, b));
  const second = await b.repo.find(first.documentId);
  const replica = session(second);
  const observe = replica.observeChange;
  replica.observeChange = (fn) =>
    observe((change) => {
      try {
        fn(change);
      } catch (error) {
        // Capture the binding's failure so both native peers can finish cleanup.
        errors.push(error);
      }
    });
  const [removed, retained] = orderedBlockIds(second.doc());
  for (const id of [removed, retained]) {
    const binding = bindRichEditor(replica, id);
    const view = {
      state: EditorState.create({
        schema: binding.schema,
        doc: binding.pmDoc,
        plugins: [binding.plugin],
      }),
      dispatch(tr) {
        view.state = view.state.apply(tr);
      },
    };
    mounted.push({ binding, view, projection: binding.plugin.spec.view(view) });
  }
  await first.change((d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: {
        operations: [
          { op: "delete_block", block_id: removed },
          { op: "replace_block_markdown", block_id: retained, markdown: "Still editable" },
        ],
      },
    }),
  );
  await eventually(() => {
    assert.equal(second.doc().blocks[removed], undefined);
    assert.equal(mounted[1].view.state.doc.textContent, "Still editable");
  });
  assert.deepEqual(errors, []);
  assert.equal(
    mounted[0].view.state.doc.textContent,
    "Delete me",
    "unmount owns deleted view cleanup",
  );
  mounted[1].view.dispatch(mounted[1].view.state.tr.insertText("Local ", 1));
  await b.repo.flush();
  await eventually(() =>
    assert.match(first.doc().blocks[retained].richText, /Local Still editable/),
  );
  assert.deepEqual(errors, []);
});

test("remote block moves preserve the editor selection, comment passage and peer selection", async (t) => {
  const a = createPeer(),
    b = createPeer(),
    wires = [];
  let binding, projection;
  t.after(async () => {
    projection?.destroy?.();
    binding?.destroy();
    await closePeers([a, b], wires);
  });
  const first = await a.repo.create(createPageData({ pageId: "movement", title: "Movement" }));
  await first.change((d) => {
    initializePage(d, "Selected passage");
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "Other block" }] },
    });
    applyComment(
      d,
      {
        action: "add",
        block_id: orderedBlockIds(d)[0],
        selected_text: "passage",
        body: "Keep this anchor",
      },
      { principal: "one", displayName: "Kyle" },
    );
  });
  wires.push(await connectPeers(a, b));
  const second = await b.repo.find(first.documentId);
  const replica = session(second);
  const [moved, other] = orderedBlockIds(replica.doc);
  const threads = () => projectComments(replica.doc);
  const ranges = () => commentRanges(replica.doc, moved, threads());
  const [passage] = ranges();
  assert.ok(passage);
  const originalObject = A.getObjectId(replica.doc.blocks[moved], "richText");
  binding = bindRichEditor(replica, moved);
  const view = {
    state: EditorState.create({
      schema: binding.schema,
      doc: binding.pmDoc,
      plugins: [binding.plugin],
    }),
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
  };
  projection = binding.plugin.spec.view(view);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, passage.from, passage.to)),
  );
  const context = threads()[0].selectionContext;
  replica.peers = new Map([
    [
      "peer",
      {
        value: {
          block_id: moved,
          start: A.getCursor(replica.doc, textPath(moved), context.start.offsetUtf16),
          end: A.getCursor(replica.doc, textPath(moved), context.end.offsetUtf16),
          heads: A.getHeads(replica.doc),
        },
        at: Date.now(),
        displayName: "Kyle · Other browser",
      },
    ],
  ]);
  const presence = richPresence(replica, moved);
  const selectedPeers = () =>
    presence.props
      .decorations(view.state)
      .find()
      .filter((d) => d.type.attrs?.class === "peer-selection");
  assert.equal(selectedPeers().length, 1);
  await first.change((d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "move_block", block_id: moved, after_block_id: other }] },
    }),
  );
  await eventually(() => assert.deepEqual(orderedBlockIds(replica.doc), [other, moved]));
  assert.equal(A.getObjectId(replica.doc.blocks[moved], "richText"), originalObject);
  assert.equal(
    view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    "passage",
  );
  assert.deepEqual(ranges(), [passage]);
  assert.equal(commentRanges(replica.doc, other, threads()).length, 0);
  assert.deepEqual(
    commentsForSelection(replica.doc, moved, { text: "passage", occurrence: 1 }, threads()).map(
      (t) => t.id,
    ),
    [threads()[0].id],
  );
  assert.deepEqual(
    selectedPeers().map(({ from, to }) => ({ from, to })),
    [{ from: passage.from, to: passage.to }],
  );
});
