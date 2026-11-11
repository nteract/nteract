import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { generateNKeysBetween } from "fractional-indexing";
import { INVALID_BLOCK, blockChangeRefusal } from "./block-shape.mjs";

const actor = (n) => n.toString(16).padStart(32, "0");
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const marker = (type, { parents = [], isEmbed = false } = {}) => ({
  type: "block",
  value: {
    type: new A.ImmutableString(type),
    parents: parents.map((parent) => new A.ImmutableString(parent)),
    attrs: {},
    isEmbed,
  },
});

/** Inside a change: a block at `blockId` whose text is `text` in one
 * paragraph under its marker, as every writer writes a new block. */
function putBlock(d, blockId, key, text = "") {
  d.blocks[blockId] = { position: new A.RawString(key), richText: "" };
  A.updateSpans(
    d,
    ["blocks", blockId, "richText"],
    [marker("paragraph"), ...(text ? [{ type: "text", value: text }] : [])],
  );
}

/** A Page with `count` blocks in shape. */
function page(count) {
  const keys = generateNKeysBetween(null, null, count);
  return A.change(A.init({ actor: actor(1) }), { time: 0 }, (d) => {
    d.page_id = "p";
    d.title = "Page";
    d.blocks = {};
    for (let n = 0; n < count; n++)
      putBlock(d, id(n), keys[n], "Lorem ipsum dolor sit amet. ".repeat(4));
  });
}

/** `before` and the result of `edit` by another actor, as admission sees them:
 * the admitted document and a clone with the peer's changes loaded. */
function judge(before, edit, editor = actor(2)) {
  const peer = A.change(A.clone(before, { actor: editor }), { time: 0 }, edit);
  return admit(before, peer);
}

/** Admission of `peer`'s changes into `live`, which may hold changes
 * concurrent with them. */
function admit(live, peer) {
  const after = A.loadIncremental(A.clone(live), A.saveSince(peer, A.getHeads(live)));
  return blockChangeRefusal(after, A.getChangesSince(after, A.getHeads(live)));
}

test("typing, creating, moving and deleting blocks in shape are admitted", () => {
  const base = page(3);
  assert.equal(
    judge(base, (d) => A.splice(d, ["blocks", id(0), "richText"], 2, 1, "xy")),
    null,
  );
  assert.equal(
    judge(base, (d) => putBlock(d, id(9), "a0V")),
    null,
  );
  assert.equal(
    judge(base, (d) => (d.blocks[id(1)].position = new A.RawString("Zz"))),
    null,
  );
  assert.equal(
    judge(base, (d) => delete d.blocks[id(2)]),
    null,
  );
  assert.equal(
    judge(base, (d) => (d.title = "Renamed")),
    null,
  );
});

test("a block a change creates without position or text richText is refused", () => {
  const base = page(1);
  for (const [name, block] of [
    ["no richText", { position: new A.RawString("a1") }],
    ["no position", { richText: "" }],
    ["raw-string richText", { position: new A.RawString("a1"), richText: new A.RawString("x") }],
    ["map richText", { position: new A.RawString("a1"), richText: {} }],
    ["list richText", { position: new A.RawString("a1"), richText: [] }],
    ["text position", { position: "a1", richText: "" }],
    ["number position", { position: 1, richText: "" }],
    ["long position", { position: new A.RawString(`a${"V".repeat(512)}`), richText: "" }],
    ["unordered position", { position: new A.RawString("a10"), richText: "" }],
    ["extra key", { position: new A.RawString("a1"), richText: "", kind: "markdown" }],
  ]) {
    const refused = judge(base, (d) => {
      d.blocks[id(5)] = block;
    });
    assert.equal(refused?.code, INVALID_BLOCK, name);
    assert.equal(refused.block, id(5), name);
    assert.equal(typeof refused.message, "string", name);
  }
});

