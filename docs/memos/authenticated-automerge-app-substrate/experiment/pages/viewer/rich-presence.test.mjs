import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { EditorState } from "prosemirror-state";
import { createProgressTargets } from "../model/presence.mjs";
import { enableRich, adapter, richDoc, textPath } from "../model/richtext.mjs";
import { richPresence } from "./rich-presence.mjs";

test("agent progress maps into ProseMirror as a range, never a caret or document transaction", () => {
  let doc = A.from({ blocks: { first: { kind: "markdown", markdown: "Hello **world**." } } });
  doc = A.change(doc, (d) => enableRich(d, "first"));
  const targets = createProgressTargets(
    doc,
    [{ block_id: "first", match_text: "world" }],
    A.getHeads(doc),
  );
  const progress = {
    progress_id: "agent",
    displayName: "Kyle",
    driver: "Codex",
    message: "Reviewing",
    targets,
    until: Date.now() + 60000,
  };
  const replica = { doc, peers: new Map(), agentProgress: new Map([["agent", progress]]) };
  const plugin = richPresence(replica, "first");
  const projected = () => {
    const state = EditorState.create({
      schema: adapter.schema,
      doc: richDoc(replica.doc.blocks.first),
    });
    return { state, decorations: plugin.props.decorations(state).find() };
  };
  const heads = A.getHeads(doc);
  const { state, decorations } = projected();
  assert.equal(decorations.length, 1);
  assert.equal(decorations[0].type.attrs.class, "agent-progress-passage");
  assert.equal(state.doc.textBetween(decorations[0].from, decorations[0].to), "world");
  assert.deepEqual(A.getHeads(doc), heads);
  replica.doc = A.change(replica.doc, (d) => A.splice(d, textPath("first"), 0, 0, "Prefix "));
  assert.ok(projected().decorations[0].from > decorations[0].from);
  progress.until = Date.now() - 1;
  assert.equal(projected().decorations.length, 0);
  progress.until = Date.now() + 60000;
  replica.doc = A.change(replica.doc, (d) => {
    d.blocks.first.richText = "Replacement";
  });
  assert.equal(projected().decorations.length, 0);
});
