import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BufferedRecordStore,
  PageRecords,
  RemoteRecordSink,
  encodeRecordBatch,
  decodeRecordBatch,
} from "./record-persistence.mjs";
import { guardStubs } from "./storage-guard.mjs";
import { errorResponse } from "./auth.mjs";
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class Storage {
  values = new Map();
  async get(key) {
    return this.values.get(key);
  }
  barrier;
  puts = 0;
  async put(values) {
    assert.ok(Object.keys(values).length <= 128, "storage.put accepts at most 128 keys");
    if (Object.keys(values).some((key) => key.startsWith("repo/"))) this.puts++;
    for (const [key, value] of Object.entries(values)) this.values.set(key, value.slice());
  }
  async delete(keys) {
    for (const key of keys) this.values.delete(key);
  }
  async sync() {
    await this.barrier?.promise;
  }
  async list({ prefix, startAfter = "", limit }) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
}
function fixture(options) {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const sink = new RemoteRecordSink({ fetch: (request) => owner.fetch(request) });
  const live = new BufferedRecordStore(sink, options);
  return { storage, owner, sink, live };
}
const bytes = (value) => new TextEncoder().encode(value);

test("live reads and edits proceed while remote persistence is held; flush waits for durability", async () => {
  const f = fixture();
  await f.live.save("tree/first", bytes("one"));
  assert.deepEqual([...f.storage.values.keys()], ["host/generation", "host/seq"]);
  f.storage.barrier = deferred();
  const saving = f.live.flush();
  let saved = false;
  void saving.then(() => {
    saved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.storage.puts, 1);
  assert.equal(saved, false);
  await f.live.save("tree/second", bytes("two"));
  assert.deepEqual(await f.live.load("tree/first"), bytes("one"));
  assert.deepEqual(await f.live.load("tree/second"), bytes("two"));
  assert.equal(saved, false);
  f.storage.barrier.resolve();
  await saving;
  assert.equal(f.live.dirty, true);
  await f.live.flush();
  const reopened = new BufferedRecordStore(f.sink);
  assert.deepEqual(await reopened.load("tree/second"), bytes("two"));
  assert.equal(f.live.dirty, false);
});

test("ambiguous persistence failure retains edits, newer replacements, and deletions for retry", async () => {
  const f = fixture();
  await f.live.save("tree/a", bytes("old"));
  await f.live.save("tree/b", bytes("remove"));
  f.storage.barrier = deferred();
  const saving = f.live.flush();
  const failed = assert.rejects(saving, /persist/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await f.live.save("tree/a", bytes("new"));
  await f.live.remove("tree/b");
  f.storage.barrier.reject(Error("bucket unavailable"));
  await failed;
  assert.equal(f.live.dirty, true);
  f.storage.barrier = undefined;
  await f.live.flush();
  const reopened = new BufferedRecordStore(f.sink);
  assert.deepEqual(await reopened.load("tree/a"), bytes("new"));
  assert.equal(await reopened.load("tree/b"), undefined);
});

test("batched persistence and paginated restore retain600 records without altering host metadata", async () => {
  const f = fixture();
  f.storage.values.set("host/private", bytes("control"));
  for (let i = 0; i < 600; i++)
    await f.live.save(`tree/${i.toString().padStart(4, "0")}`, bytes(String(i)));
  assert.equal(f.storage.puts, 0);
  await f.live.flush();
  assert.equal(f.storage.puts, 5);
  const reopened = new BufferedRecordStore(f.sink);
  assert.equal((await reopened.list("")).length, 600);
  assert.deepEqual(await reopened.load("tree/0599"), bytes("599"));
  assert.deepEqual(f.storage.values.get("host/private"), bytes("control"));
});

test("large native records stay binary and are split below request limits", async () => {
  const f = fixture();
  const value = new Uint8Array(1_850_000).fill(7);
  await f.live.save("tree/a", value);
  await f.live.save("tree/b", value);
  value.fill(9);
  await f.live.flush();
  assert.equal(f.storage.puts, 2);
  const reopened = new BufferedRecordStore(f.sink);
  const loaded = await reopened.load("tree/a");
  assert.equal(loaded[0], 7);
  loaded.fill(5);
  assert.equal((await reopened.load("tree/a"))[0], 7);
  assert.equal((await reopened.list("")).length, 2);
});

for (const grouped of [false, true]) {
  for (const count of [127, 128]) {
    for (const maxBatchKeys of [undefined, 1, 64, 127, 128, 256]) {
      test(`record batch boundary: ${count} records, grouped=${grouped}, maxBatchKeys=${maxBatchKeys}`, async (t) => {
        const warnings = [];
        t.mock.method(console, "warn", (line) => warnings.push(JSON.parse(line)));
        const f = fixture({ maxBatchKeys });
        await f.live.ready;
        const writes = [];
        const put = f.storage.put.bind(f.storage);
        t.mock.method(f.storage, "put", async (values) => {
          assert.equal(values["host/seq"], String(writes.length + 1));
          writes.push(Object.keys(values).filter((key) => key.startsWith("repo/")));
          return put(values);
        });
        const entries = Array.from({ length: count }, (_, i) => [`tree/${i}`, bytes(String(i))]);
        if (grouped) await f.live.saveMany(entries);
        else for (const [key, value] of entries) await f.live.save(key, value);
        await f.live.flush();
        const limit = grouped && count === 127 ? 127 : Math.min(maxBatchKeys ?? 127, 127);
        assert.deepEqual(
          writes.map((keys) => keys.length),
          Array.from({ length: Math.ceil(count / limit) }, (_, i) =>
            Math.min(limit, count - i * limit),
          ),
        );
        assert.deepEqual(
          writes.flat(),
          entries.map(([key]) => `repo/${key}`),
        );
        assert.equal(warnings.length, grouped && count === 128 ? 1 : 0);
        assert.equal(f.live.dirty, false);
        for (const [key, value] of entries)
          assert.deepEqual(f.storage.values.get(`repo/${key}`), value);
      });
    }
  }
}

test("record batch boundary: a full group stays separate from adjacent records", async () => {
  const f = fixture();
  await f.live.save("tree/before", bytes("before"));
  await f.live.saveMany(Array.from({ length: 127 }, (_, i) => [`tree/${i}`, bytes(String(i))]));
  await f.live.save("tree/after", bytes("after"));
  await f.live.flush();
  assert.equal(f.storage.puts, 3);
  assert.equal(f.storage.values.get("host/seq"), "3");
  assert.equal(f.storage.values.size, 131);
});

test("record batch boundary: owner reserves sequence metadata but accepts legacy 128-record batches", async (t) => {
  for (const seq of [undefined, "1"]) {
    for (const count of [127, 128, 129]) {
      for (const value of [bytes("value"), undefined]) {
        const f = fixture();
        await f.live.ready;
        const before = new Map(f.storage.values);
        const put = t.mock.method(f.storage, "put");
        const remove = t.mock.method(f.storage, "delete");
        const response = await f.owner.fetch(
          new Request("https://records.internal/records", {
            method: "POST",
            body: encodeRecordBatch(Array.from({ length: count }, (_, i) => [`tree/${i}`, value])),
            headers: {
              "x-pages-record-generation": await f.sink.generation(),
              ...(seq !== undefined && { "x-pages-record-seq": seq }),
            },
          }),
        );
        const accepted = count <= (seq === undefined ? 128 : 127);
        assert.equal(
          response.status,
          accepted ? 204 : 400,
          `seq=${seq}, count=${count}, value=${value}`,
        );
        if (!accepted) {
          assert.equal(put.mock.callCount(), 0);
          assert.equal(remove.mock.callCount(), 0);
          assert.deepEqual(f.storage.values, before);
          assert.equal(f.owner.seq, 0);
        } else {
          assert.equal(f.storage.values.get("host/seq"), seq ?? "0");
          assert.equal(f.storage.values.size, value === undefined ? 2 : count + 2);
        }
      }
    }
  }
});

test("records saved together persist in one write or are split with a bounded log", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(JSON.parse(line)));
  const f = fixture({ maxBatchKeys: 1 });
  const writes = [];
  const put = f.storage.put.bind(f.storage);
  f.storage.put = async (values) => {
    const keys = Object.keys(values).filter((key) => key.startsWith("repo/"));
    if (keys.length) writes.push(keys);
    return put(values);
  };
  await f.live.save("tree/before", bytes("0"));
  await f.live.saveMany([
    ["tree/a", bytes("1")],
    ["tree/b", bytes("2")],
    ["tree/c", bytes("3")],
  ]);
  await f.live.save("tree/after", bytes("4"));
  await f.live.flush();
  assert.deepEqual(writes, [
    ["repo/tree/before", "repo/tree/a", "repo/tree/b", "repo/tree/c"],
    ["repo/tree/after"],
  ]);
  assert.deepEqual(warnings, []);
  // A failed flush keeps the group whole on retry.
  writes.length = 0;
  await f.live.saveMany([
    ["tree/d", bytes("5")],
    ["tree/e", bytes("6")],
  ]);
  f.storage.barrier = deferred();
  const failing = assert.rejects(f.live.flush(), /persist/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.storage.barrier.reject(Error("bucket unavailable"));
  await failing;
  f.storage.barrier = undefined;
  await f.live.flush();
  assert.deepEqual(writes.at(-1), ["repo/tree/d", "repo/tree/e"]);
  // A group over one request's 127 records cannot be atomic.
  writes.length = 0;
  await f.live.saveMany(
    Array.from({ length: 130 }, (_, i) => [`tree/g${String(i).padStart(3, "0")}`, bytes("g")]),
  );
  await f.live.flush();
  assert.equal(writes.length, 130);
  assert.deepEqual(
    warnings.map(({ event, records }) => ({ event, records })),
    [{ event: "records.group_split", records: 130 }],
  );
  // Installation is all-or-nothing under the replica cap.
  const small = fixture({ maxBytes: 4 });
  await assert.rejects(
    small.live.saveMany([
      ["tree/x", bytes("12")],
      ["tree/y", bytes("345")],
    ]),
  );
  assert.equal(await small.live.load("tree/x"), undefined);
  assert.equal(small.live.dirty, false);
});

test("capacity rejects before replacing accepted data; failed restore never exposes a partial replica", async () => {
  const f = fixture({ maxBytes: 12 });
  await f.live.save("key", bytes("123456789"));
  await assert.rejects(f.live.save("key", bytes("1234567890")), { status: 413 });
  assert.deepEqual(await f.live.load("key"), bytes("123456789"));
  await f.live.flush();
  const small = new BufferedRecordStore(f.sink, { maxBytes: 5 });
  await assert.rejects(small.load("key"), /capacity/);
});

test("malformed and conflicting batches never reach storage", async () => {
  const f = fixture();
  const generation = await f.sink.generation();
  const request = (body) =>
    new Request("https://records.internal/records", {
      method: "POST",
      body,
      headers: { "x-pages-record-generation": generation },
    });
  assert.equal((await f.owner.fetch(request(new Uint8Array([0, 0, 0])))).status, 400);
  const duplicate = encodeRecordBatch([
    ["key", bytes("a")],
    ["key", undefined],
  ]);
  assert.equal((await f.owner.fetch(request(duplicate))).status, 400);
  assert.equal(f.storage.puts, 0);
  const entries = [
    ["clé", new Uint8Array()],
    ["gone", undefined],
  ];
  assert.deepEqual(decodeRecordBatch(encodeRecordBatch(entries)), entries);
});

test("a restored Page fences late writes from an older incarnation before its snapshot", async () => {
  const f = fixture();
  await f.live.save("tree/accepted", bytes("base"));
  await f.live.flush();
  const oldGeneration = await f.sink.generation();
  await f.live.save("tree/late", bytes("stale pending batch"));
  const fresh = new RemoteRecordSink({ fetch: (request) => f.owner.fetch(request) });
  const reopened = new BufferedRecordStore(fresh);
  assert.deepEqual(await reopened.load("tree/accepted"), bytes("base"));
  assert.notEqual(await fresh.generation(), oldGeneration);
  await assert.rejects(f.live.flush(), /Could not persist records/);
  assert.equal(f.live.dirty, true, "superseded writer retains its unacknowledged changes");
  assert.equal(await reopened.load("tree/late"), undefined);
  await reopened.save("tree/new", bytes("current generation"));
  await reopened.flush();
  // Even after PageRecords itself restarts, the durable generation rejects the old writer.
  const restartedOwner = new PageRecords({ storage: f.storage });
  const stale = await restartedOwner.fetch(
    new Request("https://records.internal/records", {
      method: "POST",
      body: encodeRecordBatch([["tree/stale", bytes("not admitted")]]),
      headers: { "x-pages-record-generation": oldGeneration },
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(f.storage.values.has("repo/tree/stale"), false);
  assert.equal(
    await f.sink.generation(),
    oldGeneration,
    "old sink cannot silently retake its lease",
  );
});

test("new owner snapshots include a previous write that reached the record owner first", async () => {
  const f = fixture();
  await f.live.save("tree/prior", bytes("accepted before handoff"));
  f.storage.barrier = deferred();
  const entered = deferred();
  const sync = f.storage.sync.bind(f.storage);
  f.storage.sync = async () => {
    entered.resolve();
    await sync();
  };
  const saving = f.live.flush();
  await entered.promise;
  // The existing owner processes requests in order, including its sync barrier.
  const fresh = new RemoteRecordSink({ fetch: (request) => f.owner.fetch(request) });
  const restored = new BufferedRecordStore(fresh);
  f.storage.barrier.resolve();
  await saving;
  assert.deepEqual(await restored.load("tree/prior"), bytes("accepted before handoff"));
});

test(
  "an unanswered PageRecords request rejects the flush and keeps its records for retry",
  { timeout: 5000 },
  async () => {
    const storage = new Storage();
    const owner = new PageRecords({ storage });
    let hold = false;
    const unanswered = [];
    const sink = new RemoteRecordSink(
      {
        fetch(request) {
          // The batch waits behind a stalled owner and is not answered in time.
          if (hold && request.method === "POST" && new URL(request.url).pathname === "/records")
            return new Promise((resolve) => unanswered.push({ request, resolve }));
          return owner.fetch(request);
        },
      },
      { timeoutMs: 50 },
    );
    const live = new BufferedRecordStore(sink);
    await live.save("tree/first", bytes("one"));
    hold = true;
    const started = Date.now();
    await assert.rejects(live.flush(), { status: 503, code: "record_persistence_timeout" });
    assert.ok(Date.now() - started < 2000, "the flush settles at the request deadline");
    assert.equal(unanswered.length, 1);
    assert.equal(unanswered[0].request.signal.aborted, true, "the abandoned request is aborted");
    assert.equal(live.dirty, true, "the unconfirmed batch stays pending");
    // When the owner reaches the abandoned request, it skips the write.
    const late = await owner.fetch(unanswered[0].request);
    assert.equal(late.status, 503);
    unanswered[0].resolve(late);
    assert.equal(storage.puts, 0);
    // A later flush queues behind nothing and persists the retained records.
    hold = false;
    await live.save("tree/second", bytes("two"));
    await live.flush();
    assert.equal(live.dirty, false);
    const reopened = new BufferedRecordStore(
      new RemoteRecordSink({ fetch: (request) => owner.fetch(request) }),
    );
    assert.deepEqual(await reopened.load("tree/first"), bytes("one"));
    assert.deepEqual(await reopened.load("tree/second"), bytes("two"));
  },
);

/** PageRecords stubs from a factory. A broken stub rejects every call with
 * the error that broke it, like a Cloudflare stub after many exceptions. */
function stubFactory(owner) {
  const made = [];
  const factory = () => {
    const stub = {
      calls: [],
      broken: undefined,
      breakNext: false,
      fetch(request) {
        stub.calls.push(`${request.method} ${new URL(request.url).pathname}`);
        if (stub.breakNext) {
          stub.breakNext = false;
          stub.broken = Object.assign(Error("Network connection lost."), { retryable: true });
        }
        if (stub.broken) return Promise.reject(stub.broken);
        return owner.fetch(request);
      },
    };
    made.push(stub);
    return stub;
  };
  return { factory, made };
}

test("a sink reuses a working PageRecords stub, and an HTTP error answer keeps it", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const { factory, made } = stubFactory({
    fetch: (request) =>
      refuse ? Promise.resolve(new Response(null, { status: 503 })) : owner.fetch(request),
  });
  let refuse = false;
  const live = new BufferedRecordStore(new RemoteRecordSink(factory));
  for (const name of ["a", "b", "c"]) {
    await live.save(`tree/${name}`, bytes(name));
    await live.flush();
  }
  refuse = true;
  await live.save("tree/d", bytes("d"));
  await assert.rejects(live.flush(), /Could not persist records/);
  refuse = false;
  await live.flush();
  assert.equal(made.length, 1, "consecutive batches go through one stub, in order");
  assert.deepEqual(made[0].calls, [
    "POST /lease",
    "GET /records",
    "POST /records",
    "POST /records",
    "POST /records",
    "POST /records",
    "POST /records",
  ]);
});

test("a stub that throws once and stays broken is replaced: the next flush persists through a fresh stub", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const { factory, made } = stubFactory(owner);
  const live = new BufferedRecordStore(new RemoteRecordSink(factory));
  await live.save("tree/first", bytes("one"));
  await live.flush();
  made[0].breakNext = true;
  await live.save("tree/second", bytes("two"));
  await assert.rejects(live.flush(), { status: 503, code: "record_persistence_unavailable" });
  assert.equal(live.dirty, true, "the failed batch stays pending");
  // The broken stub would fail every later call at once; it gets none.
  const before = made[0].calls.length;
  await live.save("tree/third", bytes("three"));
  await live.flush();
  assert.equal(made[0].calls.length, before, "the broken stub is not used again");
  assert.equal(made.length, 2);
  assert.deepEqual(made[1].calls, ["POST /records"], "the fresh stub keeps the sink's lease");
  assert.equal(live.dirty, false);
  const reopened = new BufferedRecordStore(
    new RemoteRecordSink({ fetch: (request) => owner.fetch(request) }),
  );
  for (const [key, value] of [
    ["tree/first", "one"],
    ["tree/second", "two"],
    ["tree/third", "three"],
  ])
    assert.deepEqual(await reopened.load(key), bytes(value), key);
});

test("a sink whose factory throws asks it again on the next request", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const { factory, made } = stubFactory(owner);
  let unavailable = false;
  const live = new BufferedRecordStore(
    new RemoteRecordSink(() => {
      if (unavailable) throw Error("binding unavailable");
      return factory();
    }),
  );
  await live.save("tree/first", bytes("one"));
  await live.flush();
  made[0].breakNext = true;
  await live.save("tree/second", bytes("two"));
  await assert.rejects(live.flush(), { status: 503, code: "record_persistence_unavailable" });
  unavailable = true;
  await assert.rejects(live.flush(), /binding unavailable/);
  unavailable = false;
  await live.flush();
  assert.equal(made.length, 2);
  assert.equal(live.dirty, false);
});

test(
  "a timed-out request drops its stub, and its late failure never drops the fresh one",
  { timeout: 5000 },
  async () => {
    const storage = new Storage();
    const owner = new PageRecords({ storage });
    const made = [];
    let hang;
    const sink = new RemoteRecordSink(
      () => {
        const stub = {
          calls: 0,
          fetch(request) {
            stub.calls++;
            if (hang && request.method === "POST" && new URL(request.url).pathname === "/records") {
              const late = deferred();
              hang = late;
              return late.promise;
            }
            return owner.fetch(request);
          },
        };
        made.push(stub);
        return stub;
      },
      { timeoutMs: 50 },
    );
    const live = new BufferedRecordStore(sink);
    await live.save("tree/first", bytes("one"));
    hang = true;
    await assert.rejects(live.flush(), { code: "record_persistence_timeout" });
    const late = hang;
    hang = undefined;
    await live.flush();
    assert.equal(made.length, 2, "the next request after a timeout uses a fresh stub");
    // The abandoned request fails afterwards, on the old stub.
    late.reject(Error("Network connection lost."));
    await new Promise((resolve) => setImmediate(resolve));
    await live.save("tree/second", bytes("two"));
    await live.flush();
    assert.equal(made.length, 2, "a late failure on an old stub keeps the current one");
    assert.equal(made[1].calls, 2);
  },
);

test("the storage gate wraps every stub the sink's factory makes", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const { factory, made } = stubFactory(owner);
  let refusal;
  const live = new BufferedRecordStore(new RemoteRecordSink(guardStubs(factory, () => refusal)));
  await live.save("tree/first", bytes("one"));
  await live.flush();
  made[0].breakNext = true;
  await live.save("tree/second", bytes("two"));
  await assert.rejects(live.flush(), { status: 503, code: "record_persistence_unavailable" });
  // The object is abandoned: the replacement stub refuses the write too.
  refusal = Object.assign(Error("Page object was reset"), { status: 503 });
  await assert.rejects(live.flush(), /Page object was reset/);
  assert.ok(made.length >= 2, "the gate refused on a fresh stub");
  assert.deepEqual(
    made.slice(1).flatMap((stub) => stub.calls),
    [],
    "no write reached PageRecords",
  );
  assert.equal(live.dirty, true);
  refusal = undefined;
  await live.flush();
  assert.equal(live.dirty, false);
});

