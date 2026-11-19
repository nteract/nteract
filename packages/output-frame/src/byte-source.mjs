import { checkColumnSet, copyColumnSet } from "./column-set.mjs";
import { createReadBudget } from "./read-budget.mjs";
import { createWholeFiles } from "./whole-file-total.mjs";

// One port per bound file. The frame asks it for one thing per request, on a
// dedicated reply port, and nothing crosses until it asks:
// - {kind: "range", offset, length}: that span of the file, as {bytes};
// - {kind: "bytes"}: the whole file, as {bytes}, at most WHOLE_FILE_LIMIT;
// - {kind: "columns", format}: the file read as a table in `format`, one of
//   TABLE_FORMATS, as the ColumnSet {columns}, its typed arrays transferred.
// Any other reply is {error}. Any message on a reply port cancels that
// request; cancelling it cannot cancel another. Every request of every kind
// counts as one read in the view's one read budget (read-budget.mjs): a read
// past it waits its turn, and only a read that finds the waiting list full
// is refused. Without a budget, the file gets one of its own.
// "bytes" and "columns" are whole reads. "bytes", and "columns" in each
// format, runs at most once at a time and is delivered at most once per
// exposed file (whole-file-total.mjs).
export const REQUEST_KINDS = Object.freeze(["range", "bytes", "columns"]);
// The formats a "columns" request may name.
export const TABLE_FORMATS = Object.freeze(["parquet", "csv"]);
const NOT_A_TABLE = Object.freeze({
  parquet: "This file is not Parquet.",
  csv: "This file is not CSV.",
});

// The whole-read share a request holds: "bytes", a table format, or null
// for a range.
const shareOf = (request) =>
  request.kind === "columns" ? request.format : request.kind === "bytes" ? "bytes" : null;
// The largest file a whole-file request reads.
export const WHOLE_FILE_LIMIT = 5 * 1024 * 1024;

const validRange = ({ offset, length }, size) =>
  Number.isSafeInteger(offset) &&
  offset >= 0 &&
  Number.isSafeInteger(length) &&
  length >= 0 &&
  length <= size - offset;

// Why the parent refuses `request` before it reaches the budget, or null.
// A whole read that is not refused holds its share until it ends.
function refusal(request, file, shares) {
  if (!request || typeof request !== "object" || !REQUEST_KINDS.includes(request.kind))
    return "Invalid file request.";
  if (request.kind === "range")
    return validRange(request, file.byteLength) ? null : "Invalid file read.";
  if (request.kind === "columns") {
    if (!TABLE_FORMATS.includes(request.format)) return "Invalid file request.";
    return typeof file.columns === "function"
      ? shares.reserve(request.format)
      : NOT_A_TABLE[request.format];
  }
  if (file.byteLength > WHOLE_FILE_LIMIT)
    return `This file is larger than ${WHOLE_FILE_LIMIT / (1024 * 1024)} MiB; read it in ranges with slice(start, end).`;
  return shares.reserve("bytes");
}

// The answer to one admitted request, and the buffers to transfer with it.
async function answer(request, file, signal) {
  if (request.kind === "range") {
    const bytes = await file.read(request.offset, request.length, signal);
    signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== request.length)
      throw Error("Incomplete file read.");
    // Only transfer the requested span, including for non-dedicated buffers.
    const own = new Uint8Array(bytes);
    return [{ bytes: own }, [own.buffer]];
  }
  if (request.kind === "bytes") {
    const bytes = await file.bytes(signal);
    signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.byteLength)
      throw Error("Incomplete file read.");
    const own = new Uint8Array(bytes);
    return [{ bytes: own }, [own.buffer]];
  }
  // The embedder checks a ColumnSet once, when it decodes it, and the frame
  // checks what it receives; copying it reads only its typed arrays.
  const columns = await file.columns(request.format, signal);
  signal.throwIfAborted();
  const [copy, transfer] = copyColumnSet(columns);
  return [{ columns: copy }, transfer];
}

/** Serve `file` ({mimeType, byteLength, read, bytes, columns?}) on a new
 * port until `lifetime` ends. `columns(format, signal)` reads the file as a
 * table in that format, or rejects when it cannot; without it, every
 * "columns" request is refused. `shares` holds this file's whole-read shares
 * (createWholeFiles in whole-file-total.mjs): reserve(share) answers null
 * when a whole read may start, or why not; delivered(share) and
 * failed(share) report how it ended. Without them, the file keeps shares of its own.
 * Returns the descriptor the frame receives: {mimeType, size, port}. */
export function exposeFile(
  file,
  lifetime,
  budget = createReadBudget({ lifetime }),
  shares = createWholeFiles(Infinity).file("file", file.byteLength),
) {
  const { port1, port2 } = new MessageChannel();
  lifetime.addEventListener("abort", () => port1.close(), { once: true });
  port1.onmessage = ({ data, ports }) => {
    const [reply] = ports;
    if (!reply) return;
    const refused = refusal(data, file, shares);
    if (refused) {
      reply.postMessage({ error: refused });
      reply.close();
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal]);
    reply.onmessage = () => controller.abort();
    // A whole read's share ends once: delivered, or failed (refused by the
    // budget, cancelled while queued or in flight, or an error).
    const share = shareOf(data);
    let ended = share === null;
    const end = (delivered) => {
      if (ended) return;
      ended = true;
      if (delivered) shares.delivered(share);
      else shares.failed(share);
    };
    const failed = () => end(false);
    let started = false;
    // A request cancelled while it waits gets no reply.
    signal.addEventListener(
      "abort",
      () => {
        if (started) return;
        failed();
        reply.close();
      },
      { once: true },
    );
    const admitted = budget.schedule(signal, async (settle) => {
      started = true;
      try {
        const [message, transfer] = await answer(data, file, signal);
        end(true);
        reply.postMessage(message, transfer);
      } catch (error) {
        failed();
        if (!signal.aborted)
          reply.postMessage({ error: String(error?.message ?? error).slice(0, 240) });
      } finally {
        settle();
        reply.close();
      }
    });
    if (!admitted) {
      failed();
      if (!signal.aborted) reply.postMessage({ error: "Too many file reads are waiting." });
      reply.close();
    }
  };
  return { mimeType: file.mimeType, size: file.byteLength, port: port2 };
}

// The value of a reply to `request` on a file of `size` bytes, or why it is
// not one.
function replyValue(request, data, size) {
  if (typeof data?.error === "string") throw Error(data.error.slice(0, 240));
  if (request.kind === "columns") return checkColumnSet(data?.columns);
  const expected = request.kind === "range" ? request.length : size;
  if (!(data?.bytes instanceof Uint8Array) || data.bytes.byteLength !== expected)
    throw Error("Invalid file reply.");
  return data.bytes;
}

/** The frame's end of a file port: `request(message, signal)` sends one
 * request and resolves with its bytes or checked ColumnSet. Requests reject
 * as aborted once `signal` or `lifetime` ends. */
export function receiveFile({ size, port }, lifetime) {
  lifetime.addEventListener("abort", () => port.close(), { once: true });
  return {
    async request(message, signal) {
      const cancel = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
      cancel.throwIfAborted();
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve, reject) => {
        const abort = () => {
          port1.postMessage("cancel");
          port1.close();
          reject(cancel.reason);
        };
        cancel.addEventListener("abort", abort, { once: true });
        port1.onmessage = ({ data }) => {
          cancel.removeEventListener("abort", abort);
          port1.close();
          try {
            resolve(replyValue(message, data, size));
          } catch (error) {
            reject(error);
          }
        };
        port.postMessage(message, [port2]);
      });
    },
  };
}
