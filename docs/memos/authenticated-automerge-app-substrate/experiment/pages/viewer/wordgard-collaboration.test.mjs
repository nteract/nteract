import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Decoration } from "wordgard/editor";
import { applyComment, projectComments } from "../model/comments.mjs";
import { createProgressTargets } from "../model/presence.mjs";
import { enableRich, textPath } from "../model/richtext.mjs";
import { captureCommentDraft, resolveCommentDraft } from "./comment-draft.mjs";
import { decode } from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import {
  createWordgardCollaboration,
  publishWordgardSelection,
  wordgardCommentRanges,
  wordgardCommentSelection,
} from "./wordgard-collaboration.mjs";

function fixture(source = "Same passage here and same passage again 😀.") {
  let doc = A.from({ blocks: {}, comments: {} });
  doc = A.change(doc, (d) => {
    for (const [id, position] of [
      ["first", "a0"],
      ["second", "a1"],
    ]) {
      d.blocks[id] = { id, position, kind: "markdown", markdown: source };
      enableRich(d, id);
    }
  });
  return doc;
}
const current = (doc) => decode(A.spans(doc, textPath("first")));
const entries = (set) => {
  const result = [];
  for (const cursor = set.cursor(); cursor.value; cursor.next())
    result.push({ from: cursor.from, to: cursor.to, value: cursor.value });
  return result;
};
const presence = (doc, from, to = from) => ({
  block_id: "first",
  start: A.getCursor(doc, textPath("first"), from, "after"),
  end: A.getCursor(doc, textPath("first"), to, "before"),
  heads: A.getHeads(doc),
});
function harness(doc) {
  let time = 1000;
  let target = null;
  let focusCount = 0;
  const scrolls = [];
  const publications = [];
  const names = new Map();
  const changeIdentities = new Map();
  const replica = {
    doc,
    peers: new Map(),
    canWrite: true,
    publishPresence: (value) => publications.push(value),
    actorDisplayName: (actor) => names.get(actor) ?? "Collaborator",
    changeIdentity: (hash) => changeIdentities.get(hash) ?? null,
  };
  const editor = {
    hasFocus: true,
    state: { selection: { anchor: 1, head: 1 } },
    focus() {
      focusCount++;
    },
    domAtPos(position) {
      return {
        node: {
          nodeType: 3,
          parentElement: { scrollIntoView: (opts) => scrolls.push({ position, opts }) },
        },
      };
    },
  };
  const collaboration = createWordgardCollaboration({
    replica,
    id: "first",
    getEditor: () => editor,
    getCurrent: () => current(replica.doc),
    getThreads: () => projectComments(replica.doc),
    getTarget: () => target,
    now: () => time,
  });
  return {
    changeIdentities,
    replica,
    editor,
    collaboration,
    publications,
    scrolls,
    names,
    focusCount: () => focusCount,
    setTime: (value) => {
      time = value;
    },
    setTarget: (value) => {
      target = value;
    },
  };
}

test("native Wordgard selections publish backwards cursors and preserve repeated Unicode comment passages", () => {
  const h = harness(fixture("repeat 😀 and repeat 😀"));
  const source = h.replica.doc.blocks.first.richText;
  const from = source.lastIndexOf("repeat 😀");
  const to = from + "repeat 😀".length;
  const { map } = current(h.replica.doc);
  h.editor.state.selection = { anchor: map.amToWg[to], head: map.amToWg[from] };
  const heads = A.getHeads(h.replica.doc);
  publishWordgardSelection(h.replica, "first", h.editor, map);
  const value = h.publications[0];
  assert.equal(value.backward, true);
  assert.equal(A.getCursorPosition(h.replica.doc, textPath("first"), value.start), from);
  assert.equal(A.getCursorPosition(h.replica.doc, textPath("first"), value.end), to);
  assert.deepEqual(value.heads, heads);
  const selection = wordgardCommentSelection(h.replica, "first", h.editor, map);
  assert.deepEqual(selection, { text: "repeat 😀", occurrence: 2 });
  const draft = captureCommentDraft(h.replica.doc, "first", selection);
  h.replica.doc = A.change(h.replica.doc, (d) =>
    A.splice(d, textPath("first"), 0, 0, "repeat 😀 "),
  );
  assert.deepEqual(resolveCommentDraft(h.replica.doc, draft), {
    block_id: "first",
    selected_text: "repeat 😀",
    occurrence: 3,
  });
  h.editor.hasFocus = false;
  publishWordgardSelection(h.replica, "first", h.editor, map);
  assert.equal(h.publications.length, 1);
});