const text = (value) => new TextDecoder().decode(value);

/** A stub whose first records POST is held in transit: the request is copied
 * at once and delivered later by `deliver()`, and the stub never answers it. */
function transitFactory(owner, { propagatesAbort = false } = {}) {
  const held = [];
  let made = 0;
  const factory = () => {
    const n = ++made;
    return {
      async fetch(request) {
        const post = request.method === "POST" && new URL(request.url).pathname === "/records";
        if (n === 1 && post && !held.length) {
          const body = await request.arrayBuffer();
          held.push(() =>
            owner().fetch(
              new Request(request.url, {
                method: "POST",
                body,
                headers: request.headers,
                ...(propagatesAbort && { signal: request.signal }),
              }),
            ),
          );
          return new Promise(() => {});
        }
        return owner().fetch(request);
      },
    };
  };
  return { factory, held, made: () => made };
}

/** One timed-out batch (manifest -> snapshot 1), then a compaction batch on a
 * fresh stub (manifest -> snapshot 2, snapshot 1 removed). */
async function compactAfterTimeout(sink) {
  const live = new BufferedRecordStore(sink);
  await live.save("sync/d/m", bytes("manifest -> s/1"));
  await live.save("sync/d/s/1/0", bytes("snapshot 1"));
  await assert.rejects(live.flush(), { code: "record_persistence_timeout" });
  await live.save("sync/d/m", bytes("manifest -> s/2"));
  await live.save("sync/d/s/2/0", bytes("snapshot 2"));
  await live.remove("sync/d/s/1/0");
  await live.flush();
  return live;
}

