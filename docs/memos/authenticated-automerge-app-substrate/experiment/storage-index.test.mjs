import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as N from "@automerge/subduction";
import { commitId, recordBytes, sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  nativeId,
  unsigned,
  unsignedFragment,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";

const tree = sedimentreeId("ab".repeat(16));
const cid = (n) => commitId(n.toString(16).padStart(64, "0"));
const commit = (n) => ({ kind: "commit", id: cid(n), parents: [], blob: new Uint8Array([n, 42]) });
const records = Array.from({ length: 64 }, (_, n) => commit(n + 1));
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
          signed.set(
            record,
            Uint8Array.from(Buffer.from(JSON.parse(new TextDecoder().decode(frame)).signed, "hex")),
          );
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
function batch(bridge, items) {
  const commits = items
    .filter((r) => r.kind === "commit")
    .map((r) => ({
      commitId: N.CommitId.fromHexString(r.id),
      signedCommit: N.SignedLooseCommit.tryDecode(signed.get(r)),
      blob: r.blob.slice(),
    }));
  const fragments = items
    .filter((r) => r.kind === "fragment")
    .map((r) => ({
      fragmentHead: N.CommitId.fromHexString(r.head),
      signedFragment: N.SignedFragment.tryDecode(signed.get(r)),
      blob: r.blob.slice(),
    }));
  try {
    return withId((id) => bridge.saveBatchAll(id, commits, fragments));
  } finally {
    for (const c of commits) {
      c.commitId.free();
      c.signedCommit.free();
      c.blob.fill(0);
    }
    for (const f of fragments) {
      f.fragmentHead.free();
      f.signedFragment.free();
      f.blob.fill(0);
    }
  }
}
const read = (bridge) => withId((id) => bridge.records(id));

test("warm edits and checkpoint reads do not reread growing history", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, () => {});
  for (const record of records) {
    await save(bridge, record);
    await read(bridge);
  }
  assert.equal(store.loads, 1, "only the initial marker read");
  assert.equal(store.lists, 1, "only the initial validated enumeration");
  assert.equal(store.saves, records.length);
  assert.deepEqual(await read(bridge), records);
  const reopened = new StorageBridge(store, limits, () => {});
  const before = store.loads;
  assert.deepEqual(await read(reopened), records);
  assert.equal(store.loads - before, records.length + 1, "reopening validates every stored record");
});

test("same-key conflicts, exact retries and commit/fragment namespaces remain distinct", async () => {
  const store = new Store(),
    seen = [],
    bridge = new StorageBridge(store, limits, (_id, record) => seen.push(record));
  const results = await Promise.allSettled([
    save(bridge, records[0]),
    save(bridge, records[0]),
    save(bridge, conflict),
    save(bridge, fragment),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(results[2].reason.code, "conflict");
  assert.equal(store.saves, 2);
  assert.deepEqual(await read(bridge), [records[0], fragment]);
  assert.equal(seen.length, 3);
});

for (const limit of ["count", "bytes"])
  test(`concurrent writers retain aggregate ${limit} limits`, async () => {
    const store = new Store(),
      bridge = new StorageBridge(
        store,
        {
          ...limits,
          ...(limit === "count"
            ? { maxRecords: 1 }
            : { maxSnapshotBytes: recordBytes(records[0]) }),
        },
        () => {},
      );
    const results = await Promise.allSettled([save(bridge, records[0]), save(bridge, records[1])]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected"],
    );
    assert.deepEqual(await read(bridge), [records[0]]);
  });

test("ambiguous batch prefixes invalidate before recovery; retry notifies without rewriting", async () => {
  const store = new Store(),
    seen = [],
    bridge = new StorageBridge(store, limits, (_id, record) => seen.push(record));
  const failure = new Error("saved then rejected");
  store.afterSave = (key) => {
    if (key.endsWith(cid(2))) throw failure;
  };
  await assert.rejects(batch(bridge, records.slice(0, 3)), (error) => error === failure);
  assert.deepEqual(seen, [records[0]]);
  const before = store.loads;
  assert.deepEqual(await read(bridge), records.slice(0, 2));
  assert.ok(store.loads > before, "ambiguous storage must be read again");
  await assert.rejects(bridge.flush(), (error) => error.errors.includes(failure));
  await bridge.flush();
  store.afterSave = undefined;
  await batch(bridge, records.slice(0, 3));
  assert.deepEqual(seen, [records[0], ...records.slice(0, 3)]);
  assert.equal(store.saves, 5, "two markers and exactly three record writes");
  assert.deepEqual(await read(new StorageBridge(store, limits, () => {})), records.slice(0, 3));
});

test("readers and saved observers cannot mutate the cached record bytes", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, (_id, record) => {
      record.blob.fill(0);
    });
  await save(bridge, records[0]);
  const first = await read(bridge);
  first[0].blob.fill(1);
  first[0].parents.push(cid(55));
  assert.deepEqual(await read(bridge), [records[0]]);
  await save(bridge, records[0]);
  assert.equal(store.saves, 1);
});

