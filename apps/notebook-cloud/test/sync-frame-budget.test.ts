import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTopFrameBuckets,
  SyncFrameBudgetTracker,
  syncFrameBudgetLogFields,
} from "../src/sync-frame-budget.ts";

describe("sync frame budget tracking", () => {
  it("aggregates frame counts and bytes by direction, scope, and frame type", () => {
    const tracker = new SyncFrameBudgetTracker({
      startedAtMs: 1_000,
      summaryIntervalMs: 10_000,
      frameThreshold: 100,
    });

    tracker.record({
      peerId: "peer-a",
      scope: "owner",
      direction: "incoming",
      frameType: "automerge_sync",
      byteLength: 120,
      nowMs: 1_010,
    });
    tracker.record({
      peerId: "peer-a",
      scope: "owner",
      direction: "incoming",
      frameType: "automerge_sync",
      byteLength: 80,
      nowMs: 1_020,
    });
    tracker.record({
      peerId: "peer-a",
      scope: "owner",
      direction: "outgoing",
      frameType: "runtime_state_sync",
      byteLength: 75,
      nowMs: 1_030,
    });

    const summary = tracker.summarizeWindow(1_100);
    assert(summary);
    assert.equal(summary.windowMs, 100);
    assert.equal(summary.frameCount, 3);
    assert.equal(summary.byteCount, 275);
    assert.equal(summary.incomingFrameCount, 2);
    assert.equal(summary.incomingByteCount, 200);
    assert.equal(summary.outgoingFrameCount, 1);
    assert.equal(summary.outgoingByteCount, 75);
    assert.equal(summary.maxFrameBytes, 120);
    assert.deepEqual(
      summary.buckets.map((bucket) => [
        bucket.direction,
        bucket.scope,
        bucket.frameType,
        bucket.frameCount,
        bucket.byteCount,
        bucket.maxFrameBytes,
      ]),
      [
        ["incoming", "owner", "automerge_sync", 2, 200, 120],
        ["outgoing", "owner", "runtime_state_sync", 1, 75, 75],
      ],
    );
  });

  it("emits a window summary after the configured frame threshold", () => {
    const tracker = new SyncFrameBudgetTracker({
      startedAtMs: 2_000,
      summaryIntervalMs: 60_000,
      frameThreshold: 2,
    });

    tracker.record({
      peerId: "peer-a",
      scope: "viewer",
      direction: "incoming",
      frameType: "presence",
      byteLength: 10,
      nowMs: 2_001,
    });
    assert.equal(tracker.summarizeWindowIfNeeded(2_002), null);

    tracker.record({
      peerId: "peer-a",
      scope: "viewer",
      direction: "incoming",
      frameType: "presence",
      byteLength: 12,
      nowMs: 2_003,
    });
    const summary = tracker.summarizeWindowIfNeeded(2_004);
    assert(summary);
    assert.equal(summary.frameCount, 2);
    assert.equal(tracker.summarizeWindow(2_005), null);
  });

  it("keeps per-peer lifetime summaries independent of periodic windows", () => {
    const tracker = new SyncFrameBudgetTracker({
      startedAtMs: 3_000,
      summaryIntervalMs: 10,
      frameThreshold: 100,
    });

    tracker.record({
      peerId: "peer-a",
      scope: "runtime_peer",
      direction: "incoming",
      frameType: "runtime_state_sync",
      byteLength: 100,
      nowMs: 3_001,
    });
    assert(tracker.summarizeWindowIfNeeded(3_100));

    tracker.record({
      peerId: "peer-a",
      scope: "runtime_peer",
      direction: "outgoing",
      frameType: "comms_doc_sync",
      byteLength: 50,
      nowMs: 3_101,
    });

    const peerSummary = tracker.consumePeer("peer-a", 3_200);
    assert(peerSummary);
    assert.equal(peerSummary.frameCount, 2);
    assert.equal(peerSummary.byteCount, 150);
    assert.equal(tracker.consumePeer("peer-a", 3_201), null);
  });

  it("formats log fields as sparse primitive values", () => {
    const tracker = new SyncFrameBudgetTracker({ startedAtMs: 4_000 });
    tracker.record({
      peerId: "peer-a",
      scope: "owner",
      direction: "incoming",
      frameType: "automerge_sync",
      byteLength: 10,
      nowMs: 4_001,
    });
    const summary = tracker.summarizeWindow(4_010);
    assert(summary);

    const fields = syncFrameBudgetLogFields(summary);
    assert.equal(fields.frame_count, 1);
    assert.deepEqual(fields.top_frame_buckets, [
      "incoming|owner|automerge_sync|frames=1|bytes=10|max=10",
    ]);
    assert.deepEqual(formatTopFrameBuckets(summary.buckets, 0), []);
  });
});
