// Which checkpoint edits are this browser's own and unconfirmed, and how that
// fact survives checkpoint writes. PageSession's close/reopen behaviour is
// covered in reopen-status.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  acknowledgedHeads,
  afterAcknowledgement,
  emptyLocalEdits,
  hasUnconfirmedLocalEdits,
  mergeLocalEdits,
  readLocalEdits,
  retireReplica,
  withActor,
} from "./local-edits.mjs";
import { encodeSnapshot, readLocalPage, writeLocalPage } from "./local-pages.mjs";

const LOCAL = "aa".repeat(16);
const REMOTE = "bb".repeat(16);
const OTHER = "cc".repeat(16);
const HERE = "1".repeat(32);
const THERE = "2".repeat(32);
const entry = (actor, replica = HERE) => ({ actor, replica });
const edit = (doc, actor, text) =>
  A.change(A.clone(doc, { actor }), (draft) => {
    draft.text = text;
  });
const live = { replica: HERE, actor: LOCAL };

test("only this browser's actors outside the acknowledged history are unconfirmed", () => {
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const local = edit(base, LOCAL, "typed here");
  const edits = withActor(emptyLocalEdits(), LOCAL, HERE);
  assert.equal(hasUnconfirmedLocalEdits(base, edits), false, "nothing of ours");
  assert.equal(hasUnconfirmedLocalEdits(local, edits), true, "our edit, never acknowledged");
  const acked = afterAcknowledgement(local, edits, A.getHeads(local), live);
  assert.equal(hasUnconfirmedLocalEdits(local, acked), false, "the receipt covers it");
  const caughtUp = edit(local, REMOTE, "from an agent");
  assert.equal(hasUnconfirmedLocalEdits(caughtUp, acked), false, "remote catch-up is not ours");
  const again = edit(caughtUp, LOCAL, "typed again");
  assert.equal(hasUnconfirmedLocalEdits(again, acked), true);
  assert.equal(
    hasUnconfirmedLocalEdits(caughtUp, { ...acked, unattributed: true }),
    true,
    "an unattributed checkpoint stays unconfirmed until a receipt",
  );
});

test("acknowledged heads another replica holds cover nothing here and survive", () => {
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const elsewhere = edit(base, OTHER, "another tab");
  const [foreign] = A.getHeads(elsewhere);
  const edits = { actors: [entry(LOCAL)], ackedHeads: [foreign], unattributed: true };
  assert.deepEqual(acknowledgedHeads(base, edits), []);
  const local = edit(base, LOCAL, "ours");
  assert.equal(hasUnconfirmedLocalEdits(local, { ...edits, unattributed: false }), true);
  const acked = afterAcknowledgement(local, edits, A.getHeads(local), live);
  assert.deepEqual(acked.ackedHeads, [...A.getHeads(local), foreign]);
  assert.equal(acked.unattributed, false);
});

const actorAt = (i) => i.toString(16).padStart(32, "0");

test("no count of other actors ever evicts one with unacknowledged edits", () => {
  let edits = withActor(emptyLocalEdits(), LOCAL, HERE);
  assert.equal(withActor(edits, LOCAL, HERE), edits, "an existing actor returns the same value");
  for (let i = 0; i < 2000; i++) edits = withActor(edits, actorAt(i), THERE);
  assert.equal(edits.actors.length, 2001);
  const base = A.from({ text: "base" }, { actor: REMOTE });
  assert.equal(hasUnconfirmedLocalEdits(edit(base, LOCAL, "oldest, unsaved"), edits), true);
  const merged = mergeLocalEdits(edits, withActor(emptyLocalEdits(), OTHER, "3".repeat(32)), {
    replica: "3".repeat(32),
  });
  assert.equal(merged.actors.length, 2002, "a merge keeps every other replica's actor");
  assert.equal(merged.actors[0].actor, LOCAL);
});

test("a covering receipt frees only its own replica's earlier actors", () => {
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const earlier = edit(base, OTHER, "an earlier session here");
  const edits = {
    actors: [entry(OTHER, HERE), entry(LOCAL, HERE), entry(REMOTE, THERE)],
    ackedHeads: [],
    unattributed: false,
  };
  const acked = afterAcknowledgement(earlier, edits, A.getHeads(earlier), live);
  assert.deepEqual(
    acked.actors,
    [entry(LOCAL, HERE), entry(REMOTE, THERE)],
    "the live actor and another replica's, which may still be live, stay",
  );
  assert.deepEqual(retireReplica(acked, HERE).actors, [entry(REMOTE, THERE)]);
});

