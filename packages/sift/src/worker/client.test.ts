/**
 * Client lifecycle against a scripted worker: spawn failures, failed opens,
 * aborts, and the dead-worker contract. No WASM; `host.test.ts` covers the
 * real data side.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DataEvent } from "../windowed";
import { createWorkerWindowedData, WorkerDataError, type WorkerLike } from "./client";
import { setWorkerFactory } from "./factory";
import type { FromWorker, ToWorker } from "./protocol";

const limits = { maxRows: 1000, maxColumns: 16, maxDecodedBytes: 1024 * 1024 };
const source = { byteLength: 1024, read: async () => new Uint8Array(8) };

const head = {
  viewStart: 0,
  dataRows: new Uint32Array(0),
  strings: [],
  nulls: new Uint8Array(0),
  numeric: new Float64Array(0),
};

/**
 * A worker whose replies the test scripts: `onPost` sees every message the
 * client sends and may answer through `reply`. Replies are delivered
 * synchronously so the tests control ordering.
 */
function scriptedWorker(
  onPost: (message: ToWorker, reply: (message: FromWorker) => void) => void = () => {},
) {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const posted: ToWorker[] = [];
  const terminate = vi.fn();
  const dispatch = (type: string, event: Event) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const reply = (message: FromWorker) => dispatch("message", { data: message } as never);
  const worker: WorkerLike = {
    postMessage(message: unknown) {
      posted.push(message as ToWorker);
      onPost(message as ToWorker, reply);
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    terminate,
  };
  return {
    worker,
    posted,
    terminate,
    reply,
    crash: (message: string) => dispatch("error", { message } as never),
    dispatchError: (detail: { message: string; filename?: string }) =>
      dispatch("error", detail as never),
  };
}

/** Answers `open` with an empty table and `close` with the ack. */
function openingWorker() {
  return scriptedWorker((message, reply) => {
    if (message.t === "open") {
      reply({ t: "opened", id: message.id, columns: [], rowCount: 0, head, rowGroupCount: 1 });
    }
    if (message.t === "close") reply({ t: "closed" });
  });
}

function open(worker: WorkerLike, signal = new AbortController().signal) {
  return createWorkerWindowedData({ source, limits, signal, worker });
}

/** Settles within a macrotask, or reports "pending". */
function settledSoon(promise: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
}

describe("createWorkerWindowedData lifecycle", () => {
  afterEach(() => {
    setWorkerFactory(null);
    vi.useRealTimers();
  });

  it("turns a factory that throws into a rejected open", async () => {
    setWorkerFactory(() => {
      throw new DOMException("Refused to create a worker", "SecurityError");
    });
    const error = await createWorkerWindowedData({
      source,
      limits,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerDataError);
    expect(error).toMatchObject({
      code: "factory",
      message: "Worker factory threw: Refused to create a worker",
    });
  });

  it("closes and terminates the worker after each failed open", async () => {
    const workers = [0, 1, 2].map(() =>
      scriptedWorker((message, reply) => {
        if (message.t === "open") {
          reply({ t: "error", id: message.id, message: "Not a Parquet file", fatal: false });
        }
        if (message.t === "close") reply({ t: "closed" });
      }),
    );
    for (const scripted of workers) {
      const error = await open(scripted.worker).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "open", message: "Not a Parquet file" });
      expect(scripted.posted.map((m) => m.t)).toEqual(["open", "close"]);
    }
    expect(workers.map((w) => w.terminate.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("terminates a failed open after the grace period when the worker never acks", async () => {
    vi.useFakeTimers();
    const scripted = scriptedWorker((message, reply) => {
      if (message.t === "open") {
        reply({ t: "error", id: message.id, message: "relay failed", fatal: false });
      }
    });
    await expect(open(scripted.worker)).rejects.toMatchObject({ code: "open" });
    expect(scripted.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(scripted.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates when the signal aborts during the open", async () => {
    const controller = new AbortController();
    const scripted = scriptedWorker();
    const opening = open(scripted.worker, controller.signal);
    controller.abort();
    await expect(opening).rejects.toMatchObject({ code: "aborted" });
    expect(scripted.terminate).toHaveBeenCalledTimes(1);
    // A late reply to the dead open changes nothing.
    scripted.reply({ t: "opened", id: 1, columns: [], rowCount: 0, head, rowGroupCount: 1 });
    expect(scripted.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not spawn work for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const scripted = scriptedWorker();
    await expect(open(scripted.worker, controller.signal)).rejects.toMatchObject({
      code: "aborted",
    });
    expect(scripted.posted).toEqual([]);
    expect(scripted.terminate).toHaveBeenCalledTimes(1);
  });

  it("a successful open and dispose terminates exactly once", async () => {
    const scripted = openingWorker();
    const data = await open(scripted.worker);
    data.dispose();
    data.dispose();
    expect(scripted.terminate).toHaveBeenCalledTimes(1);
    await expect(data.requestWindow(0, 1, 1)).rejects.toMatchObject({ code: "closed" });
  });

  it("after a fatal error every method rejects at once with the same terminated error", async () => {
    const scripted = openingWorker();
    const data = await open(scripted.worker);
    const events: DataEvent[] = [];
    data.subscribe((event) => events.push(event));
    const inFlight = data.requestWindow(0, 10, 1);

    scripted.reply({ t: "error", id: null, message: "unreachable executed", fatal: true });
    // A crash report and a second fatal reply after the first change nothing.
    scripted.reply({ t: "error", id: null, message: "again", fatal: true });
    scripted.crash("worker crashed");

    const first = await inFlight.catch((e: unknown) => e);
    expect(first).toBeInstanceOf(WorkerDataError);
    expect(first).toMatchObject({
      code: "terminated",
      message: "Sift worker terminated: unreachable executed",
    });
    expect(events).toEqual([{ type: "error", message: "unreachable executed", fatal: true }]);
    expect(scripted.terminate).toHaveBeenCalledTimes(1);

    const later: Promise<unknown>[] = [
      data.requestWindow(0, 1, 2),
      data.setQuery({ filters: [], sort: null }, 3),
      data.requestImage(0, 0),
      data.castColumn!(0, "numeric", 4),
      data.undoCastColumn!(0, 5),
    ];
    expect(await Promise.all(later.map(settledSoon))).toEqual(Array(5).fill("rejected"));
    for (const promise of later) await expect(promise).rejects.toBe(first);
    // Nothing reached the dead worker after the fatal reply.
    expect(scripted.posted.map((m) => m.t)).toEqual(["open", "window"]);
  });

  it("reports a worker that errors before any reply as a failed start, not a crash", async () => {
    // A CSP-blocked worker URL: `new Worker` returns, then `error` fires.
    for (const [detail, expected] of [
      [{ message: "" }, "error event before any reply"],
      [{ message: "", filename: "blob:harness://app/1234" }, "blob:harness://app/1234"],
      [{ message: "Refused to load" }, "Refused to load"],
    ] as const) {
      const scripted = scriptedWorker((message) => {
        if (message.t === "open") scripted.dispatchError(detail);
      });
      const error = await open(scripted.worker).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorkerDataError);
      expect(error).toMatchObject({
        code: "open",
        message: `Sift worker failed to start; the host's Content-Security-Policy may block this worker URL (${expected})`,
      });
      expect(scripted.terminate).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the crash message for a worker that dies after it has answered", async () => {
    const scripted = openingWorker();
    const data = await open(scripted.worker);
    const events: DataEvent[] = [];
    data.subscribe((event) => events.push(event));
    const inFlight = data.requestWindow(0, 1, 1);
    scripted.dispatchError({ message: "" });
    await expect(inFlight).rejects.toMatchObject({
      code: "terminated",
      message: "Sift worker terminated: Sift worker crashed",
    });
    expect(events).toEqual([{ type: "error", message: "Sift worker crashed", fatal: true }]);
  });

  it("posts resume and maps pause and resume events to milestones and coverage", async () => {
    const coverage = { loadedRows: 2, truncated: false };
    const scripted = scriptedWorker((message, reply) => {
      if (message.t === "open") {
        reply({
          t: "opened",
          id: message.id,
          columns: [],
          rowCount: 2,
          coverage,
          head,
          rowGroupCount: 3,
        });
      }
      if (message.t === "close") reply({ t: "closed" });
    });
    const milestones: Record<string, unknown>[] = [];
    const data = await createWorkerWindowedData({
      source,
      limits,
      overflow: "truncate",
      autoLoad: { rows: 2, decodedBytes: 1024 },
      signal: new AbortController().signal,
      emit: (m) => milestones.push(m),
      worker: scripted.worker,
    });
    expect(scripted.posted[0]).toMatchObject({
      t: "open",
      autoLoad: { rows: 2, decodedBytes: 1024 },
    });
    const events: DataEvent[] = [];
    data.subscribe((event) => events.push(event));

    scripted.reply({
      t: "event",
      event: {
        type: "streaming-done",
        loadedRows: 2,
        totalRows: 6,
        truncated: true,
        resumable: true,
      },
    });
    expect(data.coverage).toMatchObject({ loadedRows: 2, truncated: true, resumable: true });
    expect(milestones.at(-1)).toEqual({
      phase: "streaming-complete",
      format: "parquet",
      rowCount: 2,
      totalRowCount: 6,
      truncated: true,
      resumable: true,
    });

    data.resume();
    expect(scripted.posted.at(-1)).toEqual({ t: "resume" });
    scripted.reply({ t: "event", event: { type: "streaming-resumed", rowCount: 2 } });
    expect(data.coverage).toMatchObject({ truncated: false, resumable: false });
    expect(milestones.at(-1)).toEqual({
      phase: "streaming-resumed",
      format: "parquet",
      rowCount: 2,
    });
    expect(events.map((e) => e.type)).toEqual(["streaming-done", "streaming-resumed"]);

    // Disposing while paused closes without waiting for a resume.
    scripted.reply({
      t: "event",
      event: {
        type: "streaming-done",
        loadedRows: 4,
        totalRows: 6,
        truncated: true,
        resumable: true,
      },
    });
    data.dispose();
    expect(scripted.terminate).toHaveBeenCalledTimes(1);
    const posts = scripted.posted.length;
    data.resume();
    expect(scripted.posted).toHaveLength(posts);
  });

  it("fans a non-fatal error nobody is waiting on out to subscribers", async () => {
    const scripted = openingWorker();
    const data = await open(scripted.worker);
    const events: DataEvent[] = [];
    data.subscribe((event) => events.push(event));
    scripted.reply({
      t: "event",
      event: { type: "error", message: "network down", fatal: false },
    });
    // A late error for the settled open request is not dropped either.
    scripted.reply({ t: "error", id: 1, message: "late", fatal: false });
    expect(events).toEqual([
      { type: "error", message: "network down", fatal: false },
      { type: "error", message: "late", fatal: false },
    ]);
    expect(scripted.terminate).not.toHaveBeenCalled();
    data.dispose();
  });
});
