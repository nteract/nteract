/**
 * Main-thread side of the worker protocol: a `WindowedTableData` whose methods
 * post to the worker and resolve on its replies. The engine does not know the
 * difference between this and the in-process adapter.
 *
 * Generations pass straight through; the engine already drops stale answers.
 * The client does reject every pending promise when the worker dies or is
 * closed, so no request waits forever.
 */

import type { TableLimitOverflow } from "../file-data";
import type { ByteSource, ParquetFileLimits } from "../parquet-file";
import { getWasmFallbackUrl, getWasmUrl } from "../predicate";
import type { SiftLoadMilestone } from "../react";
import type { Column } from "../table";
import type { DataEvent, QueryResult, WindowCells, WindowedTableData } from "../windowed";
import { getWorkerFactory } from "./factory";
import { type FromWorker, PROTOCOL_VERSION, type ToWorker } from "./protocol";

/** The subset of `Worker` the client uses; tests substitute a `MessagePort`-backed stub. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  terminate(): void;
};

export type WorkerWindowedDataOptions = {
  source: ByteSource;
  limits: ParquetFileLimits;
  overflow?: TableLimitOverflow;
  columnOverrides?: Record<string, Partial<Column>>;
  /** Rows in `head`. Default 100. */
  headRows?: number;
  /** Live WASM heap bytes allowed in the worker; default `limits.maxDecodedBytes * 2`. */
  allocationCap?: number;
  signal: AbortSignal;
  /** Load milestones, in the same vocabulary as the main-thread loaders. */
  emit?: (milestone: Omit<SiftLoadMilestone, "elapsedMs" | "source">) => void;
  /** Spawn override; defaults to the registered factory. */
  worker?: WorkerLike;
};

export type WorkerWindowedData = WindowedTableData & {
  /** Kill the worker now. `dispose()` asks it to close first. */
  terminate(): void;
  readonly rowGroupCount: number;
};

const CLOSE_TIMEOUT_MS = 1000;
const DEFAULT_HEAD_ROWS = 100;

/**
 * Why a worker-backed data side stopped answering:
 *
 * - `factory`: the registered factory is missing or threw while spawning.
 * - `open`: the worker refused the file before the first row group mounted.
 * - `aborted`: the caller's signal aborted before the open finished.
 * - `terminated`: the worker died (a WASM trap, a crash) or was killed.
 * - `closed`: `dispose()` was called.
 *
 * Every request after the stop rejects with the same instance.
 */
export type WorkerDataErrorCode = "factory" | "open" | "aborted" | "terminated" | "closed";

