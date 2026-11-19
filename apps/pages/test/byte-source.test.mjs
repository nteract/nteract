import assert from "node:assert/strict";
import test from "node:test";
import { exposeFile, receiveFile } from "@nteract/output-frame/byte-source";
import { VirtualTimeScheduler } from "rxjs";
import { createReadBudget, READ_WAITING_LIMIT } from "@nteract/output-frame/read-budget";
import { openAssetByteSource } from "../viewer/asset-byte-source.mjs";

// The frame's range reads on an exposed file.
function rangeReader(descriptor, lifetime) {
  const file = receiveFile(descriptor, lifetime);
  return {
    read: (offset, length, signal) => file.request({ kind: "range", offset, length }, signal),
  };
}

test("a file capability transfers only the selected span and cancels individual reads", async () => {
  const lifetime = new AbortController();
  let started, cancelled;
  const waiting = new Promise((r) => {
    started = r;
  });
  const stopped = new Promise((r) => {
    cancelled = r;
  });
  const input = {
    byteLength: 9,
    async read(offset, length, signal) {
      if (offset !== 1) return Uint8Array.from([0, 1, 2, 3, 4]).subarray(2, 2 + length);
      started();
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  try {
    const source = rangeReader(exposeFile(input, lifetime.signal), lifetime.signal);
    const controller = new AbortController();
    const pending = source.read(1, 1, controller.signal);
    await waiting;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await stopped;
    const result = await source.read(0, 2);
    assert.equal(result.buffer.byteLength, 2);
    assert.deepEqual([...result], [2, 3]);
    await assert.rejects(source.read(8, 2), { message: "Invalid file read." });
  } finally {
    lifetime.abort();
  }
});

test("a full response to a requested range is refused without consuming the file", async () => {
  let cancelled = false;
  const source = await openAssetByteSource(
    "33333333-3333-4333-8333-333333333333",
    { asset_id: "a".repeat(64), media_type: "application/octet-stream" },
    {
      request: async (_, opt) =>
        opt.method === "HEAD"
          ? new Response(null, {
              headers: {
                "content-length": "4096",
                "x-pages-media-type": "application/octet-stream",
              },
            })
          : new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
    },
  );
  await assert.rejects(source.read(0, 4), /requested range/);
  assert.ok(cancelled);
});

test("partial responses without Content-Length must deliver exactly the requested bytes", async () => {
  let size = 4;
  const source = await openAssetByteSource(
    "33333333-3333-4333-8333-333333333333",
    { asset_id: "a".repeat(64), media_type: "application/octet-stream" },
    {
      request: async (_, options) =>
        options.method === "HEAD"
          ? new Response(null, {
              headers: { "content-length": "8", "x-pages-media-type": "application/octet-stream" },
            })
          : new Response(new Uint8Array(size), {
              status: 206,
              headers: { "content-range": "bytes 2-5/8" },
            }),
    },
  );
  assert.equal((await source.read(2, 4)).byteLength, 4);
  size = 3;
  await assert.rejects(source.read(2, 4), /Incomplete range/);
  size = 5;
  await assert.rejects(source.read(2, 4), /exceeds requested length/);
});

// A source whose reads finish only when the test says so. Each read's bytes
// are its own offsets, so a reply shows which interval it answers.
function heldSource(byteLength = 4096) {
  const calls = [];
  const source = {
    byteLength,
    read(offset, length, signal) {
      return new Promise((resolve, reject) => {
        calls.push({
          offset,
          finish: () => resolve(Uint8Array.from({ length }, (_, i) => (offset + i) % 256)),
        });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  return { source, calls };
}

// Sends one request on the raw port protocol and records every reply. Open
// reply ports would keep the test process alive, so each test closes them.
// `closed` settles when the other side closes the reply port.
const replyPorts = new Set();
test.afterEach(() => {
  for (const port of replyPorts) port.close();
  replyPorts.clear();
});
function rawRead({ port }, offset, length) {
  const { port1, port2 } = new MessageChannel();
  replyPorts.add(port1);
  const replies = [];
  port1.onmessage = ({ data }) => replies.push(data);
  const closed = new Promise((resolve) => port1.addEventListener("close", resolve, { once: true }));
  port.postMessage({ kind: "range", offset, length }, [port2]);
  return { replies, closed, cancel: () => port1.postMessage("cancel"), close: () => port1.close() };
}

// A port handles its requests in order, and an invalid interval is answered
// at once without entering the budget. That answer therefore shows every
// earlier request on the same port has been handled.
async function handled(file) {
  if (typeof file.read === "function") {
    await assert.rejects(file.read(-1, 1), { message: "Invalid file read." });
    return;
  }
  const probe = rawRead(file, -1, 1);
  await until(() => probe.replies.length === 1, "the probe is answered");
  probe.close();
}

async function until(predicate, what) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a ninth concurrent read on one file waits for a slot, then completes", async () => {
  const lifetime = new AbortController();
  const { source, calls } = heldSource();
  try {
    const file = rangeReader(exposeFile(source, lifetime.signal), lifetime.signal);
    const reads = Array.from({ length: 9 }, (_, i) => file.read(i * 10, 3));
    await handled(file);
    assert.equal(calls.length, 8);
    calls[2].finish();
    assert.deepEqual([...(await reads[2])], [20, 21, 22]);
    await until(() => calls.length === 9, "the ninth read starts");
    assert.equal(calls[8].offset, 80);
    calls[8].finish();
    assert.deepEqual([...(await reads[8])], [80, 81, 82]);
    for (const call of calls) call.finish();
    await Promise.all(reads);
  } finally {
    lifetime.abort();
  }
});

test("files of one view share its read slots", async () => {
  const lifetime = new AbortController();
  const budget = createReadBudget({ lifetime: lifetime.signal });
  const a = heldSource();
  const b = heldSource();
  try {
    const fileA = rangeReader(exposeFile(a.source, lifetime.signal, budget), lifetime.signal);
    const fileB = rangeReader(exposeFile(b.source, lifetime.signal, budget), lifetime.signal);
    const readsA = Array.from({ length: 8 }, (_, i) => fileA.read(i, 1));
    await handled(fileA);
    const readB = fileB.read(5, 2);
    await handled(fileB);
    assert.equal(a.calls.length, 8);
    assert.equal(b.calls.length, 0);
    a.calls[0].finish();
    await until(() => b.calls.length === 1, "the other file's read starts");
    b.calls[0].finish();
    assert.deepEqual([...(await readB)], [5, 6]);
    for (const call of a.calls) call.finish();
    await Promise.all(readsA);
  } finally {
    lifetime.abort();
  }
});

test("a waiting read cancelled by the frame is never read and gets no reply", async () => {
  const lifetime = new AbortController();
  const { source, calls } = heldSource();
  try {
    const file = exposeFile(source, lifetime.signal);
    const running = Array.from({ length: 8 }, (_, i) => rawRead(file, i, 1));
    const waiting = rawRead(file, 100, 1);
    await handled(file);
    waiting.cancel();
    // The parent closes a waiting read's reply port when it drops the read.
    await waiting.closed;
    for (const call of calls) call.finish();
    await until(
      () => running.every(({ replies }) => replies.length === 1),
      "every running read is answered",
    );
    assert.equal(calls.length, 8);
    assert.deepEqual(waiting.replies, []);
    assert.ok(running.every(({ replies }) => replies[0].bytes));
  } finally {
    lifetime.abort();
  }
});

test("an invalid interval is refused at once while the slots are full", async () => {
  const lifetime = new AbortController();
  const { source, calls } = heldSource(64);
  try {
    const file = exposeFile(source, lifetime.signal);
    Array.from({ length: 8 }, (_, i) => rawRead(file, i, 1));
    const invalid = [rawRead(file, 60, 8), rawRead(file, -1, 1), rawRead(file, 0.5, 1)];
    await until(
      () => invalid.every(({ replies }) => replies.length === 1),
      "every invalid read is answered",
    );
    assert.equal(calls.length, 8);
    for (const { replies } of invalid) assert.deepEqual(replies, [{ error: "Invalid file read." }]);
    for (const call of calls) call.finish();
  } finally {
    lifetime.abort();
  }
});

test("a read that finds the waiting list full is refused", async () => {
  const lifetime = new AbortController();
  const { source, calls } = heldSource();
  try {
    const file = exposeFile(source, lifetime.signal);
    const admitted = Array.from({ length: 8 + READ_WAITING_LIMIT }, (_, i) => rawRead(file, i, 1));
    const refused = rawRead(file, 0, 1);
    await until(() => refused.replies.length === 1, "the refused read is answered");
    assert.equal(calls.length, 8);
    assert.deepEqual(refused.replies, [{ error: "Too many file reads are waiting." }]);
    assert.ok(admitted.every(({ replies }) => replies.length === 0));
  } finally {
    lifetime.abort();
  }
});

test("ending the view drops waiting reads without replies or further reads", async () => {
  const lifetime = new AbortController();
  const { source, calls } = heldSource();
  const file = exposeFile(source, lifetime.signal);
  const reads = Array.from({ length: 12 }, (_, i) => rawRead(file, i, 1));
  await handled(file);
  assert.equal(calls.length, 8);
  lifetime.abort();
  for (const call of calls) call.finish();
  // The parent closes every reply port: at once for a waiting read, and when
  // its source settles for a read in flight.
  await Promise.all(reads.map((read) => read.closed));
  assert.equal(calls.length, 8);
  assert.ok(reads.every(({ replies }) => replies.length === 0));
});

// A file input with every request kind, each held until the test finishes it.
function heldFile({ byteLength = 64, columns = true } = {}) {
  const calls = [];
  const held = (kind, value) => (signal) =>
    new Promise((resolve, reject) => {
      calls.push({ kind, signal, finish: (result = value()) => resolve(result) });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const file = {
    mimeType: "application/octet-stream",
    byteLength,
    read: (offset, length, signal) =>
      held("range", () => Uint8Array.from({ length }, (_, i) => offset + i))(signal),
    bytes: held("bytes", () => Uint8Array.from({ length: byteLength }, (_, i) => i % 256)),
    ...(columns && {
      columns: held("columns", () => ({
        numRows: 2,
        columns: [{ name: "n", type: "number", values: new Float64Array([1, 2]) }],
      })),
    }),
  };
  return { file, calls };
}

function rawRequest({ port }, message) {
  const { port1, port2 } = new MessageChannel();
  replyPorts.add(port1);
  const replies = [];
  port1.onmessage = ({ data }) => replies.push(data);
  const closed = new Promise((resolve) => port1.addEventListener("close", resolve, { once: true }));
  port.postMessage(message, [port2]);
  return { replies, closed, cancel: () => port1.postMessage("cancel") };
}

test("a file port answers a whole-file read and a table read, and refuses what it cannot", async () => {
  const lifetime = new AbortController();
  const { file, calls } = heldFile();
  try {
    const exposed = exposeFile(file, lifetime.signal);
    assert.deepEqual(Object.keys(exposed).sort(), ["mimeType", "port", "size"]);
    assert.equal(exposed.size, 64);
    const frame = receiveFile(exposed, lifetime.signal);
    const whole = frame.request({ kind: "bytes" });
    const table = frame.request({ kind: "columns" });
    await until(() => calls.length === 2, "both requests start");
    for (const call of calls) call.finish();
    assert.equal((await whole).byteLength, 64);
    assert.deepEqual([...(await table).columns[0].values], [1, 2]);
    // Malformed requests are refused before the budget.
    for (const message of [null, "range", { kind: "stream" }, { kind: "range", offset: 1 }]) {
      const raw = rawRequest(exposed, message);
      await until(() => raw.replies.length === 1, "the refusal");
      assert.match(raw.replies[0].error, /Invalid file (request|read)\./);
    }
    assert.equal(calls.length, 2);
  } finally {
    lifetime.abort();
  }
  const plain = heldFile({ columns: false });
  const other = new AbortController();
  try {
    const frame = receiveFile(exposeFile(plain.file, other.signal), other.signal);
    await assert.rejects(frame.request({ kind: "columns" }), {
      message: "This file is not Parquet.",
    });
    assert.equal(plain.calls.length, 0);
  } finally {
    other.abort();
  }
});

test("a whole-file read past 5 MiB, a short whole file and a malformed ColumnSet are errors", async () => {
  const lifetime = new AbortController();
  try {
    const big = heldFile({ byteLength: 5 * 1024 * 1024 + 1 });
    const frameBig = receiveFile(exposeFile(big.file, lifetime.signal), lifetime.signal);
    await assert.rejects(
      frameBig.request({ kind: "bytes" }),
      /larger than 5 MiB; read it in ranges/,
    );
    assert.equal(big.calls.length, 0);
    const { file, calls } = heldFile();
    const frame = receiveFile(exposeFile(file, lifetime.signal), lifetime.signal);
    const short = frame.request({ kind: "bytes" });
    const bad = frame.request({ kind: "columns" });
    await until(() => calls.length === 2, "both start");
    calls[0].finish(new Uint8Array(3));
    calls[1].finish({ numRows: 1, columns: [{ name: "n", type: "number", values: [1] }] });
    await assert.rejects(short, { message: "Incomplete file read." });
    await assert.rejects(bad, /Invalid column set/);
  } finally {
    lifetime.abort();
  }
});

test("the frame refuses replies of the wrong shape", async () => {
  const lifetime = new AbortController();
  const { port1, port2 } = new MessageChannel();
  const replies = [
    { bytes: new Uint8Array(2) },
    { bytes: [1, 2, 3, 4] },
    {},
    { columns: { numRows: 1, columns: [{ name: "a", type: "number", values: [1] }] } },
  ];
  port1.onmessage = ({ ports: [reply] }) => {
    reply.postMessage(replies.shift());
    reply.close();
  };
  try {
    const frame = receiveFile({ size: 4, port: port2 }, lifetime.signal);
    await assert.rejects(frame.request({ kind: "bytes" }), { message: "Invalid file reply." });
    await assert.rejects(frame.request({ kind: "range", offset: 0, length: 4 }), {
      message: "Invalid file reply.",
    });
    await assert.rejects(frame.request({ kind: "bytes" }), { message: "Invalid file reply." });
    await assert.rejects(frame.request({ kind: "columns" }), /Invalid column set/);
  } finally {
    lifetime.abort();
    port1.close();
  }
});

test("every request kind waits in the view's one budget, and a cancelled one is never served", async () => {
  const lifetime = new AbortController();
  const scheduler = new VirtualTimeScheduler();
  const budget = createReadBudget({ lifetime: lifetime.signal, scheduler });
  const { file, calls } = heldFile();
  try {
    const exposed = exposeFile(file, lifetime.signal, budget);
    const ranges = Array.from({ length: 8 }, (_, i) =>
      rawRequest(exposed, { kind: "range", offset: i, length: 1 }),
    );
    const whole = rawRequest(exposed, { kind: "bytes" });
    const table = rawRequest(exposed, { kind: "columns" });
    const cancelled = rawRequest(exposed, { kind: "columns" });
    await until(() => calls.length === 8, "the slots fill");
    cancelled.cancel();
    await cancelled.closed;
    assert.deepEqual(
      calls.map(({ kind }) => kind),
      Array(8).fill("range"),
      "the whole-file and table reads wait like any read",
    );
    calls[0].finish();
    await until(() => calls.length === 9, "the whole-file read takes the freed slot");
    assert.equal(calls[8].kind, "bytes");
    calls[1].finish();
    await until(() => calls.length === 10, "the table read takes the next slot");
    assert.equal(calls[9].kind, "columns");
    for (const call of calls.slice(2)) call.finish();
    await until(
      () => [...ranges, whole, table].every(({ replies }) => replies.length === 1),
      "every admitted request is answered",
    );
    assert.equal(calls.length, 10, "the cancelled table read never ran");
    assert.deepEqual(cancelled.replies, []);
    // A whole-file read cancelled while it runs aborts its fetch.
    const running = rawRequest(exposed, { kind: "bytes" });
    await until(() => calls.length === 11, "it starts");
    running.cancel();
    await until(() => calls[10].signal.aborted, "the fetch is aborted");
  } finally {
    lifetime.abort();
  }
});