test("partial failed removals invalidate the index and preserve remaining history", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, () => {});
  await batch(bridge, [records[0], records[1], fragment]);
  store.afterRemove = (key) => {
    if (key.endsWith(cid(1))) throw new Error("removed then rejected");
  };
  await assert.rejects(
    withId((id) => bridge.deleteAllCommits(id)),
    /removed then rejected/,
  );
  assert.deepEqual(await read(bridge), [records[1], fragment]);
  store.afterRemove = undefined;
  await withId((id) => bridge.cleanup(id));
  assert.deepEqual(await read(bridge), []);
  await save(bridge, records[0]);
  assert.deepEqual(await read(bridge), [records[0]]);
});

test("reopening detects corruption instead of trusting a previous bridge's index", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, () => {});
  await save(bridge, records[0]);
  const path = [...store.values.keys()].find((key) => key.includes("/commits/"));
  store.values.set(path, new TextEncoder().encode("corrupt"));
  await assert.rejects(read(new StorageBridge(store, limits, () => {})));
});

test("a failed native read invalidates a warm index before subsequent records", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, () => {});
  await save(bridge, records[0]);
  const load = store.load.bind(store);
  store.load = async () => {
    throw new Error("read failed");
  };
  const key = N.CommitId.fromHexString(cid(1));
  try {
    await assert.rejects(
      withId((id) => bridge.loadCommit(id, key)),
      /read failed/,
    );
  } finally {
    key.free();
  }
  store.load = load;
  const before = store.loads;
  assert.deepEqual(await read(bridge), [records[0]]);
  assert.equal(store.loads - before, 2, "failed reads discard cached validation");
});

const nativeRead = (bridge, kind) =>
  withId((id) => (kind === "commit" ? bridge.loadAllCommits(id) : bridge.loadAllFragments(id)));
function assertNativeRecords(values, expected) {
  assert.equal(values.length, expected.length);
  for (let i = 0; i < values.length; i++) {
    assert.deepEqual(values[i].blob, expected[i].blob);
    const envelope = values[i].signed;
    try {
      assert.deepEqual(envelope.encode(), signed.get(expected[i]));
    } finally {
      envelope.free();
    }
  }
}
function freeNativeRecords(values) {
  for (const value of values) value.free();
}

test("native hydration reads growing history from the validated index without rescanning storage", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, () => {});
  await save(bridge, fragment);
  for (let i = 0; i < records.length; i++) {
    await save(bridge, records[i]);
    const commits = await nativeRead(bridge, "commit");
    const fragments = await nativeRead(bridge, "fragment");
    try {
      assertNativeRecords(commits, records.slice(0, i + 1));
      assertNativeRecords(fragments, [fragment]);
    } finally {
      freeNativeRecords(commits);
      freeNativeRecords(fragments);
    }
  }
  assert.equal(store.loads, 1, "native enumeration never reloads warmed history");
  assert.equal(store.lists, 1);
  const reopened = new StorageBridge(store, limits, () => {}),
    before = store.loads;
  const commits = await nativeRead(reopened, "commit");
  freeNativeRecords(commits);
  assert.equal(
    store.loads - before,
    records.length + 2,
    "cold hydration validates both kinds and marker",
  );
  const validated = store.loads;
  freeNativeRecords(await nativeRead(reopened, "fragment"));
  freeNativeRecords(await nativeRead(reopened, "commit"));
  assert.equal(store.loads, validated, "subsequent native hydration reuses that validated cut");
});

