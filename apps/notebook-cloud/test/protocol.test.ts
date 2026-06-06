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
  splitTypedFrame,
} from "../src/protocol.ts";

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

  it("names and gates client writable frames", () => {
    assert.equal(frameTypeName(FrameType.RUNTIME_STATE_SYNC), "runtime_state_sync");
    assert.equal(frameTypeName(FrameType.COMMS_DOC_SYNC), "comms_doc_sync");
    assert.equal(isClientWritableFrame(FrameType.AUTOMERGE_SYNC), true);
    assert.equal(isClientWritableFrame(FrameType.COMMS_DOC_SYNC), true);
    assert.equal(isClientWritableFrame(FrameType.SESSION_CONTROL), false);
  });

  it("mirrors notebook-wire per-frame payload size limits", () => {
    assert.equal(frameSizeLimits(FrameType.AUTOMERGE_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.RUNTIME_STATE_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.COMMS_DOC_SYNC).cap, 64 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.PUT_BLOB).cap, 32 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.REQUEST).cap, 16 * 1024 * 1024);
    assert.equal(frameSizeLimits(FrameType.PRESENCE).cap, 4 * 1024);
  });

  it("rejects empty and unknown typed frames", () => {
    assert.throws(() => splitTypedFrame(new Uint8Array()), /typed frame cannot be empty/);
    assert.throws(() => splitTypedFrame(new Uint8Array([255])), /unknown frame type 255/);
  });
});
