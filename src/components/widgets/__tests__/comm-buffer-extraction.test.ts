import { describe, expect, it } from "vitest";

import { extractCommBuffers } from "../comm-buffer-extraction";

function bytes(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

describe("extractCommBuffers", () => {
  it("extracts a top-level DataView leaf", () => {
    const source = new Uint8Array([1, 2, 3, 4]).buffer;
    const view = new DataView(source);

    const result = extractCommBuffers({ selection: view });

    expect(result.jsonPatch).toEqual({ selection: null });
    expect(result.bufferPaths).toEqual([["selection"]]);
    expect(bytes(result.buffers[0])).toEqual([1, 2, 3, 4]);
  });

  it("extracts a nested typed array", () => {
    const array = new Uint32Array([7, 11]);

    const result = extractCommBuffers({ nested: { values: array } });

    expect(result.jsonPatch).toEqual({ nested: { values: null } });
    expect(result.bufferPaths).toEqual([["nested", "values"]]);
    expect(bytes(result.buffers[0])).toEqual(Array.from(new Uint8Array(array.buffer)));
  });

  it("preserves the exact byte range for offset typed arrays", () => {
    const source = new Uint8Array([99, 1, 2, 3, 88]);
    const view = new Uint8Array(source.buffer, 1, 3);

    const result = extractCommBuffers({ values: view });

    expect(result.jsonPatch).toEqual({ values: null });
    expect(result.bufferPaths).toEqual([["values"]]);
    expect(bytes(result.buffers[0])).toEqual([1, 2, 3]);
  });

  it("extracts a jupyter-scatter style view while preserving metadata", () => {
    const source = new Uint8Array([4, 5, 6, 7]).buffer;

    const result = extractCommBuffers({
      selection: {
        view: new DataView(source),
        dtype: "uint32",
        shape: [1],
      },
    });

    expect(result.jsonPatch).toEqual({
      selection: {
        view: null,
        dtype: "uint32",
        shape: [1],
      },
    });
    expect(result.bufferPaths).toEqual([["selection", "view"]]);
    expect(bytes(result.buffers[0])).toEqual([4, 5, 6, 7]);
  });

  it("keeps buffer paths in traversal order", () => {
    const result = extractCommBuffers({
      first: new Uint8Array([1]),
      nested: [new Uint8Array([2]), { third: new Uint8Array([3]) }],
    });

    expect(result.jsonPatch).toEqual({
      first: null,
      nested: [null, { third: null }],
    });
    expect(result.bufferPaths).toEqual([["first"], ["nested", "0"], ["nested", "1", "third"]]);
    expect(result.buffers.map(bytes)).toEqual([[1], [2], [3]]);
  });

  it("does not treat genuine null values as buffers", () => {
    const result = extractCommBuffers({ selection: null });

    expect(result.jsonPatch).toEqual({ selection: null });
    expect(result.bufferPaths).toEqual([]);
    expect(result.buffers).toEqual([]);
  });

  it("throws on cyclic values", () => {
    const patch: Record<string, unknown> = {};
    patch.self = patch;

    expect(() => extractCommBuffers(patch)).toThrow(/cyclic value/);
  });

  it("throws on unsupported non-json objects", () => {
    expect(() => extractCommBuffers({ values: new Map() })).toThrow(/unsupported Map value/);
  });
});
