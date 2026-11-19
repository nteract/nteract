import { fileObject } from "./file-object.mjs";
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

// What a rendered view does with a data change. `listening` has one entry
// per model key the change affects: whether a change:<key> listener is
// registered on that key's model now.
// - "apply": at least one affected key has a listener. Every affected key
//   takes the new value and its listeners fire.
// - "unhandled": no affected key has a listener, so nothing would show the
//   new value. The frame leaves the view as it is and tells the parent, which
//   mounts it again.
// - "unknown": the name affects no key the mount declared.
export function dataDecision(listening) {
  if (!listening.length) return "unknown";
  return listening.some(Boolean) ? "apply" : "unhandled";
}

// The frame's handling of one {type: "data", name, input} message for a
// rendered session. `frameData` is a module view's inputs (createFrameData),
// absent for an anywidget view. Returns the decision. On "unhandled" it
// sends {type: "unhandled-data", name} and changes nothing, so the view and
// its current input stay as they are until the parent mounts it again.
export function receiveDataChange({ name, input }, { session, frameData, send }) {
  if (typeof name !== "string" || (frameData && !DATA_NAME.test(name))) return "unknown";
  const decision = session.dataDecision(frameData ? dataAlias(name) : name);
  if (decision === "unhandled") send({ type: "unhandled-data", name });
  if (decision !== "apply") return decision;
  if (frameData) {
    const next = frameData.replace(name, input);
    if (!next) return "unknown";
    session.setValue(dataAlias(name), next);
  } else if (input?.bytes instanceof Uint8Array) session.setBuffer(name, input.bytes);
  else throw Error("Invalid data input.");
  return decision;
}

// The frame's data inputs for one mount, by the names the mount declared:
// one file object (file-object.mjs) per name, which the model and the
// data/ import both start with. Each name holds one file at a time under its
// own lifetime within the mount's: replacing a name ends the previous file
// object's lifetime, so its pending and later calls reject as aborted and
// its port closes.
export function createFrameData(descriptors, lifetime) {
  const names = Object.keys(descriptors);
  if (names.length > MAX_DATA_NAMES || names.some((name) => !DATA_NAME.test(name)))
    throw Error("A module view may bind up to 16 data/ file imports.");
  const lifetimes = new Map();
  const open = (name, descriptor) => {
    const own = new AbortController();
    const file = fileObject(dataAlias(name), descriptor, AbortSignal.any([lifetime, own.signal]));
    lifetimes.get(name)?.abort();
    lifetimes.set(name, own);
    return file;
  };
  return {
    initial: Object.fromEntries(names.map((name) => [name, open(name, descriptors[name])])),
    // The new file object for a declared name, or undefined for any other name.
    replace(name, descriptor) {
      if (lifetime.aborted || !lifetimes.has(name)) return undefined;
      return open(name, descriptor);
    },
  };
}
