import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FrameType,
  decodeJsonPayload,
  encodeJsonFrame,
  encodeTypedFrame,
  frameSizeLimits,
  frameTypeName,
  isClientWritableFrame,
  isKnownFrameType,
  splitTypedFrame,
  type FrameTypeValue,
} from "../src/protocol.ts";

const EXPECTED_FRAME_TYPE_ENTRIES = [
  ["AUTOMERGE_SYNC", 0x00, "automerge_sync", true],
  ["REQUEST", 0x01, "request", true],
  ["RESPONSE", 0x02, "response", true],
  ["BROADCAST", 0x03, "broadcast", false],
  ["PRESENCE", 0x04, "presence", true],
  ["RUNTIME_STATE_SYNC", 0x05, "runtime_state_sync", true],
  ["POOL_STATE_SYNC", 0x06, "pool_state_sync", true],
  ["SESSION_CONTROL", 0x07, "session_control", false],
  ["PUT_BLOB", 0x08, "put_blob", true],
  ["COMMS_DOC_SYNC", 0x09, "comms_doc_sync", true],
  ["COMMENTS_DOC_SYNC", 0x0a, "comments_doc_sync", true],
] as const satisfies ReadonlyArray<
  readonly [keyof typeof FrameType, FrameTypeValue, string, boolean]
>;

const EXPECTED_CLIENT_WRITABLE = {
  0x00: true,
  0x01: true,
  0x02: true,
  0x03: false,
  0x04: true,
  0x05: true,
  0x06: true,
  0x07: false,
  0x08: true,
  0x09: true,
  0x0a: true,
} as const satisfies Readonly<Record<FrameTypeValue, boolean>>;

describe("typed-frame protocol helpers", () => {
  it("encodes and splits v4-shaped typed frames", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeTypedFrame(FrameType.AUTOMERGE_SYNC, payload);

    assert.deepEqual([...frame], [FrameType.AUTOMERGE_SYNC, 1, 2, 3]);
    assert.deepEqual(splitTypedFrame(frame), {
      type: FrameType.AUTOMERGE_SYNC,
      payload,
    });
  });

  it("uses session-control JSON for room status", () => {
    const frame = encodeJsonFrame(FrameType.SESSION_CONTROL, {
      type: "cloud_frame_accepted",
      notebook_id: "demo",
      peer_id: "peer",
      frame_type: FrameType.PRESENCE,
      byte_length: 4,
      timestamp: "2026-05-22T00:00:00.000Z",
    });

    const split = splitTypedFrame(frame);

    assert.equal(split.type, FrameType.SESSION_CONTROL);
    assert.deepEqual(
      {
        ...(decodeJsonPayload(split.payload) as Record<string, unknown>),
        timestamp: undefined,
      },
      {
        type: "cloud_frame_accepted",
        notebook_id: "demo",
        peer_id: "peer",
        frame_type: FrameType.PRESENCE,
        byte_length: 4,
        timestamp: undefined,
      },
    );
  });

  it("names and gates every known frame type", () => {
    const expectedKeys = EXPECTED_FRAME_TYPE_ENTRIES.map(([key]) => key);
    const expectedWireOrder = EXPECTED_FRAME_TYPE_ENTRIES.map(([, frameType]) => frameType);

    assert.deepEqual(Object.keys(FrameType).sort(), [...expectedKeys].sort());
    assert.deepEqual([...new Set(expectedWireOrder)], expectedWireOrder);
    assert.deepEqual(
      Object.values(FrameType).sort((left, right) => left - right),
      expectedWireOrder,
    );

    for (const [key, frameType, displayName, clientWritable] of EXPECTED_FRAME_TYPE_ENTRIES) {
      assert.equal(FrameType[key], frameType);
      assert.equal(isKnownFrameType(frameType), true);
      assert.equal(frameTypeName(frameType), displayName);
      assert.equal(isClientWritableFrame(frameType), clientWritable);
      assert.equal(isClientWritableFrame(frameType), EXPECTED_CLIENT_WRITABLE[frameType]);
      assert.deepEqual(splitTypedFrame(new Uint8Array([frameType, 42])), {
        type: frameType,
        payload: new Uint8Array([42]),
      });
    }
    assert.equal(isKnownFrameType(255), false);
    assert.equal(frameTypeName(255), "unknown_255");
  });

  it("mirrors notebook-wire per-frame payload size limits", () => {
    assert.equal(frameSizeLimits(FrameType.AUTOMERGE_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.RUNTIME_STATE_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.COMMS_DOC_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.COMMENTS_DOC_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.PUT_BLOB).cap, 32 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.REQUEST).cap, 16 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.PRESENCE).cap, 4 * 1024);
  });

  it("rejects empty and unknown typed frames", () => {
    assert.throws(() => splitTypedFrame(new Uint8Array()), /typed frame cannot be empty/);
    assert.throws(() => splitTypedFrame(new Uint8Array([255])), /unknown frame type 255/);
  });
});
