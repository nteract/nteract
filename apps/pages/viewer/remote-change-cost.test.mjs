import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo";
import { PageSession } from "./session.mjs";
import { applyPageOperation, createPageData, initializePage } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { blockAddress } from "../model/addresses.mjs";
import { pageHeadingAnchors } from "../model/heading-anchors.mjs";
import { commentThreads } from "../model/comments-doc.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import { browser as syncBrowser, host as syncHost, until } from "../sync/test-helpers.mjs";
import { framePipe } from "../sync/wire.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { createWordgardCollaboration } from "./wordgard-collaboration.mjs";
import { threadLocation } from "./comment-thread-display.mjs";

// What one remote change costs the browser, in work rather than time: a
// Page shaped like a long working document receives edits from another
// writer through the real path (host, backend, Repo, PageSession, one
// binding per block, comment anchors), and the test counts whole-document
// loads, whole-block span reads and cursor resolutions per change.

// Counts Automerge backend calls through the prototype every document
// shares. A load materializes a document's root; an empty document (A.init)
// has no heads and isn't counted.
function countWork() {
  const proto = Object.getPrototypeOf(A.getBackend(A.init()));
  const counts = { loads: 0, saves: 0, spans: new Map(), cursors: 0 };
  const originals = {};
  const wrap = (name, count) => {
    originals[name] = proto[name];
    proto[name] = function (...args) {
      count.call(this, args);
      return originals[name].apply(this, args);
    };
  };
  wrap("materialize", function ([path, heads]) {
    if (path === "/" && heads === undefined && this.getHeads().length) counts.loads++;
  });
  wrap("save", () => counts.saves++);
  wrap("spans", ([obj]) => counts.spans.set(obj, (counts.spans.get(obj) ?? 0) + 1));
  wrap("getCursorPosition", () => counts.cursors++);
  return {
    counts,
    take() {
      const taken = {
        loads: counts.loads,
        saves: counts.saves,
        spans: new Map(counts.spans),
        cursors: counts.cursors,
      };
      counts.loads = counts.saves = counts.cursors = 0;
      counts.spans.clear();
      return taken;
    },
    restore() {
      for (const [name, original] of Object.entries(originals)) proto[name] = original;
    },
  };
}

function fakeBrowser(t) {
  const values = new Map();
  const locks = new Set();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(key, _options, callback) {
          if (locks.has(key)) return callback(null);
          locks.add(key);
          try {
            return await callback({ name: key });
          } finally {
            locks.delete(key);
          }
        },
      },
    },
  });
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
    delete globalThis.sessionStorage;
  });
}

// The fixture: about 100 KB of Markdown in one block of 136 top-level nodes
// (headings, lists, tables, a TypeScript code block at node 101), then three
// smaller blocks, one with its own code block.
const prose = (n) =>
  `Paragraph ${n}: the session owns the document and the transport, and the ` +
  `viewer projects each block into the editor and maps selections back.`;
const code = (count) =>
  "```ts\n" +
  Array.from(
    { length: count },
    (_, i) =>
      `export interface Shape${i}<T extends Record<string, unknown>> {\n` +
      `  readonly id: \`shape-\${string}-${i}\`; // trailing comment\n}`,
  ).join("\n") +
  "\n```";
function largeBlock() {
  const nodes = [];
  for (let n = 0; nodes.length < 136; n++) {
    if (nodes.length === 100) nodes.push(code(30));
    else if (n % 12 === 0) nodes.push(`${"#".repeat(1 + (n % 4))} Section ${n}`);
    else if (n % 12 === 3) {
      const rows = ["| A | B | C | D | E |", "| --- | --- | --- | --- | --- |"];
      for (let r = 0; r < 15; r++)
        rows.push(`| row ${r} | ${r * 3} | \`c${r}\` | **b${r}** | t${r} |`);
      nodes.push(rows.join("\n"));
    } else if (n % 2 === 1)
      nodes.push(Array.from({ length: 8 }, (_, k) => `- item ${k}: ${prose(n)}`).join("\n"));
    else nodes.push([prose(n), prose(n + 1), prose(n + 2), prose(n + 3)].join(" "));
  }
  return nodes.join("\n\n");
}
function fixture(pageId) {
  return A.change(A.from(createPageData({ pageId, title: "Working notes" })), (doc) => {
    initializePage(doc, largeBlock());
    for (const markdown of [
      "A short second block.",
      [prose(1), "## Types", code(20), prose(2)].join("\n\n"),
      "A short last block.",
    ]) {
      const after = blockAddress(doc, orderedBlockIds(doc).at(-1));
      applyPageOperation(doc, {
        operation: "edit_page",
        arguments: { operations: [{ op: "insert_markdown", after_node_id: after, markdown }] },
      });
    }
  });
}

const hexOf = (documentId) => Buffer.from(documentIdToBinary(documentId)).toString("hex");
const textPath = (id) => ["blocks", id, "richText"];