for (const kind of ["commit", "fragment"])
  test(`native ${kind} enumerations return fresh consumable wrappers and private blobs`, async () => {
    const store = new Store(),
      bridge = new StorageBridge(store, limits, () => {}),
      expected = kind === "commit" ? [records[0]] : [fragment];
    await save(bridge, expected[0]);
    const [first, second] = await Promise.all([nativeRead(bridge, kind), nativeRead(bridge, kind)]);
    let consumed;
    try {
      assert.notEqual(first[0], second[0]);
      const envelope = first[0].signed;
      consumed =
        kind === "commit"
          ? new N.CommitWithBlob(envelope, first[0].blob)
          : new N.FragmentWithBlob(envelope, first[0].blob);
      first[0].blob.fill(0);
      freeNativeRecords(first);
      assertNativeRecords(second, expected);
      assertNativeRecords([consumed], expected);
      const third = await nativeRead(bridge, kind);
      try {
        assertNativeRecords(third, expected);
      } finally {
        freeNativeRecords(third);
      }
    } finally {
      freeNativeRecords(second);
      consumed?.free();
    }
  });

for (const corruptKind of ["commit", "fragment"])
  test(`cold native hydration rejects a corrupt ${corruptKind} even when asked for the other kind`, async () => {
    const store = new Store(),
      bridge = new StorageBridge(store, limits, () => {});
    await batch(bridge, [records[0], fragment]);
    const path = [...store.values.keys()].find((key) =>
      key.includes(corruptKind === "commit" ? "/commits/" : "/fragments/"),
    );
    const frame = JSON.parse(new TextDecoder().decode(store.values.get(path)));
    frame.signed = `${frame.signed.slice(0, -2)}${frame.signed.endsWith("00") ? "ff" : "00"}`;
    store.values.set(path, new TextEncoder().encode(JSON.stringify(frame)));
    const reopened = new StorageBridge(store, limits, () => {});
    await assert.rejects(
      nativeRead(reopened, corruptKind === "commit" ? "fragment" : "commit"),
      /Signed envelope checksum mismatch/,
    );
  });

test("ambiguous native writes invalidate envelope caches before same-bridge and reset hydration", async () => {
  const store = new Store(),
    bridge = new StorageBridge(store, limits, () => {});
  await save(bridge, records[0]);
  freeNativeRecords(await nativeRead(bridge, "commit"));
  store.afterSave = (key) => {
    if (key.endsWith(cid(2))) throw Error("ambiguous native write");
  };
  await assert.rejects(save(bridge, records[1]), /ambiguous native write/);
  const before = store.loads;
  const recovered = await nativeRead(bridge, "commit");
  try {
    assertNativeRecords(recovered, records.slice(0, 2));
    assert.equal(store.loads - before, 3, "failed write requires validating actual stored prefix");
  } finally {
    freeNativeRecords(recovered);
  }
  store.afterSave = undefined;
  await save(bridge, records[1]);
  await save(bridge, fragment);
  const reset = new StorageBridge(store, limits, () => {});
  const resetBefore = store.loads;
  const resetFragments = await nativeRead(reset, "fragment");
  try {
    assertNativeRecords(resetFragments, [fragment]);
    assert.equal(store.loads - resetBefore, 4, "a new bridge revalidates both namespaces");
  } finally {
    freeNativeRecords(resetFragments);
  }
  await withId((id) => reset.deleteAllCommits(id));
  assert.deepEqual(await nativeRead(reset, "commit"), []);
  const remaining = await nativeRead(reset, "fragment");
  try {
    assertNativeRecords(remaining, [fragment]);
  } finally {
    freeNativeRecords(remaining);
  }
});
