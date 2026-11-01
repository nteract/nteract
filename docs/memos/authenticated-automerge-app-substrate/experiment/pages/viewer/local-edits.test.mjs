// Which checkpoint edits are this browser's own and unconfirmed, and how that
// fact survives checkpoint writes. PageSession's close/reopen behaviour is
// covered in reopen-status.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  MAX_LOCAL_ACTORS,
  acknowledgedHeads,
  afterAcknowledgement,
  emptyLocalEdits,
  hasUnconfirmedLocalEdits,
  mergeLocalEdits,
  readLocalEdits,
  withActor,
} from "./local-edits.mjs";
import { encodeSnapshot, readLocalPage, writeLocalPage } from "./local-pages.mjs";

const LOCAL = "aa".repeat(16);
const REMOTE = "bb".repeat(16);
const edit = (doc, actor, text) =>
  A.change(A.clone(doc, { actor }), (draft) => {
    draft.text = text;
  });

test("only this browser's actors outside the acknowledged history are unconfirmed", () => {
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const local = edit(base, LOCAL, "typed here");
  const edits = withActor(emptyLocalEdits(), LOCAL);
  assert.equal(hasUnconfirmedLocalEdits(base, edits), false, "nothing of ours");
  assert.equal(hasUnconfirmedLocalEdits(local, edits), true, "our edit, never acknowledged");
  const acked = afterAcknowledgement(local, edits, A.getHeads(local));
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
  const elsewhere = edit(base, "cc".repeat(16), "another tab");
  const [foreign] = A.getHeads(elsewhere);
  const edits = { actors: [LOCAL], ackedHeads: [foreign], unattributed: true };
  assert.deepEqual(acknowledgedHeads(base, edits), []);
  const local = edit(base, LOCAL, "ours");
  assert.equal(hasUnconfirmedLocalEdits(local, { ...edits, unattributed: false }), true);
  const acked = afterAcknowledgement(local, edits, A.getHeads(local));
  assert.deepEqual(acked.ackedHeads, [...A.getHeads(local), foreign]);
  assert.equal(acked.unattributed, false);
});

test("actors are recorded once and capped oldest first", () => {
  const edits = withActor(emptyLocalEdits(), LOCAL);
  assert.equal(withActor(edits, LOCAL), edits, "an existing actor returns the same value");
  let many = emptyLocalEdits();
  for (let i = 0; i < MAX_LOCAL_ACTORS + 3; i++)
    many = withActor(many, i.toString(16).padStart(32, "0"));
  assert.equal(many.actors.length, MAX_LOCAL_ACTORS);
  assert.equal(many.actors[0], (3).toString(16).padStart(32, "0"));
});

test("stored values are validated and merges keep every actor", () => {
  assert.equal(readLocalEdits(undefined), undefined);
  assert.equal(
    readLocalEdits({ actors: ["not hex"], ackedHeads: [], unattributed: false }),
    undefined,
  );
  assert.equal(readLocalEdits({ actors: [], ackedHeads: ["00"], unattributed: false }), undefined);
  assert.equal(readLocalEdits({ actors: [], ackedHeads: [] }), undefined);
  const h1 = "1".repeat(64),
    h2 = "2".repeat(64);
  const stored = { actors: [REMOTE], ackedHeads: [h1], unattributed: true };
  const incoming = { actors: [LOCAL], ackedHeads: [h2], unattributed: false };
  assert.deepEqual(mergeLocalEdits(stored, incoming), {
    actors: [REMOTE, LOCAL],
    ackedHeads: [h2],
    unattributed: false,
  });
  assert.deepEqual(mergeLocalEdits(stored, incoming, { diverged: true }), {
    actors: [REMOTE, LOCAL],
    ackedHeads: [h2, h1],
    unattributed: true,
  });
  assert.deepEqual(mergeLocalEdits(stored, undefined), stored);
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
  const first = withActor(emptyLocalEdits(), LOCAL);
  await writeLocalPage(identity, page(identity, base, first));
  const second = withActor(emptyLocalEdits(), "cc".repeat(16));
  const written = await writeLocalPage(identity, page(identity, base, second));
  assert.deepEqual(written.localEdits.actors, [LOCAL, "cc".repeat(16)]);
  await writeLocalPage(identity, page(identity, base));
  const stored = await readLocalPage(identity, "local-edits-page");
  assert.deepEqual(stored.localEdits.actors, [LOCAL, "cc".repeat(16)]);
});

test("diverged tab checkpoints merge their acknowledgements with their histories", async () => {
  const identity = { principal: crypto.randomUUID() };
  const base = A.from({ text: "base" }, { actor: REMOTE });
  const left = edit(base, LOCAL, "left tab");
  const right = edit(base, "cc".repeat(16), "right tab");
  const leftEdits = afterAcknowledgement(
    left,
    withActor(emptyLocalEdits(), LOCAL),
    A.getHeads(left),
  );
  await writeLocalPage(identity, page(identity, left, leftEdits));
  const rightEdits = withActor(emptyLocalEdits(), "cc".repeat(16));
  const merged = await writeLocalPage(identity, page(identity, right, rightEdits));
  assert.equal(merged.pending, true);
  assert.deepEqual(merged.localEdits.ackedHeads, A.getHeads(left));
  assert.deepEqual(merged.localEdits.actors, [LOCAL, "cc".repeat(16)]);
});
