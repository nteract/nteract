/**
 * Keyed document frame header parsing, checked against the Rust/WASM codec.
 */

import { describe, expect, it } from "vite-plus/test";
import { MAX_KEYED_DOC_FRAME_HEADER_LEN, parseKeyedDocFrameHeader } from "../src/keyed-doc-frame";
import { FrameType } from "../src/transport";
import { initWasmModule } from "./wasm-harness";

function payload(header: unknown, body: number[] = []): Uint8Array {
  const json = new TextEncoder().encode(
    typeof header === "string" ? header : JSON.stringify(header),
  );
  const bytes = new Uint8Array(4 + json.length + body.length);
  new DataView(bytes.buffer).setUint32(0, json.length, false);
  bytes.set(json, 4);
  bytes.set(body, 4 + json.length);
  return bytes;
}

describe("parseKeyedDocFrameHeader", () => {
  it("reads kind, id and epoch, ignoring field order, extra fields and body", () => {
    expect(
      parseKeyedDocFrameHeader(
        payload({ epoch: 7, extra: true, id: "x/y z", kind: "test_kv" }, [1, 2, 3]),
      ),
    ).toEqual({ kind: "test_kv", id: "x/y z", epoch: 7 });
  });

  it("rejects truncated, oversized, malformed and out-of-range headers", () => {
    expect(parseKeyedDocFrameHeader(new Uint8Array([0, 0, 0]))).toBeNull();
    const truncated = payload({ kind: "k", id: "i", epoch: 1 }).subarray(0, 8);
    expect(parseKeyedDocFrameHeader(truncated)).toBeNull();
    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, MAX_KEYED_DOC_FRAME_HEADER_LEN + 1, false);
    expect(parseKeyedDocFrameHeader(oversized)).toBeNull();
    for (const header of [
      "not json",
      '["test_kv", "d1", 1]',
      { kind: "test_kv", id: "d1" },
      { kind: "Test-KV", id: "d1", epoch: 1 },
      { kind: "k".repeat(65), id: "d1", epoch: 1 },
      { kind: "test_kv", id: "", epoch: 1 },
      { kind: "test_kv", id: "é".repeat(257), epoch: 1 },
      { kind: "test_kv", id: "d1", epoch: -1 },
      { kind: "test_kv", id: "d1", epoch: "1" },
    ]) {
      expect(parseKeyedDocFrameHeader(payload(header)), JSON.stringify(header)).toBeNull();
    }
  });

  it("agrees with the WASM encoder and header reader", async () => {
    const wasm = await initWasmModule();
    const encoded = wasm.encode_keyed_doc_frame("test_kv", "d1", 3, new Uint8Array([9, 9]));
    expect(parseKeyedDocFrameHeader(encoded)).toEqual({ kind: "test_kv", id: "d1", epoch: 3 });

    const frame = new Uint8Array(1 + encoded.length);
    frame[0] = FrameType.KEYED_DOC_SYNC;
    frame.set(encoded, 1);
    expect(wasm.keyed_doc_frame_header(frame)).toEqual({ kind: "test_kv", id: "d1", epoch: 3 });

    expect(() => wasm.encode_keyed_doc_frame("Bad-Kind", "d1", 0, new Uint8Array())).toThrow();
    expect(() => wasm.keyed_doc_frame_header(new Uint8Array([FrameType.AUTOMERGE_SYNC]))).toThrow();
  });

  it("drives a WASM KeyedDocHandle replica from header-framed frames", async () => {
    const wasm = await initWasmModule();
    const handle = new wasm.KeyedDocHandle("test_kv", "d1", 2, "user:dev:alice/browser");
    expect([handle.kind, handle.id, handle.epoch]).toEqual(["test_kv", "d1", 2]);
    const opening = handle.flush_sync();
    expect(opening).toBeDefined();
    expect(parseKeyedDocFrameHeader(opening as Uint8Array)).toEqual({
      kind: "test_kv",
      id: "d1",
      epoch: 2,
    });

    // A frame for another epoch is left to the caller.
    const other = wasm.encode_keyed_doc_frame("test_kv", "d1", 1, new Uint8Array());
    const frame = new Uint8Array(1 + other.length);
    frame[0] = FrameType.KEYED_DOC_SYNC;
    frame.set(other, 1);
    expect(handle.receive_frame(frame)).toEqual({
      type: "ignored",
      kind: "test_kv",
      id: "d1",
      epoch: 1,
    });
    expect(handle.to_json()).toEqual({});
    handle.free();
  });
});
