import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { EditorState } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { createPeer, connectPeers, closePeers, eventually } from "../../backend.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment, projectComments } from "../model/comments.mjs";
import { textPath } from "../model/richtext.mjs";
import { bindRichEditor } from "./rich-binding.mjs";
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
  const id = first.doc().order[0];
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
