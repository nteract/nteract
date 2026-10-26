// Initial background scheduling policy, not document/resource limits. Counters
// are activation-local and count accepted record writes, including new native
// fragments. No document materialization or history scan happens here.
export const RECORD_MAINTENANCE_POLICY = Object.freeze({
  minWrites: 64,
  minBytes: 256 * 1024,
  minIntervalMs: 60_000,
});

export class RecordMaintenance {
  constructor({
    enabled = false,
    compact,
    waitUntil,
    onError = () => {},
    now = Date.now,
    policy = RECORD_MAINTENANCE_POLICY,
  }) {
    this.enabled = enabled === true;
    this.compact = compact;
    this.waitUntil = waitUntil;
    this.onError = onError;
    this.now = now;
    this.policy = policy;
    this.writes = 0;
    this.bytes = 0;
    this.lastAttempt = -Infinity;
  }

  recordWrite({ key, byteLength } = {}) {
    if (
      !this.enabled ||
      typeof key !== "string" ||
      !/^subduction-v1\/[0-9a-f]{64}\/(commits|fragments)\/[0-9a-f]{64}$/.test(key) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0
    )
      return;
    this.writes++;
    this.bytes += byteLength;
  }

  // Called only after a successful background record flush. Never await this
  // from a document mutation, native storage callback, or Saved receipt path.
  // Skips/failures/cooldown retry on the next successful background flush; no
  // timer keeps an idle Page alive or repeatedly scans unchanged history.
  flushed() {
    if (
      !this.enabled ||
      this.inFlight ||
      this.writes < this.policy.minWrites ||
      this.bytes < this.policy.minBytes ||
      this.now() - this.lastAttempt < this.policy.minIntervalMs
    )
      return;
    const writes = this.writes,
      bytes = this.bytes;
    this.lastAttempt = this.now();
    const work = Promise.resolve()
      .then(() => (this.enabled ? this.compact() : { skipped: "stopped" }))
      .then((result) => {
        if (result?.skipped) return;
        // Consume even a successful no-op, but retain all records accepted
        // while maintenance awaited either of its durability barriers.
        this.writes -= writes;
        this.bytes -= bytes;
      })
      .catch((error) => this.onError(error))
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = work;
    this.waitUntil(work);
  }

  stop() {
    this.enabled = false;
  }
}
