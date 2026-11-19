// What a module view gets for each bound file, from `model.get(alias)` and
// from `import f from "data/<alias>"`. Its members are Observable
// FileAttachment's where they overlap, and Blob's for slice:
// - name (the data alias), mimeType, size: known at mount, nothing fetched;
// - arrayBuffer(), text(), json(): the whole file, read once per file object
//   and shared by all three. arrayBuffer() gives a fresh copy on each call,
//   so a view that writes to one cannot change what text() or json() read;
// - parquet(): the file as a table (table.mjs), decoded by the parent. It
//   takes no options yet, and one passed is refused rather than ignored;
// - slice(start, end): a range object {size, arrayBuffer(), text()} over
//   that span, clamped as Blob.slice clamps, read with one range request on
//   first use.
// byteLength and read(offset, length, signal) make the file a Sift byte
// source, so a view can pass it to Sift's loadTableFile.
// text(), json() and parquet() return the same promise on each call while it
// is pending and after it resolves; after a rejection, the next call asks
// again.
// Nothing reaches the parent until a member is called. Once `lifetime`
// ends, when the name gets a new file, every pending and later call rejects
// as aborted.
import { receiveFile } from "./byte-source.mjs";
import { columnTable } from "./table.mjs";

const MAX_MEDIA_TYPE = 255;

/** Whether `descriptor` is a bound file as the parent describes it:
 * {mimeType, size, port}. */
export function isFileDescriptor(descriptor) {
  return (
    typeof descriptor?.mimeType === "string" &&
    descriptor.mimeType.length <= MAX_MEDIA_TYPE &&
    Number.isSafeInteger(descriptor.size) &&
    descriptor.size >= 0 &&
    typeof descriptor.port?.postMessage === "function"
  );
}

// Blob.slice's clamping: an integer offset, counted from the end when
// negative, kept within [0, size].
const clamp = (value, fallback, size) => {
  if (value === undefined) return fallback;
  const offset = Math.trunc(Number(value)) || 0;
  return offset < 0 ? Math.max(size + offset, 0) : Math.min(offset, size);
};

const copy = (bytes) => bytes.slice().buffer;
const decode = (bytes) => new TextDecoder().decode(bytes);

/** The file object for alias `name` over `descriptor`, alive until
 * `lifetime` ends. Throws for a descriptor isFileDescriptor refuses, and
 * closes any port it carries. */
export function fileObject(name, descriptor, lifetime) {
  if (!isFileDescriptor(descriptor)) {
    descriptor?.port?.close?.();
    throw Error("Invalid data input.");
  }
  const { mimeType, size } = descriptor;
  const port = receiveFile(descriptor, lifetime);
  // Each member keeps the promise `start` gives while it is pending and once
  // it resolves; a rejected one is dropped, so the next call asks again.
  // Once the file object ends, every call rejects as aborted.
  const live = (start) => {
    let promise;
    return () => {
      if (lifetime.aborted) return Promise.reject(lifetime.reason);
      if (!promise) {
        const started = start();
        promise = started;
        started.catch(() => {
          if (promise === started) promise = undefined;
        });
      }
      return promise;
    };
  };
  const whole = live(() => port.request({ kind: "bytes" }));
  const text = live(() => whole().then(decode));
  const json = live(() => text().then((value) => JSON.parse(value)));
  const table = live(() => port.request({ kind: "columns" }).then(columnTable));
  const range = (start, end) => {
    const from = clamp(start, 0, size);
    const length = Math.max(clamp(end, size, size) - from, 0);
    const bytes = live(() =>
      length
        ? port.request({ kind: "range", offset: from, length })
        : Promise.resolve(new Uint8Array()),
    );
    const rangeText = live(() => bytes().then(decode));
    return Object.freeze({
      size: length,
      arrayBuffer: () => bytes().then(copy),
      text: rangeText,
    });
  };
  return Object.freeze({
    name,
    mimeType,
    size,
    byteLength: size,
    read: (offset, length, signal) => port.request({ kind: "range", offset, length }, signal),
    arrayBuffer: () => whole().then(copy),
    text,
    json,
    parquet(...options) {
      if (options.length)
        return Promise.reject(Error("parquet() takes no options yet; call it with none."));
      return table();
    },
    slice: range,
  });
}
