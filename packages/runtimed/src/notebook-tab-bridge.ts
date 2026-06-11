/**
 * NotebookTabBridge — same-notebook, same-principal convergence between
 * browser tabs over a BroadcastChannel (slice 3 of the local-first line).
 *
 * One channel per notebook (`nteract-notebook-<notebookId>`), one message
 * kind: `{ kind: "changes", principal, bytes }` where `bytes` is
 * `save_since_heads(lastBroadcastHeads)` — only the delta since this
 * tab's previous broadcast, tracked TS-side. Broadcasts ride the same
 * throttled cadence as persistence (the over-firing `notebookDocChanged$`
 * save hint); an empty delta is skipped, so protocol-only no-ops never
 * hit the wire.
 *
 * Receive path: the principal must equal this session's principal —
 * cross-principal applies would push changes into the room sync under an
 * actor the room never authorized for them. Accepted bytes go through
 * `SyncEngine.applyLocalPeerChanges`, which reuses the `sync_applied`
 * materialization pipeline and reports `changed: false` for known
 * changes. That dedupe is the ping-pong terminator: tab B applying A's
 * changes broadcasts a delta that INCLUDES them (the basis only advances
 * per-broadcast), A re-applies as a no-op, and the chain stops — no
 * echo suppression needed beyond BroadcastChannel's no-self-delivery.
 *
 * The room stays authoritative: applied changes flow up through the
 * receiving tab's ordinary flush/sync (automerge sends whatever the peer
 * lacks; actor-principal validation passes because the principal is the
 * same). Offline behavior falls out free — BroadcastChannel needs no
 * network, two offline tabs converge live, and whichever reconnects
 * first pushes the union.
 *
 * Storage is the shared backstop, not the bridge's concern: the apply
 * path fires `notebookDocChanged$`, persistence captures it, and the
 * chunked store's content addressing makes the resulting concurrent
 * writes idempotent.
 */

export const NOTEBOOK_TAB_BRIDGE_CHANNEL_PREFIX = "nteract-notebook-";

export function notebookTabBridgeChannelName(notebookId: string): string {
  return `${NOTEBOOK_TAB_BRIDGE_CHANNEL_PREFIX}${notebookId}`;
}

/** The single message kind the bridge sends or accepts. */
export interface NotebookTabBridgeChangesMessage {
  kind: "changes";
  principal: string;
  bytes: Uint8Array;
}

/** Minimal BroadcastChannel surface (injectable for tests / non-DOM hosts). */
export interface NotebookTabBridgeChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface NotebookTabBridgeLogger {
  warn(msg: string, ...args: unknown[]): void;
}

/** Broadcast cadence — mirrors the persistence throttle's default. */
const DEFAULT_BROADCAST_THROTTLE_MS = 1_000;

export interface NotebookTabBridgeOptions {
  notebookId: string;

  /**
   * The session's authenticated principal. The caller gates anonymous
   * principals OFF before construction (their per-connection nonces can
   * never match another tab, and an anonymous session must not apply or
   * broadcast at all).
   */
  principal: string;

  /** Change signal, typically `SyncEngine.notebookDocChanged$` (over-fires). */
  changes$: { subscribe(next: () => void): { unsubscribe(): void } };

  /** Current doc heads (`handle.get_heads_hex()`). */
  getHeadsHex: () => string[];

  /** Delta since a basis (`handle.save_since_heads(headsHex)`). */
  getChangesSince: (headsHex: string[]) => Uint8Array;

  /**
   * Apply a peer tab's bytes, typically `engine.applyLocalPeerChanges`.
   * Must report `false`/no-op for already-known changes.
   */
  applyChanges: (bytes: Uint8Array) => boolean;

  /** Trailing-edge broadcast throttle (default 1000 ms, test hook). */
  throttleMs?: number;

  logger?: NotebookTabBridgeLogger;

  /** Channel factory override for tests; defaults to BroadcastChannel. */
  createChannel?: (name: string) => NotebookTabBridgeChannel;
}

/**
 * Create the bridge, or null when no BroadcastChannel implementation is
 * available (and no factory override was supplied) — hosts without it
 * simply run single-tab, exactly as before.
 */
