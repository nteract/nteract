import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { generateNKeysBetween } from "fractional-indexing";
import { INVALID_BLOCK, blockChangeRefusal } from "./block-shape.mjs";

const actor = (n) => n.toString(16).padStart(32, "0");
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const LEGACY_KEYS = ["id", "kind", "format", "markdown", "metadata"];

/** A Page with `count` blocks in shape. `legacy` adds the earlier format's
 * five extra keys to each. */
function page(count, { legacy = false } = {}) {
  const keys = generateNKeysBetween(null, null, count);
  return A.change(A.init({ actor: actor(1) }), { time: 0 }, (d) => {
    d.page_id = "p";
    d.title = "Page";
    d.blocks = {};
    for (let n = 0; n < count; n++)
      d.blocks[id(n)] = {
        position: new A.RawString(keys[n]),
        richText: "Lorem ipsum dolor sit amet. ".repeat(4),
        ...(legacy && {
          id: id(n),
          kind: "markdown",
          format: "rich",
          markdown: "",
          metadata: {},
        }),
      };
  });
}

/** `before` and the result of `edit` by another actor, as admission sees them:
 * the admitted document and a clone with the peer's changes loaded. */
function judge(before, edit, editor = actor(2)) {
  const peer = A.change(A.clone(before, { actor: editor }), { time: 0 }, edit);
  const after = A.loadIncremental(A.clone(before), A.saveSince(peer, A.getHeads(before)));
  return blockChangeRefusal(before, after);
}

/** Admission of `peer`'s changes into `live`, which may hold changes
 * concurrent with them. */
function admit(live, peer) {
  const after = A.loadIncremental(A.clone(live), A.saveSince(peer, A.getHeads(live)));
  return blockChangeRefusal(live, after);
}

test("typing, creating, moving and deleting blocks in shape are admitted", () => {
  const base = page(3);
  assert.equal(
    judge(base, (d) => A.splice(d, ["blocks", id(0), "richText"], 2, 1, "xy")),
    null,
  );
  assert.equal(
    judge(base, (d) => {
      d.blocks[id(9)] = { position: new A.RawString("a0V"), richText: "" };
    }),
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
      d.blocks = { [id(7)]: { position: new A.RawString("a0"), richText: "" } };
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

test("an earlier format's extra keys are tolerated on the block that held them", () => {
  const base = page(2, { legacy: true });
  assert.deepEqual(Object.keys(base.blocks[id(0)]).sort(), [
    ...[...LEGACY_KEYS, "position", "richText"].sort(),
  ]);
  for (const [name, edit] of [
    ["typing", (d) => A.splice(d, ["blocks", id(0), "richText"], 0, 0, "x")],
    ["moving", (d) => (d.blocks[id(0)].position = new A.RawString("Zz"))],
    ["editing an old key", (d) => (d.blocks[id(0)].metadata.width = 3)],
    ["rewriting an old key", (d) => (d.blocks[id(0)].kind = "markdown")],
    ["dropping an old key", (d) => delete d.blocks[id(0)].markdown],
    ["deleting", (d) => delete d.blocks[id(0)]],
  ])
    assert.equal(judge(base, edit), null, name);
  // A key no earlier block held is still refused.
  assert.equal(judge(base, (d) => (d.blocks[id(0)].note = "x"))?.code, INVALID_BLOCK);
  // A replacement block is new: the old block's keys don't carry over.
  assert.equal(
    judge(base, (d) => {
      d.blocks[id(0)] = { position: new A.RawString("a0"), richText: "", kind: "markdown" };
    })?.code,
    INVALID_BLOCK,
  );
  // Another legacy block's keys don't carry over to a new block either.
  assert.equal(
    judge(base, (d) => {
      d.blocks[id(9)] = { position: new A.RawString("a9"), richText: "", kind: "markdown" };
    })?.code,
    INVALID_BLOCK,
  );
});

test("concurrent block writes that are each in shape are admitted in either order", () => {
  const base = page(3);
  const peer = (n, edit) => A.change(A.clone(base, { actor: actor(n) }), { time: 0 }, edit);
  const pairs = {
    "two peers create blocks": [
      peer(2, (d) => {
        d.blocks[id(10)] = { position: new A.RawString("a5"), richText: "two" };
      }),
      peer(3, (d) => {
        d.blocks[id(11)] = { position: new A.RawString("a5"), richText: "three" };
      }),
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
    const started = performance.now();
    assert.equal(blockChangeRefusal(live, after), null);
    times.push(performance.now() - started);
    A.free(peer);
    A.free(live);
    live = after;
  }
  A.free(live);
  times.sort((a, b) => a - b);
  return times[times.length >> 1] * 1000;
}

test("the check's cost per keystroke follows the change, not the number of blocks", () => {
  keystrokeCost(3, 50);
  const small = keystrokeCost(3);
  const large = keystrokeCost(300);
  // Walking every block would cost about 100 times as much on 300 blocks.
  assert.ok(
    large < small * 4 + 20,
    `3 blocks: ${small.toFixed(1)} µs, 300: ${large.toFixed(1)} µs`,
  );
});
