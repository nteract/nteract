/**
 * SyncHealScheduler — per-doc resync heal-retry with an exhaustion signal
 * (slice 5 of #3585; automerge-repo's SyncScheduler shape: 2s → 60s,
 * factor 2, jittered, bounded attempts, then ONE terminal heal-exhausted
 * event).
 *
 * Confirmation is just another sync: after a resync kick the session
 * polls the doc's catch-up fact (`notebook_doc_caught_up()` on each
 * `notebookSyncApplied$` emission — the #3588 primitives) and feeds it
 * here. `caught_up === true` IS the confirmation check — a
 * re-verification that returns true iff the previous exchange landed.
 * No confirmation inside the deadline → re-kick the resync on the next
 * ladder rung; ladder exhausted → one terminal signal (the quiet
 * "Sync is stalled" notice), cleared if convergence later lands.
 *
 * Per-doc keyed so RuntimeStateDoc/CommsDoc can adopt the same loop
 * later; only the NotebookDoc is wired today (`NOTEBOOK_DOC_HEAL_KEY`).
 *
 * Interplay (deliberate non-couplings):
 * - Re-kicks call `resetAndResync()` directly and never touch the
 *   CloudRecoverableRejectionTracker: strikes count inbound rejections
 *   only, and the tracker's delivery-gated absorb window
 *   (`resyncPending`) is set exclusively by its own strike-1 path.
 * - Re-kicks are gated on the link being up (`shouldKick`): while the
 *   transport is reconnecting, the deadline neither kicks nor consumes
 *   an attempt — offline stalls belong to the sustained-reconnecting
 *   line, and a kick's flush attempt while the offline-merge tracker's
 *   window is open would be miscounted as local authoring.
 * - Heal exhaustion is NOT bridge poison: it never touches the tab
 *   bridge quarantine flag (separate failure domains).
 * - A `roomReady$` adoption resets the ladder like reconnect backoff
 *   resets on the app-level ack: fresh connection, fresh verification.
 */

export const SYNC_HEAL_BASE_DELAY_MS = 2_000;
export const SYNC_HEAL_MAX_DELAY_MS = 60_000;
export const SYNC_HEAL_BACKOFF_FACTOR = 2;
export const SYNC_HEAL_MAX_ATTEMPTS = 10;
/** ± full jitter ratio on every deadline (random 0.5 = exact rung). */
export const SYNC_HEAL_JITTER_RATIO = 0.25;

/** The only doc wired today. */
export const NOTEBOOK_DOC_HEAL_KEY = "notebook-doc";

export interface SyncHealLogger {
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

export interface SyncHealSchedulerOptions {
  /** Re-issue the doc's resync (the session's `resetAndResync()` seam). */
  kick: (docKey: string) => void;

  /**
   * Gate consulted at each deadline: false (link down, runtime gone)
   * re-arms the SAME rung without kicking or consuming an attempt.
   */
  shouldKick?: (docKey: string) => boolean;

  /** The ONE terminal signal per stalled episode. */
  onExhausted: (docKey: string) => void;

  /** Convergence landed after exhaustion — clear the terminal surface. */
  onRecovered: (docKey: string) => void;

  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  maxAttempts?: number;
  jitterRatio?: number;

  /** Jitter source override for deterministic tests (0.5 = no jitter). */
  random?: () => number;

  logger?: SyncHealLogger;
}

interface DocHealState {
  /** Re-kicks issued since the ladder last reset. */
  attempts: number;
  /** Pending verification deadline (null = not verifying). */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * The terminal signal fired and convergence has not landed since. The
   * episode ends only at `caught_up === true` (onRecovered), never at a
   * ladder reset — a reconnect that still cannot converge must not
   * re-fire the notice for what is the same stall.
   */
  exhausted: boolean;
}

export class SyncHealScheduler {
  private readonly opts: SyncHealSchedulerOptions;
  private readonly docs = new Map<string, DocHealState>();
  private disposed = false;

  constructor(opts: SyncHealSchedulerOptions) {
    this.opts = opts;
  }

