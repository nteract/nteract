/**
 * The data side of the worker protocol. Runs inside a dedicated worker (see
 * `entry.ts`) or, in tests, on one end of a `MessageChannel`.
 *
 * It owns the WASM module and the Parquet file, wraps the loaded `TableData` in
 * `createResidentWindowedData`, and answers the view's requests over the port.
 * Bytes come from the host through a read relay. A WASM trap (including the
 * allocation cap) is fatal: the host posts one `fatal` error and stops
 * answering; the main thread terminates the worker and keeps the rows it has.
 */

import { type ByteSource, type OpenParquetFile, openParquetFile } from "../parquet-file";
import { ensureModule, getWasmMemory, type PredicateModule, setWasmUrl } from "../predicate";
import type { TableData } from "../table";
import { createResidentWindowedData, type ResidentWindowedData } from "../windowed-resident";
import {
  DEFAULT_ALLOCATION_CAP_FACTOR,
  type FromWorker,
  isFatalWasmError,
  type OpenRequest,
  ownedBytes,
  PROTOCOL_VERSION,
  type ToWorker,
  windowCellsTransfer,
} from "./protocol";

/** What the host needs from `self` or a `MessagePort`. */
export type HostPort = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
  close?(): void;
};

export type WorkerHostOptions = {
  /**
   * Test hook: runs before each request is handled. Throwing a
   * `WebAssembly.RuntimeError` here exercises the fatal path without a real trap.
   */
  beforeRequest?: (message: ToWorker) => void;
};

export type WorkerHost = {
  /** Stop handling messages and release the file and store. */
  dispose(): void;
};