test("stored values are validated and the writer decides only its own replica's actors", () => {
  assert.equal(readLocalEdits(undefined), undefined);
  assert.equal(
    readLocalEdits({ actors: [LOCAL], ackedHeads: [], unattributed: false }),
    undefined,
    "an actor without its replica",
  );
  assert.equal(
    readLocalEdits({ actors: [entry("not hex")], ackedHeads: [], unattributed: false }),
    undefined,
  );
  assert.equal(readLocalEdits({ actors: [], ackedHeads: ["00"], unattributed: false }), undefined);
  assert.equal(readLocalEdits({ actors: [], ackedHeads: [] }), undefined);
  const h1 = "1".repeat(64),
    h2 = "2".repeat(64);
  const stored = {
    actors: [entry(REMOTE, THERE), entry(OTHER, HERE)],
    ackedHeads: [h1],
    unattributed: true,
  };
  const incoming = { actors: [entry(LOCAL, HERE)], ackedHeads: [h2], unattributed: false };
  assert.deepEqual(mergeLocalEdits(stored, incoming, { replica: HERE }), {
    actors: [entry(REMOTE, THERE), entry(LOCAL, HERE)],
    ackedHeads: [h2],
    unattributed: false,
  });
  assert.deepEqual(mergeLocalEdits(stored, incoming, { diverged: true }), {
    actors: [entry(REMOTE, THERE), entry(OTHER, HERE), entry(LOCAL, HERE)],
    ackedHeads: [h2, h1],
    unattributed: true,
  });
  assert.deepEqual(mergeLocalEdits(stored, undefined, { replica: HERE }), stored);
  assert.deepEqual(mergeLocalEdits(undefined, incoming), incoming);
  assert.equal(mergeLocalEdits(undefined, undefined), undefined);
});

function page(identity, doc, localEdits) {
  return {
    principal: identity.principal,
    page_id: "local-edits-page",
    document_id: "local-edits-document",
    title: "Local edits",
    snapshot: encodeSnapshot(A.save(doc)),
    pending: false,
    registered: true,
    ...(localEdits && { localEdits }),
  };
}

test("a checkpoint write keeps another tab's actor and a write without localEdits keeps all", async () => {
  const identity = { principal: crypto.randomUUID() };
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const first = withActor(emptyLocalEdits(), LOCAL, HERE);
  await writeLocalPage(identity, page(identity, base, first), { replica: HERE });
  const second = withActor(emptyLocalEdits(), OTHER, THERE);
  const written = await writeLocalPage(identity, page(identity, base, second), { replica: THERE });
  assert.deepEqual(written.localEdits.actors, [entry(LOCAL, HERE), entry(OTHER, THERE)]);
  await writeLocalPage(identity, page(identity, base));
  const stored = await readLocalPage(identity, "local-edits-page");
  assert.deepEqual(stored.localEdits.actors, [entry(LOCAL, HERE), entry(OTHER, THERE)]);
});

test("diverged tab checkpoints merge their acknowledgements with their histories", async () => {
  const identity = { principal: crypto.randomUUID() };
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const left = edit(base, LOCAL, "left tab");
  const right = edit(base, OTHER, "right tab");
  const leftEdits = afterAcknowledgement(
    left,
    withActor(emptyLocalEdits(), LOCAL, HERE),
    A.getHeads(left),
    live,
  );
  await writeLocalPage(identity, page(identity, left, leftEdits), { replica: HERE });
  const rightEdits = withActor(emptyLocalEdits(), OTHER, THERE);
  const merged = await writeLocalPage(identity, page(identity, right, rightEdits), {
    replica: THERE,
  });
  assert.equal(merged.pending, true);
  assert.deepEqual(merged.localEdits.ackedHeads, A.getHeads(left));
  assert.deepEqual(merged.localEdits.actors, [entry(LOCAL, HERE), entry(OTHER, THERE)]);
});