test("a remote change costs work in the blocks it touched, never a whole-document load", async (t) => {
  fakeBrowser(t);
  t.mock.method(PageSession.prototype, "retryConnection", async () => {});
  const auth = {
    identity: { principal: crypto.randomUUID(), displayName: "Kyle", driver: "Browser" },
    canWrite: true,
  };
  const pageId = crypto.randomUUID();
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const page = fixture(pageId);
  const blocks = orderedBlockIds(page);
  assert.equal(blocks.length, 4);
  assert.ok(page.blocks[blocks[0]].richText.length > 90_000, "a large first block");
  const h = await syncHost();
  await h.seed(hexOf(documentId), "page", page);
  // Discovery and the socket, as the host answers them. Receipts fail
  // offline: the work counted is the browser's, before the network.
  t.mock.method(PageSession.prototype, "connect", async function () {
    this.connection = { documentId, serverSenderId: h.hostId, peerProfiles: {} };
    const link = framePipe();
    h.accept(link.host, {
      principal: this.identity.principal,
      sessionId: `s-${this.senderId}`,
      senderId: this.senderId,
      role: "owner",
    });
    this.backend.addConnection(link.client, { hostId: h.hostId });
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("offline");
  };
  t.after(() => (globalThis.fetch = previousFetch));

  const session = await PageSession.open(pageId, { authentication: auth });
  t.after(() => session.close());
  await until(() => session.doc && orderedBlockIds(session.doc).length === 4, { label: "open" });

  // Two open comments in the large block and one in the third.
  let comments = newCommentsDoc();
  for (const [block, selected_text] of [
    [blocks[0], "Section 24"],
    [blocks[0], "interface Shape3<T"],
    [blocks[2], "## Types"],
  ])
    ({ comments } = comment(session.doc, comments, {
      action: "add",
      block_id: block,
      selected_text: selected_text.replace("## ", ""),
      body: "Note",
    }));
  const threads = Object.entries(commentThreads(comments)).map(([id, thread]) => ({
    ...thread,
    id,
    state: "open",
  }));

  // One editor per block, as the Page draws them.
  const editors = blocks.map((id) => {
    const binding = createWordgardBinding(session, id);
    const collaboration = createWordgardCollaboration({
      replica: session,
      id,
      getEditor: () => null,
      getCurrent: () => binding.current,
      getThreads: () => threads,
    });
    return { id, binding, collaboration };
  });
  t.after(() => editors.forEach(({ binding }) => binding.destroy()));
  // Every editor update recomputes its decorations; a selection change is
  // an update with no document change. The pointer over the Page looks up
  // its heading anchors (HeadingAnchors.jsx), and the open comments panel
  // places each thread under its headings (CommentsPanel.jsx).
  const update = () => {
    pageHeadingAnchors(session.doc);
    for (const thread of threads) threadLocation(session.doc, thread);
    return editors.map(({ collaboration }) => collaboration.ranges().size);
  };
  update();

  const writer = await syncBrowser(h, { principal: "account:agent" });
  const handle = await writer.repo.find(stringifyAutomergeUrl({ documentId }));
  await until(() => handle.doc()?.blocks?.[blocks[3]], { label: "the writer has the Page" });

  // Settle the open's own checkpoint writes before counting.
  clearTimeout(session.savedTimer);
  await session.saveReceipt();
  await session.cacheTail;
  const work = countWork();
  t.after(() => work.restore());
  // A span read names its text by object ID or by path from the block.
  const readsOf = (spans, id) => {
    const text = A.getObjectId(session.doc.blocks[id], "richText");
    const block = A.getObjectId(session.doc.blocks[id]);
    return (spans.get(text) ?? 0) + (spans.get(`${block}/richText`) ?? 0);
  };
  const CHANGES = 4;
  const perChange = [];
  for (let i = 0; i < CHANGES; i++) {
    // Alternate between the large block and the third block.
    const target = blocks[i % 2 === 0 ? 0 : 2];
    handle.change((doc) => A.splice(doc, textPath(target), 40 + i, 0, "x"));
    const heads = A.getHeads(handle.doc());
    await until(() => A.hasHeads(session.doc, heads), { label: `change ${i} arrives` });
    update();
    // Selection changes: updates with no document change.
    update();
    update();
    clearTimeout(session.savedTimer);
    await session.saveReceipt();
    perChange.push({ target, ...work.take() });
  }
  if (process.env.SHOW_COST)
    console.log(
      "per remote change:",
      perChange.map(({ loads, saves, spans, cursors }) => ({
        loads,
        saves,
        spanReads: [...spans.values()].reduce((a, b) => a + b, 0),
        cursors,
      })),
    );
  for (const [i, change] of perChange.entries()) {
    const label = `change ${i}`;
    // The local checkpoint stores the new snapshot. The stored one is the
    // snapshot this session wrote before, which the new one holds, so the
    // merge check loads neither.
    assert.equal(change.saves, 1, `${label}: one checkpoint save`);
    assert.equal(change.loads, 0, `${label}: whole-document loads`);
    // A plain-text edit is carried into the binding's projection without a
    // whole-block read. The heading anchors and the comment outline each read
    // the edited block once, and no other block.
    for (const id of blocks)
      assert.equal(
        readsOf(change.spans, id),
        id === change.target ? 2 : 0,
        `${label}: span reads of block ${blocks.indexOf(id)}`,
      );
    assert.equal(
      [...change.spans.values()].reduce((sum, n) => sum + n, 0),
      2,
      `${label}: every span read is accounted for`,
    );
    // Each comment in the edited block resolves its two cursors once; the
    // other blocks' comments and the selection-only updates resolve none.
    const anchored = threads.filter((thread) => thread.target.anchor.blockId === change.target);
    assert.equal(change.cursors, anchored.length * 2, `${label}: cursor resolutions`);
  }
});
