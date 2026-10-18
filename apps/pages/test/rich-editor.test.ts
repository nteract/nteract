import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import { EditorState, type Transaction } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import { PageReplica } from "../viewer/replica.ts";
import { bindRichEditor } from "../viewer/rich-binding.mjs";
import { PagesWorkspace, type Storage } from "../src/workspace.ts";
import { actorPrefix, newActor, validatePage } from "../src/sync.ts";
import { RICH_FORMAT, richDoc, blockMarkdown, textPath } from "../src/richtext.mjs";
import type { Page, Snapshot } from "../src/document.ts";
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
const principal = "editor-test";
class Memory implements Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, structuredClone(value));
  }
}
async function fixture(source = "The **fox** crossed the garden.") {
  const storage = new Memory(),
    room = new PagesWorkspace({ storage });
  const created = (await room.call(principal, {
    operation: "create_page",
    arguments: {
      title: "Rich page",
      idempotency_key: "rich-fixture",
      block_units: [
        { markdown: source, format: RICH_FORMAT, metadata: { unknown: { keep: true } } },
      ],
    },
  })) as { page_id: string; content: Snapshot };
  return { room, storage, pageId: created.page_id, id: created.content.blocks[0].id };
}
async function peer(pageId: string) {
  const replica = new PageReplica(
    principal,
    pageId,
    () => {},
    () => {},
    async () => true,
  );
  replica.doc = A.init<Page>({ actor: newActor(await actorPrefix(principal)) });
  return { replica, local: A.initSyncState(), remote: A.initSyncState() };
}
async function sync(room: PagesWorkspace, p: Awaited<ReturnType<typeof peer>>) {
  for (let i = 0; i < 20; i++) {
    const out = await room.generateSync(p.replica.pageId!, p.remote);
    p.remote = out.state;
    if (out.message) {
      p.replica["willChange"]();
      [p.replica.doc, p.local] = A.receiveSyncMessage(p.replica.doc!, p.local, out.message);
      p.replica["emit"]();
    }
    const [state, message] = A.generateSyncMessage(p.replica.doc!, p.local);
    p.local = state;
    if (message) p.remote = await room.receiveSync(principal, p.replica.pageId!, p.remote, message);
    if (!out.message && !message) return;
  }
  throw Error("sync did not settle");
}
function editor(replica: PageReplica, id: string) {
  const binding = bindRichEditor(replica, id);
  const view = {
    state: EditorState.create({
      schema: binding.schema,
      doc: binding.pmDoc,
      plugins: [binding.plugin, history()],
    }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  const pluginView = binding.plugin.spec.view!(view as EditorView);
  return {
    view,
    destroy() {
      pluginView.destroy?.();
      binding.destroy();
    },
  };
}
test("rich editor transactions converge through admitted realtime sync, preserve undo, and survive reload", async (t) => {
  const { room, storage, pageId, id } = await fixture(),
    a = await peer(pageId),
    b = await peer(pageId);
  t.after(() => {
    a.replica.dispose();
    b.replica.dispose();
  });
  await sync(room, a);
  await sync(room, b);
  const alice = editor(a.replica, id),
    bob = editor(b.replica, id);
  t.after(() => {
    alice.destroy();
    bob.destroy();
  });
  alice.view.dispatch(alice.view.state.tr.insertText("quick ", 5));
  bob.view.dispatch(bob.view.state.tr.insertText("quiet ", 9));
  await sync(room, a);
  await sync(room, b);
  await sync(room, a);
  assert.deepEqual(A.getHeads(a.replica.doc!), A.getHeads(b.replica.doc!));
  assert.ok(bob.view.state.doc.eq(richDoc(b.replica.doc!.blocks[id])));
  assert.match(blockMarkdown(b.replica.doc!.blocks[id]), /quick/);
  undo(alice.view.state, alice.view.dispatch);
  await sync(room, a);
  await sync(room, b);
  assert.doesNotMatch(blockMarkdown(b.replica.doc!.blocks[id]), /quick/);
  assert.match(blockMarkdown(b.replica.doc!.blocks[id]), /quiet/);
  alice.view.dispatch(alice.view.state.tr.split(5));
  await sync(room, a);
  await sync(room, b);
  alice.view.dispatch(alice.view.state.tr.join(6));
  await sync(room, a);
  await sync(room, b);
  assert.ok(bob.view.state.doc.eq(richDoc(b.replica.doc!.blocks[id])), "remote join projection");
  const restarted = new PagesWorkspace({ storage });
  const result = (await restarted.call(principal, {
    operation: "read_page",
    arguments: { page_id: pageId, view: "full" },
  })) as { content: Snapshot };
  assert.match(result.content.blocks[0].markdown, /quiet/);
  assert.match(result.content.blocks[0].markdown, /\*\*fox\*\*/);
  assert.equal(result.content.blocks[0].richText, undefined, "HTTP uses Markdown projection");
  assert.deepEqual(result.content.blocks[0].metadata, { unknown: { keep: true } });
});
test("semantic Markdown tools update the rich field and its hash guard", async (t) => {
  const { room, pageId, id } = await fixture();
  const p = await peer(pageId);
  t.after(() => p.replica.dispose());
  await sync(room, p);
  const before = (await room.call(principal, {
    operation: "read_page",
    arguments: { page_id: pageId },
  })) as { content: Snapshot };
  await room.call(principal, {
    operation: "patch_page",
    arguments: {
      page_id: pageId,
      base_sequence: before.content.through_sequence,
      idempotency_key: "rich-tool-patch",
      operations: [
        {
          op: "patch_block_markdown",
          block_id: id,
          expected_hash: before.content.blocks[0].hash,
          replacements: [{ old: "fox", new: "otter" }],
        },
      ],
    },
  });
  await sync(room, p);
  assert.match(blockMarkdown(p.replica.doc!.blocks[id]), /\*\*otter\*\*/);
  assert.match(p.replica.doc!.blocks[id].markdown, /fox/, "source is immutable provenance");
  const after = (await room.call(principal, {
    operation: "read_page",
    arguments: { page_id: pageId },
  })) as { content: Snapshot };
  assert.notEqual(after.content.blocks[0].hash, before.content.blocks[0].hash);
});
test("raw ingress rejects provenance writes and unsafe rich links", async (t) => {
  for (const attack of ["provenance", "link"]) {
    const { room, pageId, id } = await fixture();
    const p = await peer(pageId);
    t.after(() => p.replica.dispose());
    await sync(room, p);
    p.replica.doc = A.change(p.replica.doc!, (d) => {
      if (attack === "provenance") A.updateText(d, ["blocks", id, "markdown"], "lost edits");
      else
        A.mark(
          d,
          textPath(id),
          { start: 1, end: 4 },
          "link",
          JSON.stringify({ href: "javascript:alert(1)" }),
        );
    });
    await assert.rejects(sync(room, p), /provenance|Invalid Automerge sync frame/);
  }
});
test("supported and opaque imports are validated without discarding source", async (t) => {
  for (const source of [
    "- one\n- two",
    "[example](https://example.com)",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "```python\nprint(1)\n```",
    "a🌍日本語",
  ]) {
    const { room, pageId, id } = await fixture(source);
    const p = await peer(pageId);
    t.after(() => p.replica.dispose());
    await sync(room, p);
    validatePage(p.replica.doc!, pageId);
    assert.equal(blockMarkdown(p.replica.doc!.blocks[id]), source);
  }
});

test("rich passage comments track peer edits and detach when the passage is deleted", async (t) => {
  const { room, pageId, id } = await fixture();
  const a = await peer(pageId),
    b = await peer(pageId);
  t.after(() => {
    a.replica.dispose();
    b.replica.dispose();
  });
  await sync(room, a);
  await sync(room, b);
  a.replica.comment({
    action: "add",
    block_id: id,
    body: "Keep this passage",
    selected_text: "fox",
  });
  await sync(room, a);
  await sync(room, b);
  const { projectComments } = await import("../src/comments.ts");
  assert.equal(projectComments(b.replica.doc!)[0].selectionContext?.text, "fox");
  b.replica.change((d) => A.splice(d, textPath(id), 1, 0, "Hello "));
  await sync(room, b);
  await sync(room, a);
  assert.equal(projectComments(a.replica.doc!)[0].selectionContext?.text, "fox");
  a.replica.change((d) =>
    A.splice(d, textPath(id), d.blocks[id].richText!.indexOf("fox"), 3, "otter"),
  );
  await sync(room, a);
  await sync(room, b);
  assert.equal(projectComments(b.replica.doc!)[0].detached, true);
});

test("remote illumination follows edits, excludes self echoes, and expires outside undo", async (t) => {
  const { richAttribution, attributionKey } = await import("../viewer/rich-attribution.mjs");
  const { room, pageId, id } = await fixture("Original text"),
    a = await peer(pageId),
    b = await peer(pageId);
  await sync(room, a);
  await sync(room, b);
  let time = 1000;
  const binding = bindRichEditor(b.replica, id);
  const view = {
    state: EditorState.create({
      schema: binding.schema,
      doc: binding.pmDoc,
      plugins: [binding.plugin, history(), richAttribution(b.replica, () => time)],
    }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  const projection = binding.plugin.spec.view!(view as EditorView);
  t.after(() => {
    projection.destroy?.();
    binding.destroy();
    a.replica.dispose();
    b.replica.dispose();
  });
  const marks = () => attributionKey.getState(view.state).find();
  assert.equal(marks().length, 0, "hydration has no illumination");
  view.dispatch(view.state.tr.insertText("Local ", 1));
  await sync(room, b);
  assert.equal(marks().length, 0, "local typing and its echo stay quiet");
  await sync(room, a);
  a.replica.change((d) => A.splice(d, textPath(id), d.blocks[id].richText!.length, 0, " remote"));
  await sync(room, a);
  await sync(room, b);
  const mark = marks()[0];
  assert.ok(mark);
  assert.deepEqual(mark.spec.actors, [A.getActorId(a.replica.doc!)]);
  assert.equal(view.state.doc.textBetween(mark.from, mark.to), " remote");
  view.dispatch(view.state.tr.insertText("Here ", 1));
  assert.equal(marks()[0].from, mark.from + 5, "local typing maps the remote range");
  time += 2001;
  view.dispatch(view.state.tr.setMeta("addToHistory", false));
  assert.equal(marks().length, 0);
  undo(view.state, view.dispatch);
  assert.match(view.state.doc.textContent, / remote$/, "undo preserves remote text");
  await sync(room, b);
  await sync(room, a);
  a.replica.change((d) => A.splice(d, textPath(id), d.blocks[id].richText!.length - 7, 7, ""));
  await sync(room, a);
  await sync(room, b);
  assert.equal(marks().length, 0, "deletion has no invented inserted range");
});
