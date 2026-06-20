import type { CommBroadcast, CommChanges } from "runtimed";
import type { WidgetStore } from "./widget-store";

export const RAW_COMM_BROADCAST_MARKER = "__nteract_raw_comm_broadcast__";

export interface ApplyWidgetCommChangesOptions {
  /**
   * Return a filtered patch after suppressing optimistic CRDT echoes.
   * Return null/undefined to skip the update.
   */
  shouldSuppressEcho?: (
    commId: string,
    state: Record<string, unknown>,
  ) => Record<string, unknown> | null | undefined;
  /** Clear per-comm optimistic state when the comm closes. */
  clearComm?: (commId: string) => void;
  /** Resolve OutputModel manifests after the comm state has reached the store. */
  resolveOutputs?: (commId: string, outputs: unknown[], store: WidgetStore) => void;
}

/**
 * Apply durable RuntimeStateDoc/CommsDoc widget projection changes to a
 * WidgetStore. Desktop and hosted cloud both consume the same SyncEngine
 * `commChanges$` stream, so the store transition semantics live here rather
 * than in host-specific React code.
 */
export function applyWidgetCommChangesToStore(
  store: WidgetStore,
  changes: CommChanges,
  options: ApplyWidgetCommChangesOptions = {},
): void {
  for (const comm of changes.opened) {
    store.createModel(
      comm.commId,
      widgetStateWithMetadata(comm),
      comm.bufferPaths,
      comm.targetName,
    );
    maybeResolveCommOutputs(store, comm.commId, comm.unresolvedOutputs, options);
  }

  for (const comm of changes.updated) {
    if (!store.getModel(comm.commId)) {
      store.createModel(
        comm.commId,
        widgetStateWithMetadata(comm),
        comm.bufferPaths,
        comm.targetName,
      );
      maybeResolveCommOutputs(store, comm.commId, comm.unresolvedOutputs, options);
      continue;
    }

    const patch = options.shouldSuppressEcho
      ? options.shouldSuppressEcho(comm.commId, comm.state)
      : comm.state;
    if (patch) {
      store.updateModel(
        comm.commId,
        widgetStateWithMetadata({ ...comm, state: patch }),
        comm.bufferPaths,
      );
    }
    maybeResolveCommOutputs(store, comm.commId, comm.unresolvedOutputs, options);
  }

  for (const commId of changes.closed) {
    options.clearComm?.(commId);
    store.deleteModel(commId);
  }
}

/**
 * Apply an ephemeral custom comm broadcast to a WidgetStore.
 *
 * These are intentionally separate from `applyWidgetCommChangesToStore`:
 * RuntimeStateDoc/CommsDoc are durable widget state, while custom broadcasts
 * are kernel events such as button clicks and `model.send()`.
 */
export function applyWidgetCommBroadcastToStore(
  store: WidgetStore,
  broadcast: CommBroadcast,
): void {
  const data = broadcast.content.data;
  const commId = broadcast.content.comm_id;
  if (typeof commId !== "string") return;

  const arrayBuffers = broadcast.buffers?.map((arr: number[]) => new Uint8Array(arr).buffer);
  if (isRecord(data) && data.method === "custom") {
    const inner = isRecord(data.content) ? data.content : {};
    store.emitCustomMessage(commId, inner, arrayBuffers);
    return;
  }

  store.emitCustomMessage(
    commId,
    {
      [RAW_COMM_BROADCAST_MARKER]: true,
      data: data ?? {},
      metadata: broadcast.metadata ?? {},
    },
    arrayBuffers,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function widgetStateWithMetadata(comm: {
  modelModule: string;
  modelName: string;
  state: Record<string, unknown>;
}): Record<string, unknown> {
  const state = { ...comm.state };
  state._model_module ??= comm.modelModule || undefined;
  state._model_name ??= comm.modelName || undefined;
  return state;
}

function maybeResolveCommOutputs(
  store: WidgetStore,
  commId: string,
  unresolvedOutputs: unknown[] | null,
  options: ApplyWidgetCommChangesOptions,
): void {
  if (unresolvedOutputs) {
    options.resolveOutputs?.(commId, unresolvedOutputs, store);
  }
}
