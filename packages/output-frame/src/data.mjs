import { receiveByteSource } from "./byte-source.mjs";
import { widgetDefinitions } from "./schema.mjs";

// A module view's data names, as `import x from "data/<alias>"` spells them.
// The alias after "data/" is the key on the view's model.
export const DATA_NAME = /^data\/[a-z][a-z0-9_-]{0,63}$/;
export const MAX_DATA_NAMES = 16;
export const dataAlias = (name) => name.slice(5);

// The buffer bindings of an anywidget spec that can change within a mount.
// A binding that also names a module or stylesheet is code, never data.
export function bufferNames(spec) {
  const definitions = widgetDefinitions(spec).map(([, definition]) => definition);
  const code = new Set(definitions.flatMap(({ _esm, _css }) => [_esm, _css]));
  return [
    ...new Set(definitions.flatMap(({ buffers = [] }) => buffers.filter((n) => !code.has(n)))),
  ];
}

// A whole file held in the frame, read through the same interface as a
// ranged file. Reads after `lifetime` ends reject as aborted.
function bytesByteSource(bytes, lifetime) {
  return Object.freeze({
    byteLength: bytes.byteLength,
    async read(offset, length, signal) {
      (signal ? AbortSignal.any([signal, lifetime]) : lifetime).throwIfAborted();
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        length > bytes.byteLength - offset
      )
        throw Error("Invalid file read.");
      return bytes.slice(offset, offset + length);
    },
  });
}

// One received data input. `{bytes}` is a whole file: the model holds a
// DataView of it. `{byteLength, port}` is a ranged file: the model holds the
// same handle the import gives. Both give the import a {byteLength, read}
// handle that ends with `lifetime`.
export function receiveDataInput(descriptor, lifetime) {
  if (descriptor?.bytes instanceof Uint8Array) {
    const { bytes } = descriptor;
    return {
      handle: bytesByteSource(bytes, lifetime),
      value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }
  if (
    Number.isSafeInteger(descriptor?.byteLength) &&
    descriptor.byteLength >= 0 &&
    typeof descriptor.port?.postMessage === "function"
  ) {
    const handle = receiveByteSource(descriptor, lifetime);
    return { handle, value: handle };
  }
  throw Error("Invalid data input.");
}

// The frame's data inputs for one mount, by the names the mount declared.
// Each name holds one input at a time under its own lifetime within the
// mount's: replacing a name ends the previous input's lifetime, so reads
// through its handle reject as aborted and its port closes.
export function createFrameData(descriptors, lifetime) {
  const names = Object.keys(descriptors);
  if (names.length > MAX_DATA_NAMES || names.some((name) => !DATA_NAME.test(name)))
    throw Error("A module view may bind up to 16 data/ file imports.");
  const lifetimes = new Map();
  const open = (name, descriptor) => {
    const own = new AbortController();
    const input = receiveDataInput(descriptor, AbortSignal.any([lifetime, own.signal]));
    lifetimes.get(name)?.abort();
    lifetimes.set(name, own);
    return input;
  };
  return {
    initial: Object.fromEntries(names.map((name) => [name, open(name, descriptors[name])])),
    // The new input for a declared name, or undefined for any other name.
    replace(name, descriptor) {
      if (lifetime.aborted || !lifetimes.has(name)) return undefined;
      return open(name, descriptor);
    },
  };
}