test("collapsed, invalid, and structure-only selections cannot become comments", () => {
  const h = harness(fixture("# Heading\n\nText"));
  const { map } = current(h.replica.doc);
  const marker = h.replica.doc.blocks.first.richText.indexOf("\ufffc");
  for (const selection of [
    { anchor: 1, head: 1 },
    { anchor: -1, head: 1 },
    { anchor: map.amToWg[marker], head: map.amToWg[marker + 1] },
  ]) {
    h.editor.state.selection = selection;
    assert.equal(wordgardCommentSelection(h.replica, "first", h.editor, map), null);
  }
});

test("presence holds a causal cursor while newer heads are pending, then follows the arriving text", () => {
  const h = harness(fixture("Hello world"));
  const source = h.replica.doc.blocks.first.richText;
  const at = source.indexOf("world");
  h.replica.peers.set("peer", {
    value: { ...presence(h.replica.doc, at, at + 5), name: "Untrusted" },
    at: 1000,
    displayName: "Kyle Kelley · Browser",
  });
  const first = h.collaboration.carets();
  assert.equal(first.length, 1);
  assert.equal(first[0].session, "peer");
  assert.equal(first[0].displayName, "Kyle Kelley · Browser");
  assert.equal(first[0].position, current(h.replica.doc).map.amToWg[at + 5]);
  assert.ok(
    entries(h.collaboration.ranges())[0].value.eq(
      Decoration.Range.wrapper("span", {
        attributes: {
          class: "peer-selection",
          title: "Kyle Kelley · Browser",
          style: `--peer-color: ${first[0].color.background}`,
        },
      }),
    ),
  );
  const remote = A.change(A.clone(h.replica.doc), (d) =>
    A.splice(d, textPath("first"), at, 0, "new "),
  );
  h.replica.peers.set("peer", {
    value: presence(remote, at + 4, at + 9),
    at: 1100,
    displayName: "Kyle Kelley · Browser",
  });
  assert.equal(
    h.collaboration.carets()[0].position,
    first[0].position,
    "missing heads keep the prior causal cursor",
  );
  h.replica.doc = A.merge(h.replica.doc, remote);
  assert.equal(h.collaboration.carets()[0].position, current(h.replica.doc).map.amToWg[at + 9]);
  h.replica.peers.delete("peer");
  assert.equal(h.collaboration.carets().length, 0, "explicit departure clears cached presence");
});

test("presence cache expires and cannot cross blocks or replaced native text objects", () => {
  const h = harness(fixture("Hello world"));
  const peer = { value: presence(h.replica.doc, 3), at: 1000, displayName: "Kyle Kelley" };
  h.replica.peers.set("peer", peer);
  assert.equal(h.collaboration.carets().length, 1);
  h.setTime(31001);
  assert.equal(h.collaboration.carets().length, 0);
  h.setTime(1000);
  h.replica.peers.set("peer", peer);
  assert.equal(h.collaboration.carets().length, 1);
  h.replica.peers.set("peer", { ...peer, value: { ...peer.value, block_id: "second" } });
  assert.equal(h.collaboration.carets().length, 0);
  h.replica.peers.set("peer", { ...peer, value: { ...peer.value, heads: ["a".repeat(64)] } });
  assert.equal(
    h.collaboration.carets().length,
    0,
    "returning with unseen heads cannot revive a different-block cursor",
  );
  h.replica.peers.set("peer", peer);
  assert.equal(h.collaboration.carets().length, 1);
  h.replica.doc = A.change(h.replica.doc, (d) => {
    delete d.blocks.first.richText;
  });
  h.replica.doc = A.change(h.replica.doc, (d) => {
    d.blocks.first.richText = "Different text";
  });
  assert.equal(h.collaboration.carets().length, 0);
});

