/**
 * ReconnectGovernor: client-side policy for automatic daemon reconnection.
 *
 * Any transport that auto-reconnects routes its retry decisions through this
 * class, which owns two invariants:
 *
 * 1. **Backoff.** The first retry after a stable connection is immediate;
 *    consecutive losses grow the delay exponentially with jitter, capped at
 *    `maxDelayMs`. A daemon that rejects every connection is dialed at most
 *    once per ~30s instead of several times per second. The attempt counter
 *    resets only after a connection stays up for `stabilityWindowMs`, so a
 *    connect-then-drop flap cannot re-arm the fast path.
 * 2. **Terminal latch.** `latchFailure(reason)` (initial load reported
 *    `Failed` for the room) stops automatic reconnection entirely. Only
 *    `reset()` (a manual Retry) or `clearLatch()` (a live session reports a
 *    non-failed load) re-arms the loop.
 *
 * Timers run on the injected `SchedulerLike` so tests drive them with virtual
 * time. Every cancel/reset bumps an internal epoch; async completions from a
 * previous epoch are ignored, so a stale reconnect settling late can never
 * clobber a latch or a reset.
 */

import {
  BehaviorSubject,
  asyncScheduler,
  type Observable,
  type SchedulerLike,
  type Subscription,
} from "rxjs";

export type ReconnectGovernorState =
  | { kind: "idle" }
  | { kind: "waiting"; attempt: number; delayMs: number }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "latched"; reason: string };

export interface ReconnectGovernorOptions {
  /**
   * One reconnect attempt. Resolution means the dial succeeded (session
   * health is reported separately via `connectionEstablished`); rejection
   * schedules the next attempt.
   */
  reconnect: () => Promise<void>;
  /** Delay before the second consecutive attempt. Default 500ms. */
  baseDelayMs?: number;
  /** Delay ceiling. Default 30_000ms. */
  maxDelayMs?: number;
  /** Uniform jitter as a fraction of the raw delay. Default 0.25 (±25%). */
  jitterRatio?: number;
  /**
   * How long a connection must stay established before the attempt counter
   * resets to the immediate-retry fast path. Default 10_000ms.
   */
  stabilityWindowMs?: number;
  /** Jitter source in [0, 1). Injectable for deterministic tests. */
  random?: () => number;
  /** Clock for retry and stability timers. Injectable for virtual time. */
  scheduler?: SchedulerLike;
}

export class ReconnectGovernor {
  private readonly reconnect: () => Promise<void>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly stabilityWindowMs: number;
  private readonly random: () => number;
  private readonly scheduler: SchedulerLike;

  private readonly _state$ = new BehaviorSubject<ReconnectGovernorState>({ kind: "idle" });
  readonly state$: Observable<ReconnectGovernorState> = this._state$.asObservable();

  private attempt = 0;
  private epoch = 0;
  private retryTimer: Subscription | null = null;
  private stabilityTimer: Subscription | null = null;
  private disposed = false;

  constructor(options: ReconnectGovernorOptions) {
    this.reconnect = options.reconnect;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.jitterRatio = options.jitterRatio ?? 0.25;
    this.stabilityWindowMs = options.stabilityWindowMs ?? 10_000;
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? asyncScheduler;
  }

  getState(): ReconnectGovernorState {
    return this._state$.getValue();
  }

  /**
   * The daemon link dropped. Schedules the next automatic attempt unless a
   * retry is already pending or the governor is latched.
   */
  connectionLost(): void {
    if (this.disposed) return;
    const state = this.getState();
    if (state.kind === "latched" || state.kind === "waiting") return;
    this.cancelStabilityTimer();
    this.scheduleAttempt(this.attempt + 1);
  }

  /**
   * The daemon link is up (daemon:ready). Cancels any pending retry. The
   * attempt counter resets only after the link survives the stability
   * window, so connect-then-drop flapping keeps growing the backoff.
   */
  connectionEstablished(): void {
    if (this.disposed) return;
    this.armStabilityTimer();
    const kind = this.getState().kind;
    if (kind === "latched" || kind === "idle") return;
    this.cancelRetryTimer();
    this.epoch++;
    this._state$.next({ kind: "idle" });
  }