export function createWorkerHost(port: HostPort, options: WorkerHostOptions = {}): WorkerHost {
  let mod: PredicateModule | null = null;
  let file: OpenParquetFile | null = null;
  let adapter: ResidentWindowedData | null = null;
  let unsubscribeAdapter: (() => void) | null = null;
  let allocationCap = 0;
  let closed = false;
  let fatal = false;
  let nextReadId = 1;
  /** Row group being decoded, for the fatal message; -1 between groups. */
  let loadingRowGroup = -1;
  /** Set while the load waits at the `autoLoad` budget; calling it continues. */
  let resumeWaiting: (() => void) | null = null;
  const pendingReads = new Map<
    number,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();

  function post(message: FromWorker, transfer?: Transferable[]) {
    if (closed) return;
    if (transfer && transfer.length > 0) port.postMessage(message, transfer);
    else port.postMessage(message);
  }

  function memoryBytes(): number {
    if (mod?.allocated_bytes) return mod.allocated_bytes();
    return getWasmMemory()?.buffer.byteLength ?? 0;
  }

  function fail(id: number | null, error: unknown) {
    let message = error instanceof Error ? error.message : String(error);
    if (isFatalWasmError(error)) {
      fatal = true;
      if (loadingRowGroup >= 0) {
        // A trap while decoding is the allocation cap or a decoder fault; either
        // way the rows before this group are what the view keeps.
        message = `row group ${loadingRowGroup} exceeded the worker memory limit (${message})`;
      }
      post({ t: "error", id, message, fatal: true });
      releaseAll();
    } else {
      post({ t: "error", id, message, fatal: false });
    }
  }

  function wakePaused() {
    const wake = resumeWaiting;
    resumeWaiting = null;
    wake?.();
  }

  function releaseAll() {
    // A load paused at the soft budget wakes, sees `closed` or `fatal`, and returns.
    wakePaused();
    for (const pending of pendingReads.values()) pending.reject(new Error("Worker closed"));
    pendingReads.clear();
    unsubscribeAdapter?.();
    unsubscribeAdapter = null;
    // `file.close()` releases footer metadata; the adapter owns the store lease.
    try {
      file?.close();
    } catch {
      // Already released by a trap or an earlier close.
    }
    file = null;
    try {
      adapter?.dispose();
    } catch {
      // A trapped instance cannot free; the worker is terminated anyway.
    }
    adapter = null;
  }

  /** The host's `ByteSource`, reached through `read` / `read-result` messages. */
  function relaySource(byteLength: number): ByteSource {
    return {
      byteLength,
      read(offset, length) {
        return new Promise<Uint8Array>((resolve, reject) => {
          if (closed || fatal) {
            reject(new Error("Worker closed"));
            return;
          }
          const id = nextReadId++;
          pendingReads.set(id, { resolve, reject });
          post({ t: "read", id, offset, length });
        });
      },
    };
  }

  /** Point the adapter at a new lease (type refinement replaced the table). */
  function attach(data: ResidentWindowedData) {
    unsubscribeAdapter?.();
    adapter = data;
    unsubscribeAdapter = data.subscribe((event) => {
      // The view's preview notice and `streaming-complete` milestone need the
      // final counts; only the file knows the footer total and the budget.
      if (event.type === "streaming-done" && file) {
        event = {
          ...event,
          loadedRows: file.loadedRows,
          totalRows: file.rowCount,
          truncated: file.truncated,
          resumable: false,
        };
      }
      post({ t: "event", event });
    });
  }

  function swapLease(replaced: TableData, headRows: number) {
    const previous = adapter;
    attach(createResidentWindowedData(replaced, { headRows }));
    previous?.dispose();
    post({
      t: "event",
      event: { type: "schema-changed", columns: replaced.columns },
      head: adapter!.head,
    });
  }

  function progress(phase: "chunk" | "complete", rowGroup: number) {
    if (!file) return;
    post({
      t: "progress",
      phase,
      rowGroup,
      rowGroupCount: file.rowGroupCount,
      loadedRows: file.loadedRows,
      totalRows: file.rowCount,
      truncated: file.truncated,
      memoryBytes: memoryBytes(),
    });
  }

  /**
   * Between row groups: the Rust cap traps inside a batch; this check stops a
   * load whose retained memory already exceeds the cap before the next group.
   */
  function overCap(rowGroup: number) {
    if (allocationCap <= 0) return;
    const used = memoryBytes();
    if (used > allocationCap) {
      throw new WebAssembly.RuntimeError(
        `${used.toLocaleString()} live bytes after row group ${rowGroup} > cap ${allocationCap.toLocaleString()}`,
      );
    }
  }

  async function open(request: OpenRequest) {
    if (request.protocol !== PROTOCOL_VERSION) {
      throw new Error(
        `Sift worker protocol ${request.protocol} does not match ${PROTOCOL_VERSION}`,
      );
    }
    if (request.wasmUrl) setWasmUrl(request.wasmUrl, request.wasmFallbackUrl);
    mod = await ensureModule();
    allocationCap =
      request.allocationCap ?? request.limits.maxDecodedBytes * DEFAULT_ALLOCATION_CAP_FACTOR;
    if (typeof mod.set_allocation_cap === "function") mod.set_allocation_cap(allocationCap);

    const source = relaySource(request.source.byteLength);
    file = await openParquetFile(source, {
      limits: request.limits,
      overflow: request.overflow,
      columnOverrides: request.columnOverrides,
    });
    if (closed) return;
    let exhausted = false;
    if (file.rowGroupCount > 0) {
      loadingRowGroup = 0;
      exhausted = (await file.appendRowGroup(0)).exhausted;
      loadingRowGroup = -1;
    }
    if (closed) return;
    attach(createResidentWindowedData(file.tableData, { headRows: request.headRows }));
    const data = adapter!;
    post({
      t: "opened",
      id: request.id,
      columns: data.columns,
      rowCount: data.rowCount,
      coverage: data.coverage,
      datasetStats: data.datasetStats ? [...data.datasetStats] : undefined,
      head: data.head,
      rowGroupCount: file.rowGroupCount,
    });
    try {
      await stream(file, exhausted, request.headRows, request.autoLoad);
    } catch (error) {
      if (closed || fatal) return;
      // A trap still ends the instance (the caller posts it as fatal).
      if (isFatalWasmError(error)) throw error;
      // Anything else (a failed relay read, a decode error in a later group)
      // stops appending. The open request has already settled, so this is a
      // push: the rows loaded so far stay queryable and no `streaming-done`
      // follows.
      loadingRowGroup = -1;
      post({
        t: "event",
        event: {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          fatal: false,
        },
      });
      try {
        file.close();
      } catch {
        // Already released.
      }
    }
  }

  /**
   * Row groups after the first, then the final refinement. Runs after
   * `opened`. With `autoLoad`, the same pause rule as the main-thread loader
   * (`streamParquetIntoEngine` in `react.tsx`): after an append, when row
   * groups remain and the committed rows or decoded bytes reach the soft
   * budget, post a resumable `streaming-done` and wait for `resume`, which
   * extends the budget by the same amounts.
   */
  async function stream(
    parquet: OpenParquetFile,
    exhausted: boolean,
    headRows: number,
    autoLoad: OpenRequest["autoLoad"],
  ) {
    let softRows = autoLoad?.rows ?? Number.POSITIVE_INFINITY;
    let softBytes = autoLoad?.decodedBytes ?? Number.POSITIVE_INFINITY;

    /** Returns once loading may go on; the caller rechecks `closed` and `fatal`. */
    async function pauseIfOverSoftBudget(nextGroup: number, done: boolean) {
      if (done || nextGroup >= parquet.rowGroupCount) return;
      const { usage } = parquet;
      if (usage.rows < softRows && usage.decodedBytes < softBytes) return;

      parquet.setPaused(true);
      post({
        t: "event",
        event: {
          type: "streaming-done",
          loadedRows: parquet.loadedRows,
          totalRows: parquet.rowCount,
          truncated: true,
          resumable: true,
        },
      });
      await new Promise<void>((resolve) => {
        resumeWaiting = resolve;
      });
      if (closed || fatal) return;

      softRows = usage.rows + (autoLoad?.rows ?? Number.POSITIVE_INFINITY);
      softBytes = usage.decodedBytes + (autoLoad?.decodedBytes ?? Number.POSITIVE_INFINITY);
      parquet.setPaused(false);
      post({ t: "event", event: { type: "streaming-resumed", rowCount: parquet.loadedRows } });
    }

    progress("chunk", 0);
    overCap(0);
    await pauseIfOverSoftBudget(1, exhausted);
    if (closed || fatal) return;

    for (let group = 1; group < parquet.rowGroupCount && !exhausted; group++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (closed || fatal) return;
      loadingRowGroup = group;
      const result = await parquet.appendRowGroup(group);
      if (closed || fatal) return;
      if (result.replaced) swapLease(result.replaced, headRows);
      else adapter!.notifyAppended();
      exhausted = result.exhausted;
      progress("chunk", group);
      overCap(group);
      loadingRowGroup = -1;
      await pauseIfOverSoftBudget(group + 1, exhausted);
      if (closed || fatal) return;
    }
    const { replaced } = parquet.finish();
    if (replaced) swapLease(replaced, headRows);
    adapter!.notifyStreamingDone();
    progress("complete", parquet.rowGroupCount - 1);
    parquet.close();
  }

  async function handle(message: ToWorker) {
    if (closed || fatal) return;
    options.beforeRequest?.(message);
    switch (message.t) {
      case "open":
        await open(message);
        return;
      case "read-result": {
        const pending = pendingReads.get(message.id);
        pendingReads.delete(message.id);
        pending?.resolve(message.bytes);
        return;
      }
      case "read-error": {
        const pending = pendingReads.get(message.id);
        pendingReads.delete(message.id);
        pending?.reject(new Error(message.message));
        return;
      }
      case "resume":
        wakePaused();
        return;
      case "close":
        closed = true;
        releaseAll();
        port.postMessage({ t: "closed" } satisfies FromWorker);
        port.close?.();
        return;
    }
    if (!adapter) throw new Error(`Request "${message.t}" before open`);
    switch (message.t) {
      case "window": {
        const cells = await adapter.requestWindow(message.viewStart, message.viewEnd, message.gen);
        post({ t: "window", id: message.id, cells }, windowCellsTransfer(cells));
        return;
      }
      case "query": {
        const result = await adapter.setQuery(message.query, message.gen);
        post({ t: "query", id: message.id, result });
        return;
      }
      case "image": {
        const raw = await adapter.requestImage(message.dataRow, message.col);
        const chunks = raw ? raw.map(ownedBytes) : null;
        post(
          { t: "image", id: message.id, chunks },
          chunks ? [...new Set(chunks.map((chunk) => chunk.buffer))] : undefined,
        );
        return;
      }
      case "cast": {
        if (!adapter.castColumn) throw new Error("This source cannot cast columns");
        const result = await adapter.castColumn(message.col, message.to, message.gen);
        post({
          t: "cast",
          id: message.id,
          result: { ...result, columns: [...result.columns] },
          head: adapter.head,
        });
        return;
      }
      case "undo-cast": {
        if (!adapter.undoCastColumn) throw new Error("This source cannot undo casts");
        const result = await adapter.undoCastColumn(message.col, message.gen);
        post({
          t: "cast",
          id: message.id,
          result: { ...result, columns: [...result.columns] },
          head: adapter.head,
        });
        return;
      }
    }
  }

  const onMessage = (event: MessageEvent) => {
    const message = event.data as ToWorker;
    if (!message || typeof message !== "object" || typeof message.t !== "string") return;
    handle(message).catch((error: unknown) => {
      if (closed) return;
      fail("id" in message ? message.id : null, error);
    });
  };
  port.addEventListener("message", onMessage);
  port.start?.();

  return {
    dispose() {
      if (closed) return;
      closed = true;
      port.removeEventListener("message", onMessage);
      releaseAll();
    },
  };
}