export function createNotebookTabBridge(
  options: NotebookTabBridgeOptions,
): NotebookTabBridge | null {
  if (!options.createChannel && typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new NotebookTabBridge(options);
}

export class NotebookTabBridge {
  private readonly opts: NotebookTabBridgeOptions;
  private readonly throttleMs: number;
  private readonly logger: NotebookTabBridgeLogger;
  private readonly channel: NotebookTabBridgeChannel;
  private readonly subscription: { unsubscribe(): void };
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /**
   * Basis of the next outgoing delta: the doc heads captured at (or
   * before) the previous successful broadcast. Initialized to the heads
   * at construction — the bridge carries deltas forward from arm time;
   * divergence that predates both tabs heals through the room (or
   * through the shared chunk store on the next load), not through a
   * replay protocol this channel does not have.
   */
  private lastBroadcastHeadsHex: string[];

  constructor(opts: NotebookTabBridgeOptions) {
    this.opts = opts;
    this.throttleMs = opts.throttleMs ?? DEFAULT_BROADCAST_THROTTLE_MS;
    this.logger = opts.logger ?? console;
    this.lastBroadcastHeadsHex = [...opts.getHeadsHex()];
    const createChannel =
      opts.createChannel ??
      ((name: string) => new BroadcastChannel(name) as unknown as NotebookTabBridgeChannel);
    this.channel = createChannel(notebookTabBridgeChannelName(opts.notebookId));
    this.channel.onmessage = (event) => this.receive(event?.data);
    this.subscription = opts.changes$.subscribe(() => this.onChanged());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.unsubscribe();
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.channel.onmessage = null;
    try {
      this.channel.close();
    } catch {
      // already closed — nothing to release
    }
  }

  private onChanged(): void {
    if (this.disposed) return;
    if (this.broadcastTimer !== null) return; // throttle window already open
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, this.throttleMs);
  }

  private broadcastNow(): void {
    if (this.disposed) return;
    let heads: string[];
    let bytes: Uint8Array;
    try {
      // Heads BEFORE the delta cut: a change landing between the two
      // calls is included in this delta AND re-covered by the next one
      // (overlap — automerge dedupes), never skipped by both.
      heads = [...this.opts.getHeadsHex()];
      bytes = this.opts.getChangesSince(this.lastBroadcastHeadsHex);
    } catch (e) {
      this.logger.warn("[tab-bridge] delta capture failed:", e);
      return;
    }
    if (bytes.byteLength === 0) {
      // Protocol-only no-op (the save hint over-fires by design).
      this.lastBroadcastHeadsHex = heads;
      return;
    }
    const message: NotebookTabBridgeChangesMessage = {
      kind: "changes",
      principal: this.opts.principal,
      bytes,
    };
    try {
      this.channel.postMessage(message);
    } catch (e) {
      // Basis intentionally NOT advanced: the next signal re-sends the
      // delta. A closed channel lands here once and then disposes stop
      // the signals.
      this.logger.warn("[tab-bridge] broadcast failed:", e);
      return;
    }
    this.lastBroadcastHeadsHex = heads;
  }

  private receive(data: unknown): void {
    if (this.disposed) return;
    const message = asChangesMessage(data);
    if (!message) return;
    if (message.principal !== this.opts.principal) {
      // Cross-principal traffic is dropped silently in both directions:
      // applying it would feed the room sync changes its actor-principal
      // authorization never approved.
      return;
    }
    try {
      this.opts.applyChanges(message.bytes);
    } catch (e) {
      this.logger.warn("[tab-bridge] peer apply failed:", e);
    }
  }
}

function asChangesMessage(data: unknown): NotebookTabBridgeChangesMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Partial<NotebookTabBridgeChangesMessage>;
  if (candidate.kind !== "changes") return null;
  if (typeof candidate.principal !== "string") return null;
  const bytes = candidate.bytes;
  if (bytes instanceof Uint8Array) {
    return { kind: "changes", principal: candidate.principal, bytes };
  }
  // Structured clone across realms can surface plain views; normalize.
  if (ArrayBuffer.isView(bytes)) {
    const view = bytes as ArrayBufferView;
    return {
      kind: "changes",
      principal: candidate.principal,
      bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    };
  }
  return null;
}
