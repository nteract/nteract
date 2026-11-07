import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";

// Native compatibility probes, not transport acknowledgments. The backend gate
// is exercised by the actual-host orphan and persistent-collision fixtures.
for (const version of ["v1", "v2"])
  for (const rollback of ["empty", "ancestor", "divergent"])
    test(`conservative advertised have preserves native ${version} ${rollback} recovery`, () => {
      let local = A.init({ actor: "01".repeat(16) });
      for (let n = 0; n < 20; n++)
        local = A.change(local, { time: 0 }, (d) => {
          d.n = n;
        });
      const ancestor = A.clone(local);
      for (let n = 20; n < 24; n++)
        local = A.change(local, { time: 0 }, (d) => {
          d.n = n;
        });
      let peer = rollback === "empty" ? A.init() : A.clone(ancestor, { actor: "02".repeat(16) });
      if (rollback === "divergent")
        peer = A.change(peer, { time: 0 }, (d) => {
          d.other = 1;
        });
      const expected = A.merge(A.clone(local), A.clone(peer));
      let ls = { ...A.initSyncState(), sharedHeads: A.getHeads(local) },
        ps = A.initSyncState();
      const types = new Set();
      let frames = 0;
      for (let i = 0; i < 16; i++) {
        let sent = false;
        for (const side of [0, 1]) {
          let state = side ? ps : ls;
          if (version === "v1") state.theirCapabilities = [];
          if (!side && state.theirHave !== null) {
            const last = state.theirHave.map((h) => h.lastSync);
            state.theirHave = state.theirHave.map((h) => ({ ...h, bloom: new Uint8Array() }));
            assert.deepEqual(
              state.theirHave.map((h) => h.lastSync),
              last,
            );
          }
          let m;
          [state, m] = A.generateSyncMessage(side ? peer : local, state);
          if (side) ps = state;
          else ls = state;
          if (!m) continue;
          sent = true;
          frames++;
          types.add(A.decodeSyncMessage(m).type);
          if (side) [local, ls] = A.receiveSyncMessage(local, ls, m);
          else [peer, ps] = A.receiveSyncMessage(peer, ps, m);
        }
        if (!sent) break;
      }
      assert.ok(frames < 20, "native exchange stops within the probe budget");
      assert.deepEqual(A.getHeads(local), A.getHeads(expected));
      assert.deepEqual(A.getHeads(peer), A.getHeads(expected));
      assert.ok(types.has(version));
      if (version === "v1") assert.deepEqual([...types], ["v1"]);
      for (const doc of [local, peer, ancestor, expected]) A.free(doc);
    });

test("empty have array preserves need-only semantics; unknown lastSync still requests reset", () => {
  const doc = A.from({ n: 1 }, { actor: "03".repeat(16) });
  const head = A.getHeads(doc)[0];
  const state = { ...A.initSyncState(), theirHeads: [], theirNeed: [head], theirHave: [] };
  const [, needed] = A.generateSyncMessage(doc, state);
  assert.equal(A.decodeSyncMessage(needed).changes.length, 1);
  const unknown = "ff".repeat(32);
  const [, reset] = A.generateSyncMessage(doc, {
    ...A.initSyncState(),
    theirHeads: [unknown],
    theirNeed: [],
    theirHave: [{ lastSync: [unknown], bloom: new Uint8Array() }],
  });
  const decoded = A.decodeSyncMessage(reset);
  assert.deepEqual(
    decoded.have.map((h) => h.lastSync),
    [[]],
  );
  assert.equal(decoded.changes.length, 0);
  A.free(doc);
});
