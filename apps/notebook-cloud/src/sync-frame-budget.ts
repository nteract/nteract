import type { CloudLogFields } from "./observability.ts";

export type SyncFrameBudgetDirection = "incoming" | "outgoing";

export interface SyncFrameBudgetSample {
  peerId: string;
  scope: string;
  direction: SyncFrameBudgetDirection;
  frameType: string;
  byteLength: number;
  nowMs?: number;
}

export interface SyncFrameBudgetBucket {
  key: string;
  direction: SyncFrameBudgetDirection;
  scope: string;
  frameType: string;
  frameCount: number;
  byteCount: number;
  maxFrameBytes: number;
}

export interface SyncFrameBudgetSummary {
  windowMs: number;
  frameCount: number;
  byteCount: number;
  incomingFrameCount: number;
  incomingByteCount: number;
  outgoingFrameCount: number;
  outgoingByteCount: number;
  maxFrameBytes: number;
  buckets: SyncFrameBudgetBucket[];
}

export const DEFAULT_SYNC_FRAME_BUDGET_SUMMARY_INTERVAL_MS = 30_000;
export const DEFAULT_SYNC_FRAME_BUDGET_SUMMARY_FRAME_THRESHOLD = 250;

interface SyncFrameBudgetTrackerOptions {
  startedAtMs?: number;
  summaryIntervalMs?: number;
  frameThreshold?: number;
}

interface MutableBucket {
  direction: SyncFrameBudgetDirection;
  scope: string;
  frameType: string;
  frameCount: number;
  byteCount: number;
  maxFrameBytes: number;
}

interface MutableTotals {
  startedAtMs: number;
  frameCount: number;
  byteCount: number;
  incomingFrameCount: number;
  incomingByteCount: number;
  outgoingFrameCount: number;
  outgoingByteCount: number;
  maxFrameBytes: number;
}

export class SyncFrameBudgetTracker {
  private readonly summaryIntervalMs: number;
  private readonly frameThreshold: number;
  private windowTotals: MutableTotals;
  private readonly windowBuckets = new Map<string, MutableBucket>();
  private readonly peerTotals = new Map<string, MutableTotals>();
  private readonly peerBuckets = new Map<string, Map<string, MutableBucket>>();

  constructor(options: SyncFrameBudgetTrackerOptions = {}) {
    const startedAtMs = options.startedAtMs ?? Date.now();
    this.summaryIntervalMs =
      options.summaryIntervalMs ?? DEFAULT_SYNC_FRAME_BUDGET_SUMMARY_INTERVAL_MS;
    this.frameThreshold =
      options.frameThreshold ?? DEFAULT_SYNC_FRAME_BUDGET_SUMMARY_FRAME_THRESHOLD;
    this.windowTotals = emptyTotals(startedAtMs);
  }

  record(sample: SyncFrameBudgetSample): void {
    const nowMs = sample.nowMs ?? Date.now();
    const byteLength = Math.max(0, Math.trunc(sample.byteLength));
    recordTotals(this.windowTotals, sample.direction, byteLength);
    recordBucket(this.windowBuckets, sample, byteLength);

    const peerTotals = this.peerTotals.get(sample.peerId) ?? emptyTotals(nowMs);
    this.peerTotals.set(sample.peerId, peerTotals);
    recordTotals(peerTotals, sample.direction, byteLength);

    const peerBuckets = this.peerBuckets.get(sample.peerId) ?? new Map<string, MutableBucket>();
    this.peerBuckets.set(sample.peerId, peerBuckets);
    recordBucket(peerBuckets, sample, byteLength);
  }

  shouldSummarizeWindow(nowMs = Date.now()): boolean {
    if (this.windowTotals.frameCount === 0) return false;
    return (
      nowMs - this.windowTotals.startedAtMs >= this.summaryIntervalMs ||
      this.windowTotals.frameCount >= this.frameThreshold
    );
  }

  summarizeWindow(nowMs = Date.now()): SyncFrameBudgetSummary | null {
    if (this.windowTotals.frameCount === 0) return null;
    const summary = buildSummary(this.windowTotals, this.windowBuckets, nowMs);
    this.windowTotals = emptyTotals(nowMs);
    this.windowBuckets.clear();
    return summary;
  }

  summarizeWindowIfNeeded(nowMs = Date.now()): SyncFrameBudgetSummary | null {
    return this.shouldSummarizeWindow(nowMs) ? this.summarizeWindow(nowMs) : null;
  }

