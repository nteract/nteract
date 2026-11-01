import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { documentIdToBinary } from "@automerge/automerge-repo";
import { closePeers, connectPeers, createPeer, eventually } from "../../backend.mjs";
import { applyComment } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { CommentAdmission, REFUSAL_BUDGET } from "./comment-admission.mjs";
import { commentsDocumentId } from "./comments-store.mjs";
import { logicalId } from "./policy.mjs";

// The native per-author gate with real signed records over real native
// connections: a refused comment change answers that one save. The engine
// keeps running, and every other peer keeps syncing both ways.
//
// Waits are generous: the Pages suite runs every file at once, and native
// sync over in-process transports slows down with it.
const settled = (check) => eventually(check, 20000);

const UUID = "c0000000-0000-4000-8000-00000000000a";
const page = A.from({ blocks: { b1: { id: "b1", markdown: "One" } } });

async function scene() {
  const id = commentsDocumentId(UUID);
  const refused = [];
  const throttledKeys = [];
  let host;
  const signers = {};
  const admission = new CommentAdmission({
    tree: () => logicalId(documentIdToBinary(id)),
    serverKey: undefined,
    signer: (key) => signers[key],
    seed: () => undefined,
    onRefused: (key, reason) => refused.push({ key, code: reason.code }),
    onThrottled: (key) => throttledKeys.push(key),
  });
  host = createPeer({ storage: admission.guard(new MemoryByteStore()) });
  admission.serverKey = host.keyId;
  const owner = createPeer();
  const attacker = createPeer();
  signers[owner.keyId] = { principal: "account:owner", role: "owner" };
  signers[attacker.keyId] = { principal: "account:mallory", role: "commenter" };
  const wires = [await connectPeers(owner, host), await connectPeers(attacker, host)];
  const hostDoc = await host.repo.import(A.save(commentsGenesis(UUID)), { docId: id });
  await host.repo.flush();
  const ownerDoc = await owner.repo.find(id);
  const attackerDoc = await attacker.repo.find(id);
  const comment = (handle, who, input) =>
    handle.change((draft) => {
      applyComment(draft, input, who, undefined, { page, role: who.role });
    });
  return {
    host,
    owner,
    attacker,
    wires,
    hostDoc,
    ownerDoc,
    attackerDoc,
    refused,
    throttledKeys,
    admission,
    comment,
  };
}

test("a forged edit is refused, and the owner keeps syncing both ways on the same engine", async () => {
  const s = await scene();
  const owner = {
    principal: "account:owner",
    displayName: "Owner",
    driver: "Browser",
    role: "owner",
  };
  try {
    s.comment(s.ownerDoc, owner, { block_id: "b1", body: "Owner's note" });
    await settled(() => Object.keys(s.hostDoc.doc().threads).length === 1);
    await settled(() => Object.keys(s.attackerDoc.doc().threads ?? {}).length === 1);
    const [threadId] = Object.keys(s.hostDoc.doc().threads);
    const [messageId] = Object.keys(s.hostDoc.doc().threads[threadId].messages);

    // Mallory's tab skips the rules and rewrites the owner's message.
    s.attackerDoc.change((draft) =>
      A.updateText(draft, ["threads", threadId, "messages", messageId, "body"], "Forged"),
    );
    await settled(() => s.refused.length === 1);
    assert.deepEqual(s.refused[0], { key: s.attacker.keyId, code: "not_message_author" });

    // The owner keeps syncing, both directions, with no reconnect.
    s.comment(s.ownerDoc, owner, { action: "reply", thread_id: threadId, body: "After" });
    await settled(() => Object.keys(s.hostDoc.doc().threads[threadId].messages).length === 2);
    s.hostDoc.change((draft) => {
      draft.threads[threadId].status = { value: "resolved", at: new Date().toISOString() };
    });
    await settled(() => s.ownerDoc.doc().threads[threadId].status.value === "resolved");
    assert.deepEqual(
      s.wires.map((wire) => wire[0].closed),
      [false, false],
      "the refusal dropped no connection",
    );
    assert.equal(
      String(s.hostDoc.doc().threads[threadId].messages[messageId].body),
      "Owner's note",
    );
    assert.equal(
      String(s.ownerDoc.doc().threads[threadId].messages[messageId].body),
      "Owner's note",
      "the forged change never reached another peer",
    );
    await s.host.repo.flush();
  } finally {
    const errors = await closePeers([s.host, s.owner, s.attacker], s.wires);
    assert.deepEqual(errors, [], "no failed persistence was left behind");
  }
});

test("a burst of forged changes costs a bounded number of checks, and the owner keeps syncing", async () => {
  const s = await scene();
  const owner = {
    principal: "account:owner",
    displayName: "Owner",
    driver: "Browser",
    role: "owner",
  };
  try {
    s.comment(s.ownerDoc, owner, { block_id: "b1", body: "Owner's note" });
    await settled(() => Object.keys(s.attackerDoc.doc().threads ?? {}).length === 1);
    const [threadId] = Object.keys(s.hostDoc.doc().threads);
    const [messageId] = Object.keys(s.hostDoc.doc().threads[threadId].messages);
    const before = s.admission.stats.checked;
    for (let i = 0; i < 30; i++)
      s.attackerDoc.change((draft) =>
        A.updateText(draft, ["threads", threadId, "messages", messageId, "body"], `Forged ${i}`),
      );
    await settled(() => s.throttledKeys.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const checks = s.admission.stats.checked - before;
    assert.ok(checks <= REFUSAL_BUDGET, `${checks} checks for 30 forged changes`);
    assert.deepEqual(s.throttledKeys, [s.attacker.keyId]);
    s.comment(s.ownerDoc, owner, { action: "reply", thread_id: threadId, body: "Still here" });
    await settled(() => Object.keys(s.hostDoc.doc().threads[threadId].messages).length === 2);
    assert.equal(
      String(s.hostDoc.doc().threads[threadId].messages[messageId].body),
      "Owner's note",
    );
  } finally {
    await closePeers([s.host, s.owner, s.attacker], s.wires);
  }
});
