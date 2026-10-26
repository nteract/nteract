import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as N from "@automerge/subduction";
import { decodeRecordFrame } from "./upstream/packages/automerge-repo-subduction/src/record-codec.ts";
import { commitId, recordBytes, sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  HistoryCapacityError,
  nativeId,
  unsigned,
  unsignedFragment,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";

const tree = sedimentreeId("ab".repeat(16));
const cid = (n) => commitId(n.toString(16).padStart(64, "0"));
const commit = (n) => ({ kind: "commit", id: cid(n), parents: [], blob: new Uint8Array([n, 42]) });
const records = Array.from({ length: 4 }, (_, n) => commit(n + 1));
const fragment = {
  kind: "fragment",
  head: cid(1),
  boundary: [],
  checkpoints: [],
  blob: new Uint8Array([8, 42]),
};
const conflict = { ...records[0], blob: new Uint8Array([99]) };
const limits = { maxRecordBytes: 4096, maxSnapshotBytes: 65536, maxRecords: 100 };
const signed = new Map();

class Store {
  values = new Map();
  loads = 0;
  lists = 0;
  saves = 0;
  afterSave;
  afterRemove;
  async load(key) {
    this.loads++;
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    this.lists++;
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async save(key, value) {
    this.saves++;
    this.values.set(key, value.slice());
    this.afterSave?.(key);
  }
  async remove(key) {
    this.values.delete(key);
    this.afterRemove?.(key);
  }
}

before(async () => {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(42));
  try {
    for (const batch of [[...records, fragment], [conflict]]) {
      const store = new Store();
      const bridge = new StorageBridge(store, limits, () => {});
      const engine = new N.Subduction({ signer, storage: bridge });
      const id = nativeId(tree);
      try {
        await engine.storeBuiltBatch(
          id,
          batch
            .filter((r) => r.kind === "commit")
            .map((r) => new N.CommitInput(unsigned(id, r), r.blob)),
          batch
            .filter((r) => r.kind === "fragment")
            .map((r) => new N.FragmentInput(unsignedFragment(id, r), r.blob)),
        );
        for (const record of batch) {
          const key = record.kind === "commit" ? record.id : record.head;
          const frame = [...store.values.entries()].find(([path]) =>
            path.endsWith(`/${record.kind === "commit" ? "commits" : "fragments"}/${key}`),
          )[1];
          signed.set(record, decodeRecordFrame(frame, limits.maxRecordBytes).signed);
        }
      } finally {
        await engine.disconnectAll();
        await bridge.drain();
        engine.free();
        id.free();
      }
    }
  } finally {
    signer.free();
  }
});

function withId(run) {
  const id = nativeId(tree);
  try {
    return run(id);
  } finally {
    id.free();
  }
}
function save(bridge, record) {
  const key = N.CommitId.fromHexString(record.kind === "commit" ? record.id : record.head);
  const value =
    record.kind === "commit"
      ? N.SignedLooseCommit.tryDecode(signed.get(record))
      : N.SignedFragment.tryDecode(signed.get(record));
  const blob = record.blob.slice();
  try {
    return withId((id) =>
      record.kind === "commit"
        ? bridge.saveCommit(id, key, value, blob)
        : bridge.saveFragment(id, key, value, blob),
    );
  } finally {
    key.free();
    value.free();
    blob.fill(0);
  }
}

const read = (bridge) => withId((id) => bridge.records(id));
const reserve = (bridge, key, records, persist = async () => {}) =>
  withId((id) => bridge.reserveRecords(id, key, records, persist));
const release = (bridge, key) => withId((id) => bridge.releaseReservation(id, key));
const capacity = (error) => error instanceof HistoryCapacityError && error.status === 413;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("exact API records reserve capacity against later native writes", async () => {
  const store = new Store();
  const bridge = new StorageBridge(store, { ...limits, maxRecords: 2 }, () => {});
  await save(bridge, records[0]);
  await reserve(bridge, "api", [records[0], records[1]]);
  await assert.rejects(save(bridge, records[2]), capacity);
  await save(bridge, records[1]);
  await save(bridge, records[1]);
  await release(bridge, "api");
  assert.deepEqual(await read(bridge), records.slice(0, 2));
});

test("native admission cannot overtake a durable intent barrier", async () => {
  const store = new Store();
  const bridge = new StorageBridge(store, { ...limits, maxRecords: 1 }, () => {});
  const entered = deferred(),
    barrier = deferred();
  const reservation = reserve(bridge, "api", [records[0]], async () => {
    entered.resolve();
    await barrier.promise;
  });
  await entered.promise;
  let nativeSettled = false;
  const incoming = save(bridge, records[1]).then(
    () => {
      nativeSettled = true;
      throw Error("native admission bypassed reservation");
    },
    (error) => {
      nativeSettled = true;
      assert.ok(capacity(error));
    },
  );
  await Promise.resolve();
  assert.equal(nativeSettled, false);
  barrier.resolve();
  await Promise.all([reservation, incoming]);
  assert.deepEqual(await read(bridge), []);
  await save(bridge, records[0]);
  assert.deepEqual(await read(bridge), [records[0]]);
});

test("already queued native records are charged before persisting a new intent", async () => {
  const bridge = new StorageBridge(new Store(), { ...limits, maxRecords: 1 }, () => {});
  const incoming = save(bridge, records[1]);
  let persisted = false;
  await assert.rejects(
    reserve(bridge, "api", [records[0]], async () => {
      persisted = true;
    }),
    capacity,
  );
  await incoming;
  assert.equal(persisted, false);
  assert.deepEqual(await read(bridge), [records[1]]);
});

test("an ambiguous intent failure retains its exact reservation", async () => {
  const store = new Store();
  const bridge = new StorageBridge(store, { ...limits, maxRecords: 1 }, () => {});
  let intent;
  await assert.rejects(
    reserve(bridge, "api", [records[0]], async () => {
      intent = structuredClone([records[0]]);
      throw Error("intent persisted but acknowledgement lost");
    }),
    /acknowledgement lost/,
  );
  await assert.rejects(save(bridge, records[1]), capacity);
  const reopened = new StorageBridge(store, { ...limits, maxRecords: 1 }, () => {});
  await reserve(reopened, "api", intent);
  await assert.rejects(save(reopened, records[1]), capacity);
  await save(reopened, records[0]);
  await release(reopened, "api");
  assert.deepEqual(await read(reopened), [records[0]]);
});

test("partially persisted reserved records cannot lose their remaining capacity", async () => {
  const store = new Store();
  const bridge = new StorageBridge(store, { ...limits, maxRecords: 2 }, () => {});
  await reserve(bridge, "api", records.slice(0, 2));
  store.afterSave = (key) => {
    if (key.endsWith(cid(1))) throw Error("ambiguous prefix");
  };
  await assert.rejects(save(bridge, records[0]), /ambiguous prefix/);
  await assert.rejects(save(bridge, records[2]), capacity);
  await assert.rejects(release(bridge, "api"), /not yet stored/);
  store.afterSave = undefined;
  await reserve(bridge, "api", records.slice(0, 2));
  await save(bridge, records[1]);
  await release(bridge, "api");
  assert.deepEqual(await read(bridge), records.slice(0, 2));
});

test("duplicate reservations and fragments charge unique bytes only", async () => {
  const store = new Store();
  const bridge = new StorageBridge(
    store,
    {
      ...limits,
      maxSnapshotBytes: recordBytes(records[0]) + recordBytes(fragment),
    },
    () => {},
  );
  await reserve(bridge, "one", [records[0], fragment]);
  await reserve(bridge, "two", [records[0], fragment]);
  await assert.rejects(save(bridge, records[1]), capacity);
  await save(bridge, fragment);
  await save(bridge, records[0]);
  await release(bridge, "one");
  await release(bridge, "two");
  assert.deepEqual(await read(bridge), [records[0], fragment]);
});

test("oversized records and conflicting reservations never persist an intent", async () => {
  const bridge = new StorageBridge(new Store(), limits, () => {});
  const persist = () => assert.fail("rejected intent must not be persisted");
  await assert.rejects(
    reserve(bridge, "large", [{ ...records[0], blob: new Uint8Array(5000) }], persist),
    capacity,
  );
  await reserve(bridge, "first", [records[0]]);
  await assert.rejects(reserve(bridge, "second", [conflict], persist), { code: "conflict" });
  await assert.rejects(reserve(bridge, "first", [records[1]], persist), { code: "conflict" });
});
