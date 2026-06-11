/**
 * Cloud wiring for the cross-tab NotebookTabBridge.
 *
 * Gate: principal only. Anonymous sessions are fully disabled in BOTH
 * directions — their per-connection principals can never match another
 * tab, and a cross-principal apply would feed the room sync changes from
 * an actor it never authorized. Unlike persistence, the bridge does NOT
 * require a storage adapter (it works without IndexedDB) and is NOT
 * disarmed by a `read_failed` seed outcome (it never writes storage).
 *
 * Lifecycle is the session's: armed per runtime at the same point the
 * persistence controller arms, recreated on principal change, disposed
 * before the WASM handle frees (a closed channel delivers nothing, so no
 * apply can touch a freed handle).
 */

import { createNotebookTabBridge, type NotebookTabBridge } from "runtimed";
import { isAnonymousCloudPrincipal } from "./live-sync";

export interface CloudTabBridgeEngineSurface {
  notebookDocChanged$: { subscribe(next: () => void): { unsubscribe(): void } };
  applyLocalPeerChanges(bytes: Uint8Array): boolean;
}

export interface CloudTabBridgeHandleSurface {
  get_heads_hex(): string[];
  /**
   * Optional to match deployed reality: an older cached WASM bundle may
   * lack the export, and the factory below degrades to single-tab
   * instead of arming a bridge whose every broadcast would throw.
   */
  save_since_heads?(headsHex: string[]): Uint8Array;
}

export interface CreateCloudNotebookTabBridgeOptions {
  notebookId: string;
  principal: string;
  engine: CloudTabBridgeEngineSurface;
  handle: CloudTabBridgeHandleSurface;
  /** Test hook: broadcast throttle. */
  throttleMs?: number;
  /** Test hook: channel factory. */
  createChannel?: Parameters<typeof createNotebookTabBridge>[0]["createChannel"];
}

/**
 * Returns null for anonymous principals, for environments without
 * BroadcastChannel, and for deployed WASM bundles that predate the
 * `save_since_heads` export (the cloudCommsDocSyncMethods deployed-
 * bundle-tolerance pattern) — all degrade to the previous single-tab
 * behavior instead of arming a send path that throws every window.
 */
export function createCloudNotebookTabBridge({
  notebookId,
  principal,
  engine,
  handle,
  throttleMs,
  createChannel,
}: CreateCloudNotebookTabBridgeOptions): NotebookTabBridge | null {
  if (isAnonymousCloudPrincipal(principal)) {
    return null;
  }
  const saveSinceHeads = handle.save_since_heads;
  if (typeof saveSinceHeads !== "function") {
    console.warn(
      "[notebook-cloud] tab bridge disabled: deployed WASM bundle lacks save_since_heads",
    );
    return null;
  }
  return createNotebookTabBridge({
    notebookId,
    principal,
    changes$: engine.notebookDocChanged$,
    getHeadsHex: () => handle.get_heads_hex(),
    getChangesSince: (headsHex) => saveSinceHeads.call(handle, headsHex),
    applyChanges: (bytes) => engine.applyLocalPeerChanges(bytes),
    ...(throttleMs !== undefined ? { throttleMs } : {}),
    ...(createChannel ? { createChannel } : {}),
  });
}