  consumePeer(peerId: string, nowMs = Date.now()): SyncFrameBudgetSummary | null {
    const totals = this.peerTotals.get(peerId);
    const buckets = this.peerBuckets.get(peerId);
    if (!totals || totals.frameCount === 0 || !buckets) return null;
    const summary = buildSummary(totals, buckets, nowMs);
    this.peerTotals.delete(peerId);
    this.peerBuckets.delete(peerId);
    return summary;
  }
}

export function syncFrameBudgetLogFields(summary: SyncFrameBudgetSummary): CloudLogFields {
  return {
    window_ms: summary.windowMs,
    frame_count: summary.frameCount,
    byte_count: summary.byteCount,
    incoming_frame_count: summary.incomingFrameCount,
    incoming_byte_count: summary.incomingByteCount,
    outgoing_frame_count: summary.outgoingFrameCount,
    outgoing_byte_count: summary.outgoingByteCount,
    max_frame_bytes: summary.maxFrameBytes,
    top_frame_buckets: formatTopFrameBuckets(summary.buckets),
  };
}

export function formatTopFrameBuckets(
  buckets: readonly SyncFrameBudgetBucket[],
  limit = 12,
): string[] {
  return buckets
    .slice(0, limit)
    .map((bucket) =>
      [
        bucket.direction,
        bucket.scope,
        bucket.frameType,
        `frames=${bucket.frameCount}`,
        `bytes=${bucket.byteCount}`,
        `max=${bucket.maxFrameBytes}`,
      ].join("|"),
    );
}

function recordTotals(
  totals: MutableTotals,
  direction: SyncFrameBudgetDirection,
  byteLength: number,
): void {
  totals.frameCount += 1;
  totals.byteCount += byteLength;
  totals.maxFrameBytes = Math.max(totals.maxFrameBytes, byteLength);
  if (direction === "incoming") {
    totals.incomingFrameCount += 1;
    totals.incomingByteCount += byteLength;
  } else {
    totals.outgoingFrameCount += 1;
    totals.outgoingByteCount += byteLength;
  }
}

function recordBucket(
  buckets: Map<string, MutableBucket>,
  sample: SyncFrameBudgetSample,
  byteLength: number,
): void {
  const key = bucketKey(sample);
  const bucket =
    buckets.get(key) ??
    ({
      direction: sample.direction,
      scope: sample.scope,
      frameType: sample.frameType,
      frameCount: 0,
      byteCount: 0,
      maxFrameBytes: 0,
    } satisfies MutableBucket);
  buckets.set(key, bucket);
  bucket.frameCount += 1;
  bucket.byteCount += byteLength;
  bucket.maxFrameBytes = Math.max(bucket.maxFrameBytes, byteLength);
}

function buildSummary(
  totals: MutableTotals,
  buckets: Map<string, MutableBucket>,
  nowMs: number,
): SyncFrameBudgetSummary {
  return {
    windowMs: Math.max(0, Math.round(nowMs - totals.startedAtMs)),
    frameCount: totals.frameCount,
    byteCount: totals.byteCount,
    incomingFrameCount: totals.incomingFrameCount,
    incomingByteCount: totals.incomingByteCount,
    outgoingFrameCount: totals.outgoingFrameCount,
    outgoingByteCount: totals.outgoingByteCount,
    maxFrameBytes: totals.maxFrameBytes,
    buckets: Array.from(buckets.entries())
      .map(([key, bucket]) => ({ key, ...bucket }))
      .sort(compareBuckets),
  };
}

function compareBuckets(a: SyncFrameBudgetBucket, b: SyncFrameBudgetBucket): number {
  return (
    b.byteCount - a.byteCount ||
    b.frameCount - a.frameCount ||
    a.direction.localeCompare(b.direction) ||
    a.scope.localeCompare(b.scope) ||
    a.frameType.localeCompare(b.frameType)
  );
}

function bucketKey(sample: SyncFrameBudgetSample): string {
  return `${sample.direction}:${sample.scope}:${sample.frameType}`;
}

function emptyTotals(startedAtMs: number): MutableTotals {
  return {
    startedAtMs,
    frameCount: 0,
    byteCount: 0,
    incomingFrameCount: 0,
    incomingByteCount: 0,
    outgoingFrameCount: 0,
    outgoingByteCount: 0,
    maxFrameBytes: 0,
  };
}