test("a change may not break an existing block or add a key to it", () => {
  const base = page(2);
  for (const [name, edit] of [
    ["delete richText", (d) => delete d.blocks[id(0)].richText],
    ["delete position", (d) => delete d.blocks[id(0)].position],
    ["replace richText", (d) => (d.blocks[id(0)].richText = new A.RawString("x"))],
    ["position as text", (d) => (d.blocks[id(0)].position = "a2")],
    ["add a key", (d) => (d.blocks[id(0)].note = "x")],
    ["replace the block with text", (d) => (d.blocks[id(0)] = "block")],
    ["replace the block with a list", (d) => (d.blocks[id(0)] = [])],
  ]) {
    const refused = judge(base, edit);
    assert.equal(refused?.code, INVALID_BLOCK, name);
    assert.equal(refused.block, id(0), name);
  }
});

test("blocks must stay a map", () => {
  const base = page(2);
  for (const [name, edit] of [
    ["deleted", (d) => delete d.blocks],
    ["a list", (d) => (d.blocks = [])],
    ["text", (d) => (d.blocks = "none")],
  ]) {
    const refused = judge(base, edit);
    assert.equal(refused?.code, INVALID_BLOCK, name);
    assert.equal(refused.block, undefined, name);
  }
  // A new map of blocks in shape is still a map of blocks in shape, and every
  // block in a new map is checked.
  assert.equal(
    judge(base, (d) => {
      d.blocks = {};
      putBlock(d, id(7), "a0");
    }),
    null,
  );
  assert.equal(
    judge(base, (d) => {
      d.blocks = { [id(0)]: { position: new A.RawString("a0") } };
    })?.block,
    id(0),
  );
});

test("admission judges no marker: any text in a block in shape is admitted", () => {
  // A merge can leave text no marker opens, and every reader reads it. A
  // block's creation and a later merge that unmarks its start can arrive in
  // one frame.
  const base = page(1);
  const text = (value) => ({ type: "text", value });
  for (const [name, spans] of [
    ["no text", []],
    ["text before any marker", [text("x"), marker("paragraph")]],
    ["an embed", [marker("image", { parents: ["paragraph"], isEmbed: true })]],
    ["a nested marker", [marker("paragraph", { parents: ["blockquote"] }), text("x")]],
  ])
    assert.equal(
      judge(base, (d) => {
        d.blocks[id(5)] = { position: new A.RawString("a5"), richText: "" };
        A.updateSpans(d, ["blocks", id(5), "richText"], spans);
      }),
      null,
      name,
    );
  for (const [name, edit] of [
    ["typing before the marker", (d) => A.splice(d, ["blocks", id(0), "richText"], 0, 0, "x")],
    ["deleting the marker", (d) => A.splice(d, ["blocks", id(0), "richText"], 0, 1)],
    ["emptying the text", (d) => A.updateText(d, ["blocks", id(0), "richText"], "")],
  ])
    assert.equal(judge(base, edit), null, name);
});

test("concurrent block writes that are each in shape are admitted in either order", () => {
  const base = page(3);
  const peer = (n, edit) => A.change(A.clone(base, { actor: actor(n) }), { time: 0 }, edit);
  const pairs = {
    "two peers create blocks": [
      peer(2, (d) => putBlock(d, id(10), "a5", "two")),
      peer(3, (d) => putBlock(d, id(11), "a5", "three")),
    ],
    "a delete and typing in the deleted block": [
      peer(2, (d) => delete d.blocks[id(1)]),
      peer(3, (d) => A.splice(d, ["blocks", id(1), "richText"], 0, 0, "typed")),
    ],
    "a move and an edit in the moved block": [
      peer(2, (d) => (d.blocks[id(1)].position = new A.RawString("Zz"))),
      peer(3, (d) => A.splice(d, ["blocks", id(1), "richText"], 4, 2, "")),
    ],
    "two moves of one block": [
      peer(2, (d) => (d.blocks[id(1)].position = new A.RawString("Zz"))),
      peer(3, (d) => (d.blocks[id(1)].position = new A.RawString("a9"))),
    ],
    "a delete and a move of the deleted block": [
      peer(2, (d) => delete d.blocks[id(1)]),
      peer(3, (d) => (d.blocks[id(1)].position = new A.RawString("a9"))),
    ],
  };
  for (const [name, [first, second]] of Object.entries(pairs))
    for (const [a, b] of [
      [first, second],
      [second, first],
    ]) {
      // The host admitted `a`; `b`, made without seeing it, arrives next.
      const live = A.loadIncremental(A.clone(base), A.saveSince(a, A.getHeads(base)));
      assert.equal(admit(base, a), null, name);
      assert.equal(admit(live, b), null, name);
    }
});

