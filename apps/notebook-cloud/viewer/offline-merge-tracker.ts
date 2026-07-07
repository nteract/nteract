import type { ConnectionStatus } from "runtimed";

/**
 * How long after a reconnect completes ("online") the tracker waits before
 * evaluating the merge outcome. The post-reconnect re-establish
 * (`resetAndResync`) pulls the away-window backlog through `sync_applied`
 * and the projection re-materializes shortly after; evaluating immediately
 * would read a pre-merge cell set and miss the remote backlog entirely.
 */
export const OFFLINE_MERGE_RESYNC_SETTLE_MS = 1_500;

/**
 * Structural slice of the engine's `CellChangeset` the tracker consumes
 * (`SyncEngine.cellChanges$`). `null` mirrors the engine contract: a full
 * materialization is needed and per-cell attribution is unknowable.
 */
export interface OfflineMergeCellChangeset {
  changed: ReadonlyArray<{ cell_id: string }>;
  added: readonly string[];
  removed: readonly string[];
}

export interface OfflineMergeNoticeData {
  /**
   * Distinct cells touched by remote changes applied during the resync
   * window. `null` means unknowable (a full-materialization changeset was
   * seen) — render no count rather than guess.
   */
  mergedRemoteCellCount: number | null;
  /**
   * Cells that carried local edits during the offline window but are
   * absent from the post-resync projection — edited offline, removed by a
   * collaborator (Automerge does not resurrect them).
   */
  removedEditedCellCount: number;
}

export interface OfflineMergeLocalCellEditOptions {
  /**
   * A local mutation event is about to emit through the same `cellChanges$`
   * channel as inbound sync. Discount the matching cell id once if that echo
   * lands during the post-reconnect settle window.
   */
  discountEcho?: boolean;
}

export interface OfflineMergeTrackerOptions {
  /** Post-recovery settle window before the notice fires. */
  settleMs: number;
  /** Current projected cell ids (the store the user actually sees). */
  getProjectedCellIds: () => readonly string[];
  /** Fires AT MOST once per outage, only when local work was pending. */
  onNotice: (notice: OfflineMergeNoticeData) => void;
}

/**
 * Derive "your offline edits just merged" from signals that already exist —
 * no new engine observables, no second diff:
 *
 * - `connectionStatus$` (via the session's stable bridge) bounds the
 *   offline window: it opens on "reconnecting" and closes on "online".
 *   "connecting" is neutral, mirroring `SustainedReconnectingTracker` — a
 *   replacement transport reports it before its first handshake.
 * - Local authorship during the window comes from two unambiguous sources:
 *   `notebookDocChanged$` emissions (while offline no inbound frame can
 *   fire the `sync_applied` source, so every emission is a local flush
 *   attempt — and offline flush attempts are exactly the pending edits) and
 *   the CRDT bridge's per-cell sync callbacks (which also supply the cell
 *   ids the deleted-while-edited check needs).
 * - Remote authorship after recovery comes from `cellChanges$`, which is
 *   fed by the `sync_applied` pipeline: during the settle window its
 *   changesets are the collaborator backlog that interleaved with the
 *   user's offline edits, minus one-shot local mutation echoes recorded by
 *   the shared controller path.
 *
 * Single-fire discipline (the sustained-reconnecting debounce pattern,
 * extended): repeated "reconnecting" deliveries are no-ops; a drop during
 * the settle window cancels the pending evaluation and resumes the SAME
 * outage (accumulated state intact); only a recovery whose settle window
 * elapses fires, once, and firing resets everything. A reconnect with
 * nothing pending resets silently — flaps surface nothing.
 *
 * Cross-reload seeded offline edits arrive through the durable
 * pending-local-edit marker: the marker is validated against the loaded
 * persistence record before calling `notePersistedPendingLocalWork()`, so a
 * routine signed-in seed stays silent. Edits made in the zombie-socket seconds
 * before the transport notices a drop remain out of scope.
 */