  /**
   * A resync was just issued for this doc (roomReady re-establish, the
   * rejection tracker's in-place recovery, or this scheduler's own
   * re-kick): arm the verification deadline at the current ladder rung.
   */
  noteResyncKicked(docKey: string): void {
    if (this.disposed) return;
    const state = this.docState(docKey);
    this.clearTimer(state);
    this.armDeadline(docKey, state);
  }

  /**
   * Feed each `notebookSyncApplied$` poll of `notebook_doc_caught_up()`.
   * `true` settles the loop: the previous exchange provably landed —
   * cancel the deadline, reset the ladder, and clear a standing
   * exhaustion. `false` is not a failure (frames are still flowing);
   * the deadline timer remains the judge.
   */
  noteVerification(docKey: string, caughtUp: boolean): void {
    if (this.disposed || !caughtUp) return;
    const state = this.docs.get(docKey);
    if (!state) return;
    this.clearTimer(state);
    state.attempts = 0;
    if (state.exhausted) {
      state.exhausted = false;
      this.opts.logger?.debug(`[sync-heal] ${docKey} converged after exhaustion; clearing`);
      this.opts.onRecovered(docKey);
    }
  }

  /**
   * Fresh connection (roomReady adoption): reset the ladder the way
   * reconnect backoff resets on the app-level ack. Keeps a standing
   * exhaustion flag — only real convergence clears the notice.
   */
  reset(docKey: string): void {
    if (this.disposed) return;
    const state = this.docs.get(docKey);
    if (!state) return;
    this.clearTimer(state);
    state.attempts = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.docs.values()) {
      this.clearTimer(state);
    }
    this.docs.clear();
  }

  private clearTimer(state: DocHealState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private docState(docKey: string): DocHealState {
    let state = this.docs.get(docKey);
    if (!state) {
      state = { attempts: 0, timer: null, exhausted: false };
      this.docs.set(docKey, state);
    }
    return state;
  }

  private armDeadline(docKey: string, state: DocHealState): void {
    state.timer = setTimeout(() => {
      state.timer = null;
      this.onDeadline(docKey, state);
    }, this.deadlineMs(state.attempts));
  }

  private onDeadline(docKey: string, state: DocHealState): void {
    if (this.disposed) return;
    if (!(this.opts.shouldKick?.(docKey) ?? true)) {
      // Link down or runtime gone: not a sync stall. Hold the rung —
      // the reconnect machinery owns this state, and roomReady resets
      // the ladder when the room is back.
      this.armDeadline(docKey, state);
      return;
    }
    const maxAttempts = this.opts.maxAttempts ?? SYNC_HEAL_MAX_ATTEMPTS;
    if (state.attempts >= maxAttempts) {
      // Stop the ladder. One terminal signal per episode; a standing
      // exhaustion (e.g. after a roomReady reset re-ran the ladder
      // without converging) stays silent.
      if (!state.exhausted) {
        state.exhausted = true;
        this.opts.logger?.warn(
          `[sync-heal] ${docKey} resync verification exhausted after ${maxAttempts} attempts; edits stay local until sync recovers`,
        );
        this.opts.onExhausted(docKey);
      }
      return;
    }
    state.attempts += 1;
    this.opts.logger?.debug(
      `[sync-heal] ${docKey} not caught up by deadline; re-kicking resync (attempt ${state.attempts})`,
    );
    this.opts.kick(docKey);
    this.armDeadline(docKey, state);
  }

  private deadlineMs(attempts: number): number {
    const base = this.opts.baseDelayMs ?? SYNC_HEAL_BASE_DELAY_MS;
    const max = this.opts.maxDelayMs ?? SYNC_HEAL_MAX_DELAY_MS;
    const factor = this.opts.backoffFactor ?? SYNC_HEAL_BACKOFF_FACTOR;
    const ratio = this.opts.jitterRatio ?? SYNC_HEAL_JITTER_RATIO;
    const rung = Math.min(base * factor ** attempts, max);
    const random = this.opts.random ?? Math.random;
    // Full ± jitter: random() of 0.5 lands exactly on the rung.
    return Math.max(0, Math.round(rung * (1 + (2 * random() - 1) * ratio)));
  }
}