test("native comment anchors follow edits and choose active or narrower overlapping passages", () => {
  let doc = fixture("Same passage here and same passage again");
  const ids = {};
  doc = A.change(doc, (d) => {
    for (const [name, block_id, selected_text] of [
      ["wide", "first", "Same passage here"],
      ["narrow", "first", "passage"],
      ["other", "second", "passage"],
    ])
      ids[name] = applyComment(d, { action: "add", block_id, selected_text, body: name }).thread_id;
  });
  const h = harness(doc);
  const range = () =>
    wordgardCommentRanges(
      h.replica.doc,
      "first",
      current(h.replica.doc).map,
      projectComments(h.replica.doc),
    ).find((value) => value.id === ids.narrow);
  assert.equal(h.collaboration.commentAtPosition(range().from + 1), ids.narrow);
  h.setTarget({ id: ids.wide });
  assert.equal(h.collaboration.commentAtPosition(range().from + 1), ids.wide);
  h.replica.doc = A.change(h.replica.doc, (d) => A.splice(d, textPath("first"), 0, 0, "More "));
  assert.equal(h.collaboration.commentAtPosition(range().from + 1), ids.wide);
  h.replica.doc = A.change(h.replica.doc, (d) =>
    applyComment(d, { action: "resolve", thread_id: ids.wide }),
  );
  assert.equal(h.collaboration.commentAtPosition(range().from + 1), ids.narrow);
  assert.equal(
    entries(h.collaboration.ranges()).length,
    2,
    "an active resolved thread remains visible alongside open passage",
  );
  const context = projectComments(h.replica.doc).find(
    (thread) => thread.id === ids.narrow,
  ).selectionContext;
  h.replica.doc = A.change(h.replica.doc, (d) =>
    A.splice(
      d,
      textPath("first"),
      context.start.offsetUtf16,
      context.end.offsetUtf16 - context.start.offsetUtf16,
      "",
    ),
  );
  assert.equal(
    h.collaboration.commentAtPosition(5),
    null,
    "deleted quote never jumps to repeated words",
  );
});

test("revealing a comment preserves selection, reply focus, read-only state, and native heads", () => {
  let doc = fixture();
  let thread;
  doc = A.change(doc, (d) => {
    thread = applyComment(d, {
      action: "add",
      block_id: "first",
      selected_text: "passage",
      body: "Look here",
    }).thread_id;
  });
  const h = harness(doc);
  const selection = h.editor.state.selection;
  const heads = A.getHeads(doc);
  assert.equal(h.collaboration.revealThread(thread), true);
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.focusCount(), 0);
  assert.equal(h.editor.state.selection, selection);
  h.replica.canWrite = false;
  h.collaboration.revealThread(thread, { focus: true, scroll: false });
  assert.equal(h.focusCount(), 0);
  h.editor.composing = true;
  assert.equal(h.collaboration.revealThread(thread), false);
  assert.deepEqual(A.getHeads(h.replica.doc), heads);
});

test("remote illumination follows native cursors, refreshes trusted names, and expires without document writes", () => {
  const h = harness(fixture("Hello world"));
  const before = h.replica.doc;
  const at = before.blocks.first.richText.indexOf("world");
  const after = A.change(A.clone(before), (d) => A.splice(d, textPath("first"), at, 0, "😀 new "));
  h.replica.doc = after;
  const decoded = current(after);
  h.collaboration.observeChange({
    nativeBefore: before,
    nativeAfter: after,
    before: current(before),
    after: decoded,
    changes: projectChanges(current(before).doc, decoded.doc),
    actors: [A.getActorId(after)],
    remote: true,
  });
  assert.ok(entries(h.collaboration.ranges()).length > 0);
  h.names.set(A.getActorId(after), "Kyle Kelley · Codex");
  const mark = entries(h.collaboration.ranges())[0];
  assert.ok(
    mark.value.eq(
      Decoration.Range.wrapper("span", {
        attributes: { class: "remote-edit", title: "Edited by Kyle Kelley · Codex" },
      }),
    ),
  );
  h.replica.doc = A.change(h.replica.doc, (d) => A.splice(d, textPath("first"), 0, 0, "prefix "));
  assert.ok(entries(h.collaboration.ranges())[0].from > mark.from);
  const heads = A.getHeads(h.replica.doc);
  h.setTime(3000);
  assert.equal(entries(h.collaboration.ranges()).length, 0);
  assert.deepEqual(A.getHeads(h.replica.doc), heads);
});

