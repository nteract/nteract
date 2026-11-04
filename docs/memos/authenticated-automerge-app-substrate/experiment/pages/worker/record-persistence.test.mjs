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
  assert.deepEqual([...f.storage.values.keys()], ["host/generation"]);
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
  // A group over one request's 128 keys cannot be atomic.
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
  await assert.rejects(live.flush(), { retryable: true });
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
  await assert.rejects(live.flush(), { retryable: true });
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
  await assert.rejects(live.flush(), { retryable: true });
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