  /**
   * Latch a terminal failure: automatic reconnection stops until `reset()`
   * or `clearLatch()`. The reason is surfaced by the terminal UI.
   */
  latchFailure(reason: string): void {
    if (this.disposed) return;
    this.cancelRetryTimer();
    this.cancelStabilityTimer();
    this.epoch++;
    this._state$.next({ kind: "latched", reason });
  }

  /**
   * A live session reported a non-failed initial load; drop the latch
   * without touching backoff. No-op unless latched.
   */
  clearLatch(): void {
    if (this.disposed) return;
    if (this.getState().kind !== "latched") return;
    this.attempt = 0;
    this.epoch++;
    this._state$.next({ kind: "idle" });
  }

  /**
   * Pull the next automatic attempt forward to now. For callers whose own
   * signal (bootstrap timeout) says the link is dead even though no
   * `connectionLost` fired, or one fired and the retry is still waiting.
   * Unlike `reset()`, the backoff schedule survives: a failed dial
   * schedules the next attempt instead of leaving nothing pending. No-op
   * while latched (terminal failures need `reset()`) or while an attempt
   * is already in flight.
   */
  retryNow(): void {
    if (this.disposed) return;
    const kind = this.getState().kind;
    if (kind === "latched" || kind === "reconnecting") return;
    this.cancelRetryTimer();
    this.cancelStabilityTimer();
    const attempt = Math.max(this.attempt, 1);
    this.attempt = attempt;
    const epoch = ++this.epoch;
    this.runAttempt(attempt, epoch);
  }

  /**
   * Manual-retry intent: drop the latch, restart backoff from scratch, and
   * cancel any pending automatic attempt. The caller performs its own dial.
   */
  reset(): void {
    if (this.disposed) return;
    this.cancelRetryTimer();
    this.cancelStabilityTimer();
    this.attempt = 0;
    this.epoch++;
    this._state$.next({ kind: "idle" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRetryTimer();
    this.cancelStabilityTimer();
    this.epoch++;
    this._state$.complete();
  }

  private scheduleAttempt(attempt: number): void {
    this.cancelRetryTimer();
    this.attempt = attempt;
    const delayMs = this.delayForAttempt(attempt);
    const epoch = ++this.epoch;
    if (delayMs === 0) {
      // Immediate first retry keeps the healthy-disconnect UX snappy and
      // runs inline so callers observe "reconnecting" synchronously.
      this.runAttempt(attempt, epoch);
      return;
    }
    this._state$.next({ kind: "waiting", attempt, delayMs });
    this.retryTimer = this.scheduler.schedule(() => {
      this.retryTimer = null;
      if (this.disposed || epoch !== this.epoch) return;
      this.runAttempt(attempt, epoch);
    }, delayMs);
  }

  private runAttempt(attempt: number, epoch: number): void {
    this._state$.next({ kind: "reconnecting", attempt });
    this.reconnect().then(
      () => {
        // Dialed. Session health arrives out-of-band: either
        // connectionEstablished (idle) or another connectionLost (next
        // attempt). Nothing to do here.
      },
      () => {
        if (this.disposed || epoch !== this.epoch) return;
        this.scheduleAttempt(this.attempt + 1);
      },
    );
  }

  private delayForAttempt(attempt: number): number {
    if (attempt <= 1) return 0;
    const raw = Math.min(this.baseDelayMs * 2 ** (attempt - 2), this.maxDelayMs);
    const jittered = raw * (1 + this.jitterRatio * (2 * this.random() - 1));
    return Math.min(Math.max(Math.round(jittered), 0), this.maxDelayMs);
  }

  // A drop right after the window fires gets one immediate redial: the
  // window IS the definition of having earned the fast path back. The
  // pathological flap cycle (up for exactly the window, then drop) dials
  // once per stabilityWindowMs, the accepted floor, versus several per
  // second unguarded.
  private armStabilityTimer(): void {
    this.cancelStabilityTimer();
    this.stabilityTimer = this.scheduler.schedule(() => {
      this.stabilityTimer = null;
      if (this.disposed) return;
      this.attempt = 0;
    }, this.stabilityWindowMs);
  }

  private cancelRetryTimer(): void {
    this.retryTimer?.unsubscribe();
    this.retryTimer = null;
  }

  private cancelStabilityTimer(): void {
    this.stabilityTimer?.unsubscribe();
    this.stabilityTimer = null;
  }
}