test("a change that arrives after its block was deleted is admitted, and a concurrent bad block is not", () => {
  const base = page(2);
  const deleted = A.change(A.clone(base, { actor: actor(2) }), { time: 0 }, (d) => {
    delete d.blocks[id(0)];
  });
  const typing = A.change(A.clone(base, { actor: actor(3) }), { time: 0 }, (d) => {
    A.splice(d, ["blocks", id(0), "richText"], 0, 0, "late");
    d.blocks[id(0)].position = new A.RawString("a00V");
  });
  const live = A.loadIncremental(A.clone(base), A.saveSince(deleted, A.getHeads(base)));
  assert.equal(admit(live, typing), null);
  const bad = A.change(A.clone(base, { actor: actor(4) }), { time: 0 }, (d) => {
    d.blocks[id(5)] = { position: new A.RawString("a5") };
  });
  assert.equal(admit(live, bad)?.code, INVALID_BLOCK);
});

test("a position with a character outside the base-62 digits is refused", () => {
  const base = page(1);
  for (const key of ["a!", "a0!", "a1!V", "!0", "a1 "]) {
    const created = judge(base, (d) => {
      d.blocks[id(5)] = { position: new A.RawString(key), richText: "" };
    });
    assert.equal(created?.code, INVALID_BLOCK, key);
    const moved = judge(base, (d) => (d.blocks[id(0)].position = new A.RawString(key)));
    assert.equal(moved?.code, INVALID_BLOCK, key);
  }
});

/** Two peers that each put a block map without seeing the other: `winner`
 * and `loser` are the edits. The higher actor wins the conflict. */
function rivals(base, winner, loser) {
  return {
    winner: A.change(A.clone(base, { actor: actor(0xff) }), { time: 0 }, winner),
    loser: A.change(A.clone(base, { actor: actor(0x02) }), { time: 0 }, loser),
  };
}

const merged = (base, ...docs) =>
  docs.reduce(
    (live, doc) => A.loadIncremental(live, A.saveSince(doc, A.getHeads(base))),
    A.clone(base),
  );

test("a value that loses a conflict is judged at its own frame, in either arrival order", () => {
  const base = page(1);
  const good = (d) => putBlock(d, id(5), "a5", "good");
  for (const bad of [
    { position: new A.RawString("a5") },
    { position: "a5", richText: "" },
    { position: new A.RawString("a5"), richText: "", note: 1 },
  ]) {
    const { winner, loser } = rivals(base, good, (d) => (d.blocks[id(5)] = bad));
    // The winner arrives first; the hidden loser is refused at its frame.
    const withWinner = merged(base, winner);
    assert.equal(admit(base, winner), null);
    assert.equal(admit(withWinner, loser)?.code, INVALID_BLOCK);
    // The loser arrives first, visible, and is refused; the winner is not.
    assert.equal(admit(base, loser)?.code, INVALID_BLOCK);
  }
  // One level down: a losing position or richText put on an existing block.
  for (const edit of [
    (d) => (d.blocks[id(0)].position = "a5"),
    (d) => (d.blocks[id(0)].richText = new A.RawString("raw")),
  ]) {
    const winner = A.change(A.clone(base, { actor: actor(0xff) }), { time: 0 }, (d) => {
      d.blocks[id(0)].position = new A.RawString("a7");
      d.blocks[id(0)].richText = "won";
    });
    const loser = A.change(A.clone(base, { actor: actor(0x02) }), { time: 0 }, edit);
    assert.equal(admit(merged(base, winner), loser)?.code, INVALID_BLOCK);
    assert.equal(admit(base, loser)?.code, INVALID_BLOCK);
  }
});