export class OfflineMergeTracker {
  private phase: "idle" | "offline" | "settling" = "idle";
  private eligible = true;
  private pendingLocalFlush = false;
  private readonly offlineEditedCellIds = new Set<string>();
  private readonly localEchoCellIds = new Set<string>();
  /** null = a full-materialization changeset made the count unknowable. */
  private remoteChangedCellIds: Set<string> | null = new Set();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: OfflineMergeTrackerOptions) {}

  /**
   * Anonymous sessions are out of scope (their principals are
   * per-connection and persistence never arms for them); the session
   * reports eligibility whenever the connection identity (re)resolves.
   * Going ineligible drops all tracked state.
   */
  noteSessionEligibility(eligible: boolean): void {
    if (this.eligible === eligible) return;
    this.eligible = eligible;
    if (!eligible) {
      this.reset();
    }
  }

  noteConnectionStatus(status: ConnectionStatus): void {
    if (!this.eligible) return;
    if (status === "reconnecting") {
      if (this.phase === "settling") {
        // The outage resumed before the settle window elapsed: same
        // outage, same accumulated state, no notice yet.
        this.clearSettleTimer();
        this.phase = "offline";
        return;
      }
      if (this.phase === "idle") {
        this.phase = "offline";
      }
      return;
    }
    if (status === "online") {
      if (this.phase !== "offline") return;
      if (!this.hasPendingLocalWork()) {
        // Flap-safe: a reconnect with nothing pending surfaces nothing.
        this.reset();
        return;
      }
      this.phase = "settling";
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.fireNotice();
      }, this.options.settleMs);
      return;
    }
    if (status === "offline") {
      // Terminal manual disconnect: nothing will resync, drop the window.
      this.reset();
    }
    // "connecting" falls through: neither opens nor closes the window.
  }

  /**
   * `notebookDocChanged$` emission. Only counted while the offline window
   * is open: with no inbound frames the `sync_applied` source cannot fire,
   * so an offline emission is a local flush attempt by construction. Once
   * online again the signal is mixed-authorship and ignored.
   */
  noteLocalDocActivity(): void {
    if (!this.eligible) return;
    if (this.phase === "offline") {
      this.pendingLocalFlush = true;
    }
  }

  /**
   * A locally persisted seed carried work that was pending remote acceptance
   * before this page loaded. Treat the initial connection as the recovery leg
   * for that prior outage; callers should replay the current connection status
   * afterward because the bridge may already be "online" by the time the seed
   * is resolved.
   */
  notePersistedPendingLocalWork(): void {
    if (!this.eligible) return;
    this.pendingLocalFlush = true;
    if (this.phase === "idle") {
      this.phase = "offline";
    }
  }

  /**
   * A local source edit reached the handle for `cellId` (CRDT bridge sync
   * callback). Tracked only during the offline window. Also marks local
   * work pending directly: an edit landed just before recovery sits inside
   * the engine's flush debounce and only flushes post-resync — exactly the
   * "unflushed handle changes delivered post-resync" shape.
   */
  noteLocalCellEdit(cellId: string, options: OfflineMergeLocalCellEditOptions = {}): void {
    if (!this.eligible) return;
    this.noteLocalEchoCell(cellId, options);
    if (this.phase !== "offline") return;
    this.pendingLocalFlush = true;
    this.offlineEditedCellIds.add(cellId);
  }

  /**
   * The user deleted `cellId` themselves; its absence after resync is not
   * a collaborator removal.
   */
  noteLocalCellDelete(cellId: string, options: OfflineMergeLocalCellEditOptions = {}): void {
    if (!this.eligible) return;
    this.noteLocalEchoCell(cellId, options);
    this.offlineEditedCellIds.delete(cellId);
  }

  /**
   * `cellChanges$` emission (remote-authored by construction — the engine
   * feeds it from `sync_applied` only). Counted during the settle window;
   * a `null` changeset means full materialization and makes the
   * collaborator count unknowable for this outage.
   */
  noteRemoteCellChanges(changeset: OfflineMergeCellChangeset | null): void {
    if (this.phase !== "settling") return;
    if (changeset === null) {
      this.remoteChangedCellIds = null;
      return;
    }
    if (this.remoteChangedCellIds === null) return;
    for (const { cell_id } of changeset.changed) {
      this.noteRemoteCellChange(cell_id);
    }
    for (const id of changeset.added) {
      this.noteRemoteCellChange(id);
    }
    for (const id of changeset.removed) {
      this.noteRemoteCellChange(id);
    }
  }

  dispose(): void {
    this.clearSettleTimer();
  }

  private fireNotice(): void {
    let removedEditedCellCount = 0;
    const projected = this.options.getProjectedCellIds();
    // An empty projection mid-rematerialization is not evidence of
    // deletion; distrust it rather than claim every edited cell vanished.
    if (projected.length > 0) {
      const present = new Set(projected);
      for (const cellId of this.offlineEditedCellIds) {
        if (!present.has(cellId)) {
          removedEditedCellCount += 1;
        }
      }
    }
    const mergedRemoteCellCount =
      this.remoteChangedCellIds === null ? null : this.remoteChangedCellIds.size;
    this.reset();
    this.options.onNotice({ mergedRemoteCellCount, removedEditedCellCount });
  }

  private hasPendingLocalWork(): boolean {
    return this.pendingLocalFlush || this.offlineEditedCellIds.size > 0;
  }

  private reset(): void {
    this.clearSettleTimer();
    this.phase = "idle";
    this.pendingLocalFlush = false;
    this.offlineEditedCellIds.clear();
    this.localEchoCellIds.clear();
    this.remoteChangedCellIds = new Set();
  }

  private noteLocalEchoCell(cellId: string, options: OfflineMergeLocalCellEditOptions): void {
    if (!options.discountEcho) return;
    if (this.phase !== "offline" && this.phase !== "settling") return;
    this.localEchoCellIds.add(cellId);
  }

  private noteRemoteCellChange(cellId: string): void {
    if (this.localEchoCellIds.delete(cellId)) return;
    this.remoteChangedCellIds?.add(cellId);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }
}
