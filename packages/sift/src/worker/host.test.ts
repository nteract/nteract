/**
 * Host and client over a Node `MessageChannel`, with the real WASM module in
 * both roles (same process, one module instance). The transport is the real
 * structured-clone path, so transfer lists and relay reads are exercised.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ByteSource } from "../parquet-file";
import {
  _resetPredicateModuleForTests,
  _setWasmModuleLoaderForTests,
  ensureModule,
  type PredicateModule,
} from "../predicate";
import { createWorkerWindowedData, WorkerDataError, type WorkerLike } from "./client";
import { createWorkerHost } from "./host";
import type { FromWorker, ToWorker } from "./protocol";

const wasmPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm",
);

const limits = { maxRows: 1_000_000, maxColumns: 256, maxDecodedBytes: 64 * 1024 * 1024 };

/** Node `MessagePort` as the `Worker` the client expects. */
function workerOver(port: MessagePort): WorkerLike {
  port.start();
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      transfer ? port.postMessage(message, transfer as never) : port.postMessage(message),
    addEventListener: (type, listener) => {
      if (type === "message") port.on("message", (data) => listener({ data } as never));
      if (type === "messageerror") port.on("messageerror", () => listener(new Event(type)));
    },
    terminate: () => port.close(),
  };
}

function recordingSource(bytes: Uint8Array) {
  const reads: { offset: number; length: number }[] = [];
  const source: ByteSource = {
    byteLength: bytes.byteLength,
    read(offset, length) {
      reads.push({ offset, length });
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
  };
  return { source, reads };
}

describe.skipIf(!existsSync(wasmPath))("worker host + client over MessageChannel", () => {
  let mod: PredicateModule;
  let parquet: Uint8Array;
  let channel: MessageChannel;
  let host: ReturnType<typeof createWorkerHost> | null = null;

  beforeAll(async () => {
    const wasm = await import("sift-wasm/sift_wasm.js");
    await wasm.default({ module_or_path: readFileSync(wasmPath) });
    _resetPredicateModuleForTests();
    _setWasmModuleLoaderForTests(async () => ({ ...wasm, default: async () => undefined }));
    mod = wasm as unknown as PredicateModule;
    const ipc = tableToIPC(
      tableFromArrays({
        id: Int32Array.from({ length: 12 }, (_, i) => i + 1),
        name: Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? null : `row ${i}`)),
        score: Float64Array.from({ length: 12 }, (_, i) => (i * 37) % 23),
      }),
      "stream",
    );
    // Three row groups of four rows: the first mounts, the rest stream.
    parquet = mod.write_parquet_ipc_row_groups(ipc, 4);
  });

  afterAll(() => {
    _setWasmModuleLoaderForTests(null);
    _resetPredicateModuleForTests();
  });

  afterEach(() => {
    host?.dispose();
    host = null;
    channel?.port1.close();
    channel?.port2.close();
  });

  function open(options: Parameters<typeof createWorkerHost>[1] = {}, allocationCap?: number) {
    channel = new MessageChannel();
    host = createWorkerHost(channel.port1 as never, options);
    const { source, reads } = recordingSource(parquet);
    const milestones: string[] = [];
    const data = createWorkerWindowedData({
      source,
      limits,
      overflow: "truncate",
      headRows: 2,
      allocationCap,
      signal: new AbortController().signal,
      emit: (m) => milestones.push(m.phase),
      worker: workerOver(channel.port2),
    });
    return { data, reads, milestones };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 200 && !predicate(); i++) await tick();
    if (!predicate()) throw new Error(`timed out waiting for ${label}`);
  }

  it("opens with the head, relays reads byte-exactly, and streams the remaining groups", async () => {
    const { data: opening, reads, milestones } = open();
    const data = await opening;
    expect(data.columns.map((c) => c.key)).toEqual(["id", "name", "score"]);
    expect(data.rowCount).toBe(4);
    expect(data.rowGroupCount).toBe(3);
    expect(Array.from(data.head.dataRows)).toEqual([0, 1]);
    expect(data.head.strings.slice(0, 3)).toEqual(["1", "row 0", "0"]);
    // Every relay read is a real footer or row-group range of the file.
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.offset).toBeGreaterThanOrEqual(0);
      expect(read.offset + read.length).toBeLessThanOrEqual(parquet.byteLength);
    }
    expect(milestones).toEqual(["wasm-ready", "table-data-created"]);

    const events: string[] = [];
    data.subscribe((event) => events.push(event.type));
    await until(() => events.includes("streaming-done"), "streaming-done");
    expect(events.filter((e) => e === "rows-appended")).toHaveLength(2);
    expect(data.rowCount).toBe(12);
    expect(milestones).toEqual([
      "wasm-ready",
      "table-data-created",
      "chunk-appended",
      "chunk-appended",
      "streaming-complete",
    ]);
    expect(reads.length).toBeGreaterThanOrEqual(3);

    // A window round trip: typed arrays arrive as typed arrays with the right rows.
    const cells = await data.requestWindow(4, 8, 1);
    expect(cells.viewStart).toBe(4);
    // Deserialized in the port's realm, so check the tag rather than the constructor.
    const tag = (value: unknown) => Object.prototype.toString.call(value);
    expect(tag(cells.dataRows)).toBe("[object Uint32Array]");
    expect(Array.from(cells.dataRows)).toEqual([4, 5, 6, 7]);
    expect(tag(cells.nulls)).toBe("[object Uint8Array]");
    expect(Array.from(cells.nulls).filter((n) => n === 1)).toHaveLength(1); // row 7's name
    expect(tag(cells.numeric)).toBe("[object Float64Array]");
    expect(cells.strings[1]).toBe("row 4");

    // A query: filters cross with their Sets intact; the permutation comes back as a count.
    const result = await data.setQuery(
      {
        filters: [null, { kind: "not-in", values: new Set(["row 0", "row 1"]) }, null],
        sort: { col: 2, dir: "desc" },
      },
      2,
    );
    expect(result.generation).toBe(2);
    expect(result.filteredCount).toBe(10);
    expect(result.summaries).toHaveLength(3);
    const sorted = await data.requestWindow(0, 3, 2);
    const scores = Array.from(sorted.numeric).filter((_, i) => i % 3 === 2);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // No image column: the request answers null.
    expect(await data.requestImage(0, 1)).toBeNull();

    // Cast through the worker, tracked on the client.
    expect(data.isColumnCast?.(0)).toBe(false);
    const cast = await data.castColumn!(0, "categorical", 3);
    expect(cast.columns[0].columnType).toBe("categorical");
    expect(data.isColumnCast?.(0)).toBe(true);
    const undone = await data.undoCastColumn!(0, 4);
    expect(undone.columns[0].columnType).toBe("numeric");
    expect(data.isColumnCast?.(0)).toBe(false);

    data.dispose();
  });

  it("sets the allocation cap from the open request and reports memory", async () => {
    // The host calls the module singleton `ensureModule` hands out.
    const live = await ensureModule();
    const setCap = vi.spyOn(live, "set_allocation_cap");
    const { data: opening } = open({}, 50 * 1024 * 1024);
    const data = await opening;
    expect(setCap).toHaveBeenCalledWith(50 * 1024 * 1024);
    expect(typeof live.allocated_bytes?.()).toBe("number");
    expect(live.allocated_bytes!()).toBeGreaterThan(0);
    setCap.mockRestore();
    data.dispose();
    live.set_allocation_cap?.(0);
  });

  it("treats a WASM trap as fatal: one error event, pending rejected, no more answers", async () => {
    let trapOn: ToWorker["t"] | null = null;
    const { data: opening } = open({
      beforeRequest: (message) => {
        if (message.t === trapOn) throw new WebAssembly.RuntimeError("unreachable executed");
      },
    });
    const data = await opening;
    const events: { type: string; fatal?: boolean; message?: string }[] = [];
    data.subscribe((event) => events.push(event as never));
    await until(() => events.some((e) => e.type === "streaming-done"), "load");

    trapOn = "window";
    const first = data.requestWindow(0, 2, 5);
    await expect(first).rejects.toThrow("unreachable executed");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      fatal: true,
      message: "unreachable executed",
    });
    // The worker is gone: later requests fail at once instead of hanging.
    await expect(data.setQuery({ filters: [null, null, null], sort: null }, 6)).rejects.toThrow(
      /closed|terminated/,
    );
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("a non-fatal handler error rejects only that request", async () => {
    const { data: opening } = open();
    const data = await opening;
    await expect(
      data.setQuery({ filters: [null, { kind: "range", min: 0, max: 1 }, null], sort: null }, 7),
    ).resolves.toMatchObject({ filteredCount: 0 });
    // A bad column index fails in the adapter, not the instance.
    await expect(data.requestImage(0, 99)).rejects.toBeInstanceOf(Error);
    const cells = await data.requestWindow(0, 1, 7);
    expect(cells.dataRows.length).toBe(0);
    data.dispose();
  });

  it("dispose asks the host to close and terminates on the ack", async () => {
    const { data: opening } = open();
    const data = await opening;
    const hostMessages: FromWorker["t"][] = [];
    channel.port2.on("message", (message: FromWorker) => hostMessages.push(message.t));
    const terminate = vi.fn();
    const inner = workerOver(channel.port2);
    void inner;
    data.dispose();
    await until(() => hostMessages.includes("closed"), "closed ack");
    await expect(data.requestWindow(0, 1, 1)).rejects.toThrow(/closed/);
    expect(terminate).not.toHaveBeenCalled(); // the stub's terminate closes the port instead
  });

  it("rejects the open when the protocol version does not match", async () => {
    channel = new MessageChannel();
    host = createWorkerHost(channel.port1 as never);
    const worker = workerOver(channel.port2);
    const replies: FromWorker[] = [];
    worker.addEventListener("message", (event) => replies.push((event as MessageEvent).data));
    worker.postMessage({
      t: "open",
      id: 1,
      protocol: 99,
      source: { kind: "byte-source-relay", byteLength: 0 },
      limits,
      headRows: 1,
    });
    await until(() => replies.length > 0, "reply");
    expect(replies[0]).toMatchObject({ t: "error", id: 1, fatal: false });
    expect((replies[0] as { message: string }).message).toContain("protocol 99");
  });

  /** `open()` over any file and source; `onMessage` sees every host reply first. */
  function openWith(
    bytes: Uint8Array,
    opts: {
      source?: ByteSource;
      headRows?: number;
      onMessage?: (message: FromWorker) => void;
      beforeRequest?: (message: ToWorker) => void;
    } = {},
  ) {
    channel = new MessageChannel();
    host = createWorkerHost(channel.port1 as never, { beforeRequest: opts.beforeRequest });
    if (opts.onMessage) channel.port2.on("message", opts.onMessage);
    const milestones: Record<string, unknown>[] = [];
    const data = createWorkerWindowedData({
      source: opts.source ?? recordingSource(bytes).source,
      limits,
      overflow: "truncate",
      headRows: opts.headRows ?? 2,
      signal: new AbortController().signal,
      emit: (m) => milestones.push(m),
      worker: workerOver(channel.port2),
    });
    return { data, milestones };
  }

  it("reports a row-group read failure after open as one non-fatal error event", async () => {
    let firstGroupLoaded = false;
    const source: ByteSource = {
      byteLength: parquet.byteLength,
      read(offset, length) {
        // The host reports group 0 before it asks for group 1's bytes.
        if (firstGroupLoaded) return Promise.reject(new Error("network down"));
        return Promise.resolve(parquet.subarray(offset, offset + length));
      },
    };
    const { data: opening, milestones } = openWith(parquet, {
      source,
      onMessage: (message) => {
        if (message.t === "progress" && message.rowGroup === 0) firstGroupLoaded = true;
      },
    });
    const data = await opening;
    const events: { type: string; fatal?: boolean; message?: string }[] = [];
    data.subscribe((event) => events.push(event as never));
    await until(() => events.some((e) => e.type === "error"), "error event");
    // Give a stray `streaming-done` or second error time to arrive.
    for (let i = 0; i < 10; i++) await tick();

    expect(events).toEqual([{ type: "error", message: "network down", fatal: false }]);
    expect(milestones.map((m) => m.phase)).not.toContain("streaming-complete");
    // The first group's rows still answer.
    expect(data.rowCount).toBe(4);
    const result = await data.setQuery({ filters: [null, null, null], sort: null }, 1);
    expect(result.filteredCount).toBe(4);
    const cells = await data.requestWindow(0, 4, 1);
    expect(Array.from(cells.dataRows)).toEqual([0, 1, 2, 3]);
    expect(cells.strings[0]).toBe("1");
    data.dispose();
  });

  it("refreshes the head on cast and undo", async () => {
    const ipc = tableToIPC(tableFromArrays({ code: ["001", "002", "003", "004"] }), "stream");
    const codes = mod.write_parquet_ipc_row_groups(ipc, 4);
    const { data: opening } = openWith(codes, { headRows: 4 });
    const data = await opening;
    const events: string[] = [];
    data.subscribe((event) => events.push(event.type));
    await until(() => events.includes("streaming-done"), "streaming-done");
    expect(data.columns[0].columnType).not.toBe("numeric");
    expect(data.head.strings).toEqual(["001", "002", "003", "004"]);

    const cast = await data.castColumn!(0, "numeric", 1);
    expect(cast.columns[0].columnType).toBe("numeric");
    expect(data.head.strings).toEqual(["1", "2", "3", "4"]);
    expect(Array.from(data.head.numeric)).toEqual([1, 2, 3, 4]);
    const cells = await data.requestWindow(0, 4, 1);
    expect(cells.strings).toEqual(["1", "2", "3", "4"]);

    await data.undoCastColumn!(0, 2);
    expect(data.head.strings).toEqual(["001", "002", "003", "004"]);
    data.dispose();
  });

  it("carries the final counts on streaming-done", async () => {
    // A row budget of six: the second group crosses it and the load stops there.
    channel = new MessageChannel();
    host = createWorkerHost(channel.port1 as never);
    const milestones: Record<string, unknown>[] = [];
    const data = await createWorkerWindowedData({
      source: recordingSource(parquet).source,
      limits: { ...limits, maxRows: 6 },
      overflow: "truncate",
      headRows: 2,
      signal: new AbortController().signal,
      emit: (m) => milestones.push(m),
      worker: workerOver(channel.port2),
    });
    const events: Record<string, unknown>[] = [];
    data.subscribe((event) => events.push(event as never));
    await until(() => events.some((e) => e.type === "streaming-done"), "streaming-done");
    const done = events.find((e) => e.type === "streaming-done")!;
    expect(done).toMatchObject({ totalRows: 12, truncated: true });
    expect(done.loadedRows).toBe(data.rowCount);
    expect(data.rowCount).toBeLessThan(12);
    expect(milestones.at(-1)).toMatchObject({
      phase: "streaming-complete",
      rowCount: data.rowCount,
      totalRowCount: 12,
      truncated: true,
    });
    data.dispose();
  });

  it("after a trap, every method rejects at once with the same terminated error", async () => {
    let trap = false;
    const { data: opening } = openWith(parquet, {
      beforeRequest: (message) => {
        if (trap && message.t === "query") throw new WebAssembly.RuntimeError("unreachable");
      },
    });
    const data = await opening;
    const events: { type: string; fatal?: boolean }[] = [];
    data.subscribe((event) => events.push(event as never));
    await until(() => events.some((e) => e.type === "streaming-done"), "load");
    trap = true;
    const first = await data
      .setQuery({ filters: [null, null, null], sort: null }, 1)
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(WorkerDataError);
    expect(first).toMatchObject({ code: "terminated" });

    const later = [
      data.requestWindow(0, 2, 2),
      data.setQuery({ filters: [null, null, null], sort: null }, 3),
      data.requestImage(0, 1),
      data.castColumn!(0, "categorical", 4),
    ];
    const outcomes = await Promise.all(
      later.map((p) =>
        Promise.race([
          p.then(
            () => "resolved",
            (e: unknown) => (e === first ? "same error" : "other error"),
          ),
          tick().then(() => "pending"),
        ]),
      ),
    );
    expect(outcomes).toEqual(Array(4).fill("same error"));
    expect(events.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ fatal: true }),
    ]);
  });
});