test("two valid concurrent replacements are admitted, and a delete that saw one of them is too", () => {
  const base = page(1);
  const { winner, loser } = rivals(
    base,
    (d) => putBlock(d, id(5), "a5", "winner"),
    (d) => putBlock(d, id(5), "a6", "loser"),
  );
  for (const [first, second] of [
    [winner, loser],
    [loser, winner],
  ]) {
    assert.equal(admit(base, first), null);
    const live = merged(base, first, second);
    assert.equal(admit(merged(base, first), second), null);
    // A client that saw only the winner deletes the block. The loser shows.
    const deletes = A.change(A.clone(winner, { actor: actor(0x03) }), { time: 0 }, (d) => {
      delete d.blocks[id(5)];
    });
    assert.equal(admit(live, deletes), null);
    const after = merged(base, first, second, deletes);
    assert.equal(after.blocks[id(5)].richText, "\ufffcloser");
  }
});

test("an edit to a block hidden behind a concurrent value is judged", () => {
  const base = page(1);
  const { winner, loser } = rivals(
    base,
    (d) => putBlock(d, id(5), "a5", "winner"),
    (d) => putBlock(d, id(5), "a6", "loser"),
  );
  const live = merged(base, winner, loser);
  assert.equal(live.blocks[id(5)].richText, "\ufffcwinner");
  // The loser's author, still without the winner, breaks and then edits its
  // block. Neither is visible on the host; both are judged.
  const broken = A.change(A.clone(loser), { time: 0 }, (d) => delete d.blocks[id(5)].richText);
  assert.equal(admit(live, broken)?.code, INVALID_BLOCK);
  const typed = A.change(A.clone(loser), { time: 0 }, (d) =>
    A.splice(d, ["blocks", id(5), "richText"], 1, 0, "more "),
  );
  assert.equal(admit(live, typed), null);
});

/** Median microseconds of blockChangeRefusal per keystroke frame on a Page of
 * `count` blocks, over `frames` frames typed into its first block. */
function keystrokeCost(count, frames = 200) {
  let live = page(count);
  const times = [];
  for (let n = 0; n < frames; n++) {
    const peer = A.change(A.clone(live, { actor: actor(2) }), { time: 0 }, (d) =>
      A.splice(d, ["blocks", id(0), "richText"], 3, 0, "x"),
    );
    const after = A.loadIncremental(A.clone(live), A.saveSince(peer, A.getHeads(live)));
    // The host has the fresh changes before admission runs.
    const fresh = A.getChangesSince(after, A.getHeads(live));
    const started = performance.now();
    assert.equal(blockChangeRefusal(after, fresh), null);
    times.push(performance.now() - started);
    A.free(peer);
    A.free(live);
    live = after;
  }
  A.free(live);
  times.sort((a, b) => a - b);
  return times[times.length >> 1] * 1000;
}

test("the check's cost per keystroke follows the change, not the number of blocks", (t) => {
  keystrokeCost(3, 50);
  const small = keystrokeCost(3);
  const large = keystrokeCost(300);
  t.diagnostic(`median per keystroke: 3 blocks ${small.toFixed(1)} µs, 300 ${large.toFixed(1)} µs`);
  // Walking every block would cost about 100 times as much on 300 blocks.
  assert.ok(
    large < small * 4 + 20,
    `3 blocks: ${small.toFixed(1)} µs, 300: ${large.toFixed(1)} µs`,
  );
});
