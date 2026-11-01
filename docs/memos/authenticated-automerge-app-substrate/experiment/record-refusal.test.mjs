import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { isRecordRefusal } from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import { closePeers, connectPeers, createPeer, eventually } from "./backend.mjs";

// patch-record-refusal.mjs: a byte store's refusal rejects one record and
// nothing else. No engine reset, no dropped connections, no flush failure.

const SIGNED_START = 112;
const issuerOf = (frame) =>
  Buffer.from(frame.subarray(SIGNED_START + 4, SIGNED_START + 36)).toString("hex");

/** A memory store that refuses records signed by `refuse()`, or that fails
 * them as ordinary I/O when `failInstead` is set. */
function guardedStore(refuse, { failInstead = false, hold } = {}) {
  const inner = new MemoryByteStore();
  const counts = { refused: 0, started: 0 };
  const store = new Proxy(inner, {
    get(target, property) {
      if (property === "save")
        return async (key, value) => {
          if (/\/(commits|fragments)\//.test(key) && issuerOf(value) === refuse()) {
            counts.started++;
            // Optionally keep the refused save open until the test lets go.
            if (hold) await hold();
            counts.refused++;
            throw Object.assign(Error("refused"), failInstead ? {} : { recordRefused: true });
          }
          return target.save(key, value);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store, counts };
}

async function scene({ failInstead = false, hold } = {}) {
  let refuse;
  const { store, counts } = guardedStore(() => refuse, { failInstead, hold });
  const host = createPeer({ storage: store });
  const honest = createPeer();
  const attacker = createPeer();
  const wires = [await connectPeers(honest, host), await connectPeers(attacker, host)];
  const id = interpretAsDocumentId(generateAutomergeUrl());
  const hostDoc = await host.repo.import(A.save(A.from({ n: 0 })), { docId: id });
  await host.repo.flush();
  const honestDoc = await honest.repo.find(id);
  const attackerDoc = await attacker.repo.find(id);
  refuse = attacker.keyId;
  return { host, honest, attacker, wires, hostDoc, honestDoc, attackerDoc, counts };
}

test("isRecordRefusal reads only the explicit marker", () => {
  assert.equal(isRecordRefusal(Object.assign(Error("x"), { recordRefused: true })), true);
  assert.equal(isRecordRefusal(Error("x")), false);
  assert.equal(isRecordRefusal({ recordRefused: "yes" }), false);
  assert.equal(isRecordRefusal(null), false);
});

test("a refused record stays out, and every other peer keeps syncing both ways", async () => {
  const s = await scene();
  try {
    s.attackerDoc.change((doc) => {
      doc.forged = true;
    });
    await eventually(() => s.counts.refused > 0);
    s.honestDoc.change((doc) => {
      doc.n = 1;
    });
    await eventually(() => s.hostDoc.doc().n === 1);
    s.hostDoc.change((doc) => {
      doc.n = 2;
    });
    await eventually(() => s.honestDoc.doc().n === 2);
    assert.equal(s.hostDoc.doc().forged, undefined);
    assert.equal(s.honestDoc.doc().forged, undefined, "never relayed to another peer");
    assert.deepEqual(
      s.wires.map((wire) => wire[0].closed),
      [false, false],
      "no connection dropped",
    );
    // The refusal left no failed attempt behind.
    await s.host.repo.flush();
  } finally {
    const errors = await closePeers([s.host, s.honest, s.attacker], s.wires);
    assert.deepEqual(errors, [], "shutdown finds no failed persistence");
  }
});

test("an unmarked store error still takes the failure path and resets", async () => {
  const s = await scene({ failInstead: true });
  try {
    s.attackerDoc.change((doc) => {
      doc.forged = true;
    });
    await eventually(() => s.counts.refused > 0);
    await eventually(() => s.wires.every((wire) => wire[0].closed));
  } finally {
    await closePeers([s.host, s.honest, s.attacker], s.wires);
  }
});

test("a flush already waiting on a save sees its refusal as an answer, not a failure", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const s = await scene({ hold: () => held });
  try {
    s.attackerDoc.change((doc) => {
      doc.forged = true;
    });
    // The refused save is in progress; a flush captures its attempt now.
    await eventually(() => s.counts.started > 0);
    const flushing = s.host.backend.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await flushing;
    assert.equal(s.counts.refused, 1);
    assert.equal(s.hostDoc.doc().forged, undefined);
    // Sync carries on afterwards.
    s.honestDoc.change((doc) => {
      doc.n = 7;
    });
    await eventually(() => s.hostDoc.doc().n === 7);
  } finally {
    release();
    const errors = await closePeers([s.host, s.honest, s.attacker], s.wires);
    assert.deepEqual(errors, []);
  }
});