test("illumination ignores own changes and does not attach to surviving text after a deletion", () => {
  const h = harness(fixture("Hello world"));
  const before = h.replica.doc;
  const at = before.blocks.first.richText.indexOf("world");
  const after = A.change(A.clone(before), (d) => A.splice(d, textPath("first"), at, 0, "XYZ "));
  h.replica.doc = after;
  const event = {
    nativeBefore: before,
    nativeAfter: after,
    after: current(after),
    changes: projectChanges(current(before).doc, current(after).doc),
    actors: [A.getActorId(after)],
  };
  h.collaboration.observeChange({ ...event, remote: false });
  assert.equal(entries(h.collaboration.ranges()).length, 0);
  h.collaboration.observeChange({ ...event, remote: true });
  assert.ok(entries(h.collaboration.ranges()).length > 0);
  h.replica.doc = A.change(h.replica.doc, (d) => A.splice(d, textPath("first"), at, 4, ""));
  assert.equal(entries(h.collaboration.ranges()).length, 0);
  h.collaboration.destroy();
});

test("agent progress decorates anchored Wordgard text without publishing a caret or changing content", () => {
  const h = harness(fixture("Hello **world** and goodbye."));
  const targets = createProgressTargets(
    h.replica.doc,
    [{ block_id: "first", match_text: "world" }],
    A.getHeads(h.replica.doc),
  );
  const progress = {
    progress_id: "agent",
    displayName: "Kyle",
    driver: "ChatGPT",
    message: "Reviewing this passage",
    targets,
    until: 2000,
  };
  h.replica.agentProgress = new Map([["agent", progress]]);
  const heads = A.getHeads(h.replica.doc);
  const ranges = entries(h.collaboration.ranges());
  assert.equal(ranges.length, 1);
  assert.ok(
    ranges[0].value.eq(
      Decoration.Range.wrapper("span", {
        attributes: {
          class: "agent-progress-passage",
          title: "ChatGPT on behalf of Kyle: Reviewing this passage",
          "data-progress-id": "agent",
          "data-progress-target": "0",
        },
      }),
    ),
  );
  assert.deepEqual(h.collaboration.carets(), []);
  assert.deepEqual(h.publications, []);
  assert.deepEqual(A.getHeads(h.replica.doc), heads);
  h.replica.doc = A.change(h.replica.doc, (d) => A.splice(d, textPath("first"), 0, 0, "Prefix "));
  assert.ok(entries(h.collaboration.ranges())[0].from > ranges[0].from);
  h.setTime(2000);
  assert.equal(entries(h.collaboration.ranges()).length, 0);
  h.setTime(1000);
  h.replica.doc = A.change(h.replica.doc, (d) => {
    d.blocks.first.richText = "Replacement";
  });
  assert.equal(entries(h.collaboration.ranges()).length, 0);
});

const agent = (doc, targets, extra = {}) => ({
  agent_id: "agent-1",
  principal: "user:kyle",
  displayName: "Kyle Kelley",
  driver: "Kilo",
  state: "active",
  seq: 1,
  targets,
  until: 1_000_000,
  ...extra,
});
const textAt = (doc, kind, from, to) => ({ kind, ...presence(doc, from, to) });

test("an agent write fills the changed text, then collapses to a labeled caret", () => {
  const doc = fixture("Ship on Tuesday morning.");
  const h = harness(doc);
  const at = "Ship on ".length;
  h.replica.agentPresence = new Map([
    ["agent-1", agent(doc, [textAt(doc, "text", at, at + "Tuesday morning".length)])],
  ]);
  const map = current(doc).map;
  let [caret] = h.collaboration.carets();
  assert.equal(caret.type, "caret");
  assert.equal(caret.displayName, "Kyle Kelley's Kilo");
  assert.equal(caret.tag, "agent");
  assert.equal(caret.title, "Kilo on behalf of Kyle Kelley");
  assert.equal(caret.position, map.amToWg[at + "Tuesday morning".length]);
  let fills = entries(h.collaboration.ranges()).filter((e) =>
    (e.value.elt.attrs[e.value.elt.attrs.indexOf("class") + 1] ?? "").includes("agent-selection"),
  );
  assert.equal(fills.length, 1);
  assert.equal(fills[0].from, map.amToWg[at]);
  assert.equal(h.collaboration.nextRepaint(), 600);

  h.setTime(1600);
  fills = entries(h.collaboration.ranges()).filter((e) =>
    (e.value.elt.attrs[e.value.elt.attrs.indexOf("class") + 1] ?? "").includes("agent-selection"),
  );
  assert.equal(fills.length, 0, "the select beat ends");
  assert.equal(h.collaboration.nextRepaint(), null);
  [caret] = h.collaboration.carets();
  assert.equal(caret.type, "caret");

  // Idle: still placed, faded, no fill.
  h.replica.agentPresence.get("agent-1").state = "idle";
  [caret] = h.collaboration.carets();
  assert.equal(caret.idle, true);

  // A new write (next seq) gets its own beat.
  h.replica.agentPresence.set("agent-1", agent(doc, [textAt(doc, "text", 0, 4)], { seq: 2 }));
  assert.equal(h.collaboration.nextRepaint(), 600);
});