for (const propagatesAbort of [false, true]) {
  test(`a batch delivered late, after a newer batch on a fresh stub, is skipped (abort reaches PageRecords: ${propagatesAbort})`, async () => {
    const storage = new Storage();
    const owner = new PageRecords({ storage });
    const transit = transitFactory(() => owner, { propagatesAbort });
    await compactAfterTimeout(
      new RemoteRecordSink(
        guardStubs(transit.factory, () => undefined),
        { timeoutMs: 30 },
      ),
    );
    assert.equal(transit.made(), 2);
    const late = await transit.held[0]();
    assert.equal(late.status, propagatesAbort ? 503 : 204);
    assert.equal(text(storage.values.get("repo/sync/d/m")), "manifest -> s/2");
    assert.equal(
      storage.values.has("repo/sync/d/s/1/0"),
      false,
      "the compacted snapshot stays gone",
    );
    assert.equal(text(storage.values.get("repo/sync/d/s/2/0")), "snapshot 2");
    assert.equal(storage.values.get("host/seq"), "2", "the newer batch's sequence is stored");
    if (!propagatesAbort) assert.equal(late.headers.get("x-pages-record-batch"), "superseded");
  });
}

test("a late batch arriving before the newer one is overwritten by it", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const transit = transitFactory(() => owner);
  const live = new BufferedRecordStore(new RemoteRecordSink(transit.factory, { timeoutMs: 30 }));
  await live.save("sync/d/m", bytes("manifest -> s/1"));
  await assert.rejects(live.flush(), { code: "record_persistence_timeout" });
  assert.equal((await transit.held[0]()).status, 204);
  assert.equal(text(storage.values.get("repo/sync/d/m")), "manifest -> s/1");
  await live.save("sync/d/m", bytes("manifest -> s/2"));
  await live.flush();
  assert.equal(text(storage.values.get("repo/sync/d/m")), "manifest -> s/2");
});

