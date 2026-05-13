export type ExtractedPatch = {
  jsonPatch: Record<string, unknown>;
  bufferPaths: string[][];
  buffers: ArrayBuffer[];
};

type TraversalState = {
  bufferPaths: string[][];
  buffers: ArrayBuffer[];
  stack: WeakSet<object>;
};

export function extractCommBuffers(patch: Record<string, unknown>): ExtractedPatch {
  const state: TraversalState = {
    bufferPaths: [],
    buffers: [],
    stack: new WeakSet(),
  };

  const jsonPatch = visitValue(patch, [], state);

  if (!isPlainObject(jsonPatch)) {
    throw new Error("Comm buffer patch must be a plain object");
  }

  return {
    jsonPatch: jsonPatch as Record<string, unknown>,
    bufferPaths: state.bufferPaths,
    buffers: state.buffers,
  };
}

function visitValue(value: unknown, path: string[], state: TraversalState): unknown {
  if (value === null || isPrimitive(value)) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return extractBuffer(value.slice(0), path, state);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (!(view.buffer instanceof ArrayBuffer)) {
      throw unsupportedValue(path, "SharedArrayBuffer-backed views");
    }
    return extractBuffer(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
      path,
      state,
    );
  }

  if (typeof value === "undefined") {
    throw unsupportedValue(path, "undefined");
  }

  if (typeof value === "function") {
    throw unsupportedValue(path, "function");
  }

  if (typeof value !== "object") {
    throw unsupportedValue(path, typeof value);
  }

  if (state.stack.has(value)) {
    throw new Error(`Cannot extract comm buffers from cyclic value at ${formatPath(path)}`);
  }

  if (Array.isArray(value)) {
    state.stack.add(value);
    const next = value.map((item, index) => visitValue(item, [...path, String(index)], state));
    state.stack.delete(value);
    return next;
  }

  if (!isPlainObject(value)) {
    throw unsupportedValue(path, value.constructor?.name ?? "object");
  }

  state.stack.add(value);
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = visitValue(item, [...path, key], state);
  }
  state.stack.delete(value);
  return next;
}

function extractBuffer(buffer: ArrayBuffer, path: string[], state: TraversalState): null {
  state.bufferPaths.push(path);
  state.buffers.push(buffer);
  return null;
}

function isPrimitive(value: unknown): boolean {
  const valueType = typeof value;
  return (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean" ||
    valueType === "bigint"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unsupportedValue(path: string[], type: string): Error {
  return new Error(
    `Cannot extract comm buffers from unsupported ${type} value at ${formatPath(path)}`,
  );
}

function formatPath(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}