test("reading shows a margin bar per passage, fills search hits, and labels once", () => {
  const doc = fixture("fade here and fade there");
  const h = harness(doc);
  h.replica.agentPresence = new Map([
    [
      "agent-1",
      agent(doc, [textAt(doc, "hit", 0, 4), textAt(doc, "hit", 14, 18)], { state: "reading" }),
    ],
  ]);
  const bars = h.collaboration.carets();
  assert.deepEqual(
    bars.map((bar) => [bar.type, bar.label]),
    [
      ["bar", "Kyle Kelley's Kilo is reading"],
      ["bar", ""],
    ],
  );
  const fills = entries(h.collaboration.ranges()).filter((e) =>
    (e.value.elt.attrs[e.value.elt.attrs.indexOf("class") + 1] ?? "").includes("agent-selection"),
  );
  assert.equal(fills.length, 2);
});

test("block targets become a corner dot; other blocks and expired agents show nothing", () => {
  const doc = fixture();
  const h = harness(doc);
  h.replica.agentPresence = new Map([
    ["a", agent(doc, [{ kind: "block", block_id: "first" }])],
    ["b", agent(doc, [{ kind: "block", block_id: "second" }], { agent_id: "b" })],
    ["c", agent(doc, [{ kind: "block", block_id: "first" }], { agent_id: "c", until: 10 })],
  ]);
  const shown = h.collaboration.carets();
  assert.deepEqual(
    shown.map((entry) => [entry.type, entry.session]),
    [["dot", "agent:agent-1"]],
  );
});

test("a session label follows the account and harness", () => {
  const doc = fixture();
  const h = harness(doc);
  h.replica.agentPresence = new Map([
    ["a", agent(doc, [{ kind: "block", block_id: "first" }], { agent: "release agent" })],
  ]);
  const [dot] = h.collaboration.carets();
  assert.equal(dot.displayName, "Kyle Kelley's Kilo · release agent");
  assert.equal(dot.title, "Kilo on behalf of Kyle Kelley (release agent)");
});

test("an agent's newest progress message rides on its caret", () => {
  const doc = fixture();
  const h = harness(doc);
  h.replica.agentPresence = new Map([
    ["a", agent(doc, [{ kind: "block", block_id: "first" }], { agent: "release agent" })],
  ]);
  const progress = (id, message, until, extra = {}) => [
    id,
    {
      progress_id: id,
      principal: "user:kyle",
      displayName: "Kyle Kelley",
      driver: "Kilo",
      agent: "release agent",
      message,
      until,
      targets: [],
      ...extra,
    },
  ];
  h.replica.agentProgress = new Map([
    // Equal expiries: the later accepted update wins.
    progress("p1", "Reading the rollout", 9000, { updated: 100 }),
    progress("p2", "Fixing the table", 9000, { updated: 200 }),
    progress("p3", "Another session", 9999, { agent: "rich text", updated: 300 }),
  ]);
  const [dot] = h.collaboration.carets();
  assert.equal(dot.message, "Fixing the table");
  assert.equal(dot.title, "Kilo on behalf of Kyle Kelley (release agent): Fixing the table");
  h.replica.agentProgress = new Map();
  assert.equal(h.collaboration.carets()[0].message, "");
});