test("the batch sequence survives a PageRecords restart", async () => {
  const storage = new Storage();
  let owner = new PageRecords({ storage });
  const transit = transitFactory(() => owner);
  await compactAfterTimeout(new RemoteRecordSink(transit.factory, { timeoutMs: 30 }));
  // A new PageRecords object over the same storage reads the sequence back.
  owner = new PageRecords({ storage });
  assert.equal(owner.seq, undefined);
  const late = await transit.held[0]();
  assert.equal(late.status, 204);
  assert.equal(late.headers.get("x-pages-record-batch"), "superseded");
  assert.equal(text(storage.values.get("repo/sync/d/m")), "manifest -> s/2");
  assert.equal(owner.seq, 2);
});

test("a new lease restarts the sequence and fences every batch of the old generation", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const stub = { fetch: (request) => owner.fetch(request) };
  const first = new RemoteRecordSink(stub);
  const before = new BufferedRecordStore(first);
  for (const n of [1, 2, 3]) {
    await before.save(`tree/${n}`, bytes(`old ${n}`));
    await before.flush();
  }
  assert.equal(storage.values.get("host/seq"), "3");
  // The Page host restarts: a new sink takes a new lease and starts at 1.
  const after = new BufferedRecordStore(new RemoteRecordSink(stub));
  await after.ready;
  assert.equal(storage.values.get("host/seq"), "0");
  await after.save("tree/1", bytes("new 1"));
  await after.flush();
  assert.equal(storage.values.get("host/seq"), "1");
  assert.equal(text(storage.values.get("repo/tree/1")), "new 1");
  // The old host's next batch has a higher sequence but the old generation.
  await before.save("tree/1", bytes("old 4"));
  await assert.rejects(before.flush(), /Could not persist records/);
  assert.equal(text(storage.values.get("repo/tree/1")), "new 1");
});