export class WorkerDataError extends Error {
  readonly code: WorkerDataErrorCode;
  /** The underlying error, when there is one. Set by hand: `ErrorOptions`
   *  and the two-argument `Error` constructor are ES2022 lib types, and
   *  consumers type-check this file under older `lib` settings. */
  readonly cause?: unknown;
  constructor(code: WorkerDataErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "WorkerDataError";
    this.code = code;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

type Pending = { resolve: (value: never) => void; reject: (error: Error) => void };

/**
 * Spawn the data worker, open `source` in it, and resolve with a
 * `WindowedTableData` once the first row group is loaded. Rejects with a
 * `WorkerDataError` when no factory is registered or it throws, when the open
 * fails, or when `signal` aborts first; the worker is terminated in each case.
 */
export function createWorkerWindowedData(
  opts: WorkerWindowedDataOptions,
): Promise<WorkerWindowedData> {
  const spawn = opts.worker ? () => opts.worker! : getWorkerFactory();
  if (!spawn) {
    return Promise.reject(
      new WorkerDataError(
        "factory",
        "Sift worker: no factory registered. Call setWorkerFactory(() => new Worker(...)).",
      ),
    );
  }
  let worker: WorkerLike;
  try {
    worker = spawn();
  } catch (cause) {
    // A CSP or sandbox refusal (`SecurityError`) surfaces here, synchronously.
    // It is a `DOMException`, which is not an `Error` in every realm.
    const described = (cause as { message?: unknown } | null)?.message;
    const message = typeof described === "string" ? described : String(cause);
    return Promise.reject(
      new WorkerDataError("factory", `Worker factory threw: ${message}`, { cause }),
    );
  }
  const emit = opts.emit ?? (() => {});
  const listeners = new Set<(event: DataEvent) => void>();
  const pending = new Map<number, Pending>();
  const castColumns = new Set<number>();
  let nextId = 1;
  /** Set once, when the data side stops answering; every later request rejects with it. */
  let stopped: WorkerDataError | null = null;
  /** `worker.terminate()` has run. */
  let killed = false;
  let closing: ReturnType<typeof setTimeout> | null = null;
  let opened: ((reply: Extract<FromWorker, { t: "opened" }>) => void) | null = null;
  let openFailed: ((error: Error) => void) | null = null;
  let rowGroupCount = 0;
  let lastTotalRows = 0;

  function post(message: ToWorker, transfer?: Transferable[]) {
    if (killed) return;
    if (transfer) worker.postMessage(message, transfer);
    else worker.postMessage(message);
  }

  function request<T>(build: (id: number) => ToWorker): Promise<T> {
    if (stopped) return Promise.reject(stopped);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as Pending["resolve"], reject });
      post(build(id));
    });
  }

  function settle(id: number, value: unknown) {
    const entry = pending.get(id);
    pending.delete(id);
    entry?.resolve(value as never);
  }

  function rejectAll(error: Error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function emitEvent(event: DataEvent) {
    for (const listener of listeners) listener(event);
  }

  /** Record why the data side stopped (first reason wins) and fail every wait. */
  function stop(error: WorkerDataError) {
    stopped ??= error;
    rejectAll(stopped);
    const reject = openFailed;
    openFailed = null;
    opened = null;
    reject?.(stopped);
  }

  /** `worker.terminate()`, exactly once. */
  function kill() {
    if (closing) clearTimeout(closing);
    closing = null;
    if (killed) return;
    killed = true;
    worker.terminate();
  }

  /** Ask the worker to close, and kill it on the ack or after the grace period. */
  function close(error: WorkerDataError) {
    stop(error);
    if (killed || closing) return;
    post({ t: "close" });
    closing = setTimeout(kill, CLOSE_TIMEOUT_MS);
  }

  function terminate() {
    stop(new WorkerDataError("terminated", "Sift worker terminated"));
    kill();
  }

  /** The instance is unusable: tell subscribers once, fail every wait, and kill it. */
  function fatal(message: string) {
    if (stopped) return;
    // Recorded first, so a listener that calls back into the data side is refused.
    const error = new WorkerDataError("terminated", `Sift worker terminated: ${message}`);
    stopped = error;
    emitEvent({ type: "error", message, fatal: true });
    stop(error);
    kill();
  }

  function serveRead(id: number, offset: number, length: number) {
    opts.source.read(offset, length, opts.signal).then(
      (bytes) => {
        if (stopped) return;
        // A `ByteSource` may hand out views into a buffer it keeps (for
        // example `byteSourceFromBytes`), so the relay copies, then transfers
        // the copy. Zero-copy needs an ownership flag on the source contract.
        const owned = new Uint8Array(bytes);
        post({ t: "read-result", id, bytes: owned }, [owned.buffer]);
      },
      (error: unknown) => {
        if (stopped) return;
        post({
          t: "read-error",
          id,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  const data: WorkerWindowedData = {
    kind: "windowed",
    columns: [],
    rowCount: 0,
    head: {
      viewStart: 0,
      dataRows: new Uint32Array(0),
      strings: [],
      nulls: new Uint8Array(0),
      numeric: new Float64Array(0),
    },
    get rowGroupCount() {
      return rowGroupCount;
    },
    requestWindow(viewStart, viewEnd, gen) {
      return request<WindowCells>((id) => ({ t: "window", id, gen, viewStart, viewEnd }));
    },
    setQuery(query, gen) {
      return request<QueryResult>((id) => ({ t: "query", id, gen, query }));
    },
    requestImage(dataRow, col) {
      return request<Uint8Array[] | null>((id) => ({ t: "image", id, dataRow, col }));
    },
    async castColumn(col, to, gen) {
      const result = await request<QueryResult & { columns: Column[] }>((id) => ({
        t: "cast",
        id,
        gen,
        col,
        to,
      }));
      castColumns.add(col);
      data.columns = result.columns;
      return result;
    },
    async undoCastColumn(col, gen) {
      const result = await request<QueryResult & { columns: Column[] }>((id) => ({
        t: "undo-cast",
        id,
        gen,
        col,
      }));
      castColumns.delete(col);
      data.columns = result.columns;
      return result;
    },
    isColumnCast: (col) => castColumns.has(col),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      close(new WorkerDataError("closed", "Sift worker is closed"));
    },
    terminate,
  };

  const onMessage = (event: Event) => {
    const message = (event as MessageEvent).data as FromWorker;
    if (!message || typeof message !== "object" || killed) return;
    // Once stopped, only the close ack matters; every wait has been rejected.
    if (stopped && message.t !== "closed") return;
    switch (message.t) {
      case "opened": {
        data.columns = message.columns;
        data.rowCount = message.rowCount;
        data.coverage = message.coverage;
        data.datasetStats = message.datasetStats;
        data.head = message.head;
        rowGroupCount = message.rowGroupCount;
        emit({ phase: "wasm-ready", format: "parquet" });
        emit({
          phase: "table-data-created",
          format: "parquet",
          rowCount: message.rowCount,
          chunkCount: message.rowGroupCount,
        });
        const resolve = opened;
        opened = null;
        openFailed = null;
        resolve?.(message);
        return;
      }
      case "window":
        settle(message.id, message.cells);
        return;
      case "query":
        settle(message.id, message.result);
        return;
      case "image":
        settle(message.id, message.chunks);
        return;
      case "cast":
        // The engine reads `head` when the cast's query commits; the cells it
        // held for `[0, headRows)` carry the old type's strings.
        data.head = message.head;
        settle(message.id, message.result);
        return;
      case "read":
        serveRead(message.id, message.offset, message.length);
        return;
      case "event":
        if (message.event.type === "rows-appended") data.rowCount = message.event.rowCount;
        if (message.event.type === "schema-changed") {
          data.columns = message.event.columns;
          if (message.head) data.head = message.head;
        }
        if (message.event.type === "streaming-done") {
          const done = message.event;
          if (done.loadedRows !== undefined) data.rowCount = done.loadedRows;
          if (done.totalRows !== undefined) lastTotalRows = done.totalRows;
          const truncated = done.truncated ?? data.coverage?.truncated ?? false;
          if (data.coverage) {
            data.coverage = { ...data.coverage, loadedRows: data.rowCount, truncated };
          }
          emit({
            phase: "streaming-complete",
            format: "parquet",
            rowCount: data.rowCount,
            totalRowCount: lastTotalRows || data.rowCount,
            truncated,
            resumable: false,
          });
        }
        emitEvent(message.event);
        return;
      case "progress":
        lastTotalRows = message.totalRows;
        data.rowCount = message.loadedRows;
        if (data.coverage) {
          data.coverage = {
            ...data.coverage,
            loadedRows: message.loadedRows,
            truncated: message.truncated,
          };
        }
        if (message.phase === "chunk" && message.rowGroup > 0) {
          emit({
            phase: "chunk-appended",
            format: "parquet",
            chunkIndex: message.rowGroup,
            chunkCount: message.rowGroupCount,
            rowCount: message.loadedRows,
          });
        }
        return;
      case "error": {
        if (message.fatal) {
          fatal(message.message);
          return;
        }
        if (message.id === openId && openFailed) {
          // Nothing mounted: close the worker rather than leave it idle.
          close(new WorkerDataError("open", message.message));
          return;
        }
        const entry = message.id === null ? undefined : pending.get(message.id);
        if (entry) {
          pending.delete(message.id!);
          entry.reject(new Error(message.message));
        } else {
          // No request is waiting on it (a load failure after `opened`): the
          // subscribers are the only ones who can show it.
          emitEvent({ type: "error", message: message.message, fatal: false });
        }
        return;
      }
      case "closed":
        kill();
        return;
    }
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", (event) => {
    fatal((event as ErrorEvent).message || "Sift worker crashed");
  });
  worker.addEventListener("messageerror", () => fatal("Sift worker sent an unreadable message"));

  const openId = nextId++;
  return new Promise<WorkerWindowedData>((resolve, reject) => {
    opened = () => resolve(data);
    openFailed = reject;
    const abort = () => {
      stop(new WorkerDataError("aborted", "Sift worker open aborted"));
      kill();
    };
    if (opts.signal.aborted) {
      abort();
      return;
    }
    opts.signal.addEventListener(
      "abort",
      () => {
        // After `opened` the caller owns the data and disposes it.
        if (!stopped && openFailed) abort();
      },
      { once: true },
    );
    post({
      t: "open",
      id: openId,
      protocol: PROTOCOL_VERSION,
      source: { kind: "byte-source-relay", byteLength: opts.source.byteLength },
      limits: opts.limits,
      overflow: opts.overflow,
      columnOverrides: opts.columnOverrides,
      headRows: opts.headRows ?? DEFAULT_HEAD_ROWS,
      wasmUrl: getWasmUrl(),
      wasmFallbackUrl: getWasmFallbackUrl(),
      allocationCap: opts.allocationCap,
    });
  });
}