// Insert text into the first block as one or more changes by fresh actors,
// then feed the viewer one sync event carrying all of them.
function batch(h, edits) {
  const before = h.replica.doc;
  const heads = A.getHeads(before);
  let doc = before;
  for (const [actor, apply] of edits)
    doc = A.change(A.clone(doc, { actor }), (d) => apply(d, textPath("first")));
  const metas = A.getChangesMetaSince(doc, heads);
  h.replica.doc = doc;
  h.collaboration.observeChange({
    nativeBefore: before,
    nativeAfter: doc,
    before: current(before),
    after: current(doc),
    changes: projectChanges(current(before).doc, current(doc).doc),
    actors: [...new Set(metas.map((m) => m.actor))],
    hashes: metas.map((m) => m.hash),
    changeOps: metas.map(({ hash, actor, startOp, maxOp }) => ({ hash, actor, startOp, maxOp })),
    remote: true,
  });
  return metas.map((m) => m.hash);
}
const marks = (h) =>
  entries(h.collaboration.ranges()).map((e) => {
    const attrs = e.value.elt.attrs;
    const at = attrs.indexOf("style");
    return {
      from: e.from,
      to: e.to,
      style: at < 0 ? null : attrs[at + 1],
      title: attrs[attrs.indexOf("title") + 1],
    };
  });

test("the edit underline takes the editor's caret color only from a host-attested change", async () => {
  const { presenceColor } = await import("./presence-color.mjs");
  const h = harness(fixture("Hello world"));
  const at = h.replica.doc.blocks.first.richText.indexOf("world");
  const [hash] = batch(h, [["a1".repeat(16), (d, path) => A.splice(d, path, at, 0, "new ")]]);
  assert.equal(marks(h)[0].style, null, "unknown author: neutral");
  h.changeIdentities.set(hash, {
    principal: "user:kyle",
    displayName: "Kyle Kelley",
    driver: "Kilo",
    agent: "rich text",
  });
  const [mark] = marks(h);
  assert.equal(
    mark.style,
    `--peer-color: ${presenceColor("user:kyle", "Kilo", "rich text").background}`,
  );
  assert.equal(mark.title, "Edited by Kyle Kelley · Kilo · rich text");
});

test("adjacent and interleaved inserts from two agents in one batch keep their own colors", async () => {
  const { presenceColor } = await import("./presence-color.mjs");
  const ALPHA = { principal: "user:kyle", driver: "Kilo", agent: "release agent" };
  const OMEGA = { principal: "user:kyle", driver: "Kilo", agent: "rich text" };
  const color = (who) =>
    `--peer-color: ${presenceColor(who.principal, who.driver, who.agent).background}`;
  // Adjacent: B types right after A's text, so the projection merges them.
  {
    const h = harness(fixture("one two"));
    const [a, b] = batch(h, [
      ["a2".repeat(16), (d, path) => A.splice(d, path, 0, 0, "AAAA")],
      ["b2".repeat(16), (d, path) => A.splice(d, path, 4, 0, "BBBB")],
    ]);
    h.changeIdentities.set(a, ALPHA);
    h.changeIdentities.set(b, OMEGA);
    assert.deepEqual(
      marks(h).map((m) => m.style),
      [color(ALPHA), color(OMEGA)],
    );
  }
  // Interleaved: B inserts inside A's fresh text.
  {
    const h = harness(fixture("one two"));
    const [a, b] = batch(h, [
      ["a3".repeat(16), (d, path) => A.splice(d, path, 0, 0, "AAAAAA")],
      ["b3".repeat(16), (d, path) => A.splice(d, path, 3, 0, "BB")],
    ]);
    h.changeIdentities.set(a, ALPHA);
    h.changeIdentities.set(b, OMEGA);
    assert.deepEqual(
      marks(h).map((m) => m.style),
      [color(ALPHA), color(OMEGA), color(ALPHA)],
    );
  }
});

test("formatting-only changes and unknown changes stay neutral", () => {
  const h = harness(fixture("Hello world"));
  // Bold existing text: no character in the range was written by this batch.
  const [hash] = batch(h, [
    [
      "a4".repeat(16),
      (d, path) => A.mark(d, path, { start: 1, end: 6, expand: "none" }, "strong", true),
    ],
  ]);
  h.changeIdentities.set(hash, { principal: "user:kyle", driver: "Kilo", agent: "rich text" });
  const found = marks(h);
  assert.ok(found.length > 0, "the formatting change is illuminated");
  for (const mark of found) assert.equal(mark.style, null);
});