test("PageRecords checks the batch sequence header and accepts a batch without one", async () => {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const generation = await (
    await owner.fetch(new Request("https://records.internal/lease", { method: "POST" }))
  ).text();
  const post = (seq, value) =>
    owner.fetch(
      new Request("https://records.internal/records", {
        method: "POST",
        body: encodeRecordBatch([["tree/a", bytes(value)]]),
        headers: {
          "x-pages-record-generation": generation,
          ...(seq !== undefined && { "x-pages-record-seq": seq }),
        },
      }),
    );
  for (const bad of ["0", "-1", "1.5", "x", "99999999999999999"])
    assert.equal((await post(bad, "bad")).status, 400, bad);
  assert.equal((await post(undefined, "legacy")).status, 204);
  assert.equal(text(storage.values.get("repo/tree/a")), "legacy");
  assert.equal((await post("5", "five")).status, 204);
  assert.equal((await post("5", "again")).headers.get("x-pages-record-batch"), "superseded");
  assert.equal((await post("4", "four")).headers.get("x-pages-record-batch"), "superseded");
  assert.equal(text(storage.values.get("repo/tree/a")), "five");
});

test("a flagged PageRecords throw is a retryable 503; any other throw passes unchanged", async (t) => {
  t.mock.method(console, "error", () => {});
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  let fault;
  const live = new BufferedRecordStore(
    new RemoteRecordSink(() => ({
      fetch: (request) => {
        const error = fault;
        fault = undefined;
        return error ? Promise.reject(error) : owner.fetch(request);
      },
    })),
  );
  await live.save("tree/a", bytes("a"));
  await live.flush();
  for (const [flags, waits] of [
    [{ overloaded: true }, [2000, 3000, 4000, 5000]],
    [{ overloaded: true, retryable: true }, [2000, 3000, 4000, 5000]],
    [{ retryable: true }, [1000]],
  ]) {
    const cause = Object.assign(Error("Durable Object is overloaded."), flags);
    fault = cause;
    await live.save("tree/a", bytes(JSON.stringify(flags)));
    const error = await live.flush().then(
      () => assert.fail("the flush must fail"),
      (thrown) => thrown,
    );
    assert.equal(error.code, "record_persistence_unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.cause, cause);
    assert.ok(waits.includes(error.retryAfterMs), String(error.retryAfterMs));
    assert.equal(live.dirty, true, "the records stay pending");
    const response = errorResponse(error, "page");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), String(error.retryAfterMs / 1000));
    const body = await response.json();
    assert.equal(body.code, "record_persistence_unavailable");
    assert.equal(body.retryable, true);
    assert.equal(body.retry_after_ms, error.retryAfterMs);
    assert.match(body.error, /same idempotency_key and retry_token/);
    await live.flush();
    assert.equal(live.dirty, false);
  }
  const plain = Error("example error");
  fault = plain;
  await live.save("tree/a", bytes("plain"));
  await assert.rejects(live.flush(), (thrown) => thrown === plain);
});
