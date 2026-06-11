/**
 * CRDT ↔ CodeMirror bridge — character-level Automerge sync for cell editors.
 *
 * Replaces the React `value` prop round-trip with a direct ViewPlugin that
 * splices edits into the Automerge Text CRDT at character granularity (no
 * Myers diff) and applies inbound remote changes as incremental CM
 * transactions (no full-document replacement).
 *
 * Architecture (modeled on automerge-codemirror):
 *
 *   Outbound (typing → CRDT):
 *     CM transaction → ViewPlugin.update() → iterChanges →
 *     handle.splice_source(cellId, index, deleteCount, text) per change
 *
 *   Inbound (remote sync → editor):
 *     receive_frame → text attributions via frame bus →
 *     applyRemoteChanges() → view.dispatch({ reconcile annotation })
 *
 *   Echo avoidance (two layers):
 *     1. reconcileAnnotation on inbound dispatches — outbound filters them
 *     2. isProcessingOutbound flag — suppresses inbound during outbound
 *
 * Usage:
 *   const bridge = createCrdtBridge({ getHandle, cellId, onSourceChanged, onSyncNeeded });
 *   // pass bridge.extension to CodeMirror extensions array
 *   // call bridge.applyRemoteChanges(changes) from the frame bus
 *   // call bridge.destroy() on unmount
 */

import { EditorState, type ChangeSpec, type Extension, type Transaction } from "@codemirror/state";
import {
  type EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { externalChangeAnnotation } from "@/components/editor/codemirror-editor";
import type { NotebookHandle } from "../wasm/runtimed-wasm/runtimed_wasm.js";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

/** A single character-level change from a remote peer (text attribution). */
export interface RemoteChange {
  /** Character index where the change starts (in the post-previous-change doc). */
  index: number;
  /** Text inserted at this index (empty string for pure deletions). */
  text: string;
  /** Number of characters deleted at this index (0 for pure insertions). */
  deleted: number;
}

/** Minimal text-attribution shape emitted by WASM sync. */
export interface TextAttributionLike {
  cell_id: string;
  index: number;
  text: string;
  deleted: number;
  actors: string[];
}

/** Configuration for the CRDT bridge. */
export interface CrdtBridgeConfig {
  /** Read the current WASM NotebookHandle (null during bootstrap). */
  getHandle: () => NotebookHandle | null;
  /** The cell ID this editor is bound to. */
  cellId: string;
  /**
   * Host capability gate for outbound source mutations.
   *
   * Desktop normally allows source writes. Cloud can return false for viewer
   * mode or ACL-denied cells so stale editors cannot mutate the CRDT even if
   * CodeMirror produces a transaction.
   */
  canWriteSource?: () => boolean;
  /**
   * Called after outbound splices are applied to the CRDT.
   * The bridge passes the full source string so the cell store can be updated.
   */
  onSourceChanged: (source: string) => void;
  /** Called after outbound changes — triggers the debounced sync to daemon. */
  onSyncNeeded: () => void;
}

/** Handle returned by createCrdtBridge. */
export interface CrdtBridge {
  /** CodeMirror extension array — pass to EditorView. */
  extension: Extension;
  /**
   * Apply remote changes from the frame bus (text attributions) to the
   * editor. Each change is dispatched as a reconcile-annotated transaction.
   *
   * Call this from the frame bus subscriber when attributions arrive for
   * this cell. Changes are applied in order; positions are cumulative
   * (each change's index is relative to the doc after the previous change).
   */
  applyRemoteChanges: (changes: RemoteChange[]) => void;
  /**
   * Apply a full source replacement from the store (e.g., after full
   * materialization or initial load). Only dispatches if the source
   * differs from the editor's current content.
   */
  applyFullSource: (source: string) => void;
  /**
   * Imperatively replace the cell source end-to-end: CRDT + CM + store + sync.
   *
   * Use for commands that set the entire source from outside the editor
   * (history search recall, MCP set_cell, undo-to-checkpoint, etc.).
   * Unlike `applyFullSource` (CM-only), this updates the Automerge doc
   * via `update_source` (Myers diff), dispatches to CM, writes to the
   * cell store, and triggers sync to the daemon.
   *
   * Returns false if the handle is unavailable (bootstrap in progress).
   */
  replaceSource: (source: string) => boolean;
  /** Get the current EditorView (null if not yet attached). */
  getView: () => EditorView | null;
}

// ── Annotation ───────────────────────────────────────────────────────

/** Check if a transaction is a reconcile (inbound from CRDT). */
function isReconcileTx(tr: Transaction): boolean {
  return !!tr.annotation(externalChangeAnnotation);
}

/**
 * Convert WASM text attributions into CodeMirror remote changes for one cell.
 *
 * Desktop and cloud both use this so self-echo filtering and attribution patch
 * ordering stay aligned across hosts.
 */
export function remoteChangesFromTextAttributions(
  attributions: readonly TextAttributionLike[],
  cellId: string,
  localActor: string | null | undefined,
): RemoteChange[] {
  const changes: RemoteChange[] = [];
  for (const attr of attributions) {
    if (attr.cell_id !== cellId) continue;
    if (localActor && attr.actors.length === 1 && attr.actors[0] === localActor) {
      continue;
    }
    changes.push({
      index: attr.index,
      text: attr.text,
      deleted: attr.deleted,
    });
  }
  return changes;
}

// ── Bridge factory ───────────────────────────────────────────────────

/**
 * Create a CRDT bridge for a single cell editor.
 *
 * Returns an extension to pass to CodeMirror and methods to push inbound
 * changes. The bridge handles outbound (typing → splice) automatically
 * via the ViewPlugin.
 */
export function createCrdtBridge(config: CrdtBridgeConfig): CrdtBridge {
  const { getHandle, cellId, canWriteSource = () => true, onSourceChanged, onSyncNeeded } = config;

  // Shared mutable state between the plugin instance and the bridge handle.
  // The plugin sets `currentView` on create; the bridge reads it for inbound.
  let currentView: EditorView | null = null;
  let isProcessingOutbound = false;
  let pendingSource: string | null = null;
  let sourceChangeScheduled = false;
  let destroyed = false;

  // ── ViewPlugin (outbound path) ───────────────────────────────────

  class CrdtBridgePlugin implements PluginValue {
    constructor(view: EditorView) {
      destroyed = false;
      currentView = view;
    }

    update(vu: ViewUpdate) {
      // Filter to transactions that changed the document and aren't
      // reconcile (inbound) transactions.
      const outboundTxs = vu.transactions.filter(
        (tr) => tr.docChanged && !isReconcileTx(tr),
      );

      if (outboundTxs.length === 0) return;

      if (!canWriteSource()) return;

      const handle = getHandle();
      if (!handle) return;

      isProcessingOutbound = true;
      try {
        // Process each transaction in FORWARD order, but apply each
        // transaction's changes in REVERSE order (end → start).
        //
        // Forward across transactions: transaction N+1's positions assume
        // transaction N has already been applied (e.g., auto-close-tag
        // inserts "</div>" at position 13 AFTER the ">" was inserted at
        // position 12 by the preceding transaction).
        //
        // Reverse within a transaction: iterChanges reports fromA/toA in
        // pre-transaction coordinates. Applying end→start prevents earlier
        // positions from being shifted by later splices (multi-cursor,
        // replace-all, IME).
        //
        // The old code flattened ALL changes into one array and reversed
        // the entire thing — which broke when auto-close-tag created a
        // second transaction whose positions depended on the first.
        let aborted = false;
        for (const tr of outboundTxs) {
          if (aborted) break;

          const changes: Array<{
            fromA: number;
            toA: number;
            inserted: string;
          }> = [];

          tr.changes.iterChanges(
            (
              fromA: number,
              toA: number,
              _fromB: number,
              _toB: number,
              inserted,
            ) => {
              changes.push({
                fromA,
                toA,
                inserted: inserted.toString(),
              });
            },
          );

          // Apply this transaction's changes end → start.
          for (let i = changes.length - 1; i >= 0; i--) {
            const { fromA, toA, inserted } = changes[i];
            const deleteCount = toA - fromA;

            // Diagnostic: log splices near non-BMP characters (surrogate pairs).
            // Do not compare against the WASM source length here: the handle
            // has not applied this splice yet, so ordinary edits are expected
            // to differ from the post-transaction CodeMirror document.
            const docText = vu.state.doc.toString();
            const hasNonBMP = /[\uD800-\uDBFF]/.test(
              docText.slice(Math.max(0, fromA - 4), fromA + deleteCount + 4),
            );
            if (hasNonBMP) {
              const wasmSource = handle.get_cell_source(cellId) ?? "";
              logger.debug("[crdt-bridge] SPLICE", {
                cellId: cellId.slice(0, 8),
                fromA,
                toA,
                deleteCount,
                inserted: inserted.slice(0, 40),
                cmDocLen: docText.length,
                wasmSourceLen: wasmSource.length,
                nearbyChars: JSON.stringify(
                  docText.slice(
                    Math.max(0, fromA - 2),
                    fromA + deleteCount + 2,
                  ),
                ),
                nearbyCodePoints: [
                  ...docText.slice(
                    Math.max(0, fromA - 2),
                    fromA + deleteCount + 2,
                  ),
                ].map((c) => c.codePointAt(0)?.toString(16)),
              });
            }

            const ok = handle.splice_source(
              cellId,
              fromA,
              deleteCount,
              inserted,
            );
            if (!ok) {
              // Cell was deleted or handle is stale — abort all remaining.
              logger.warn(
                `[crdt-bridge] splice_source failed for cell=${cellId.slice(0, 8)} at ${fromA}..${toA}, aborting remaining splices`,
              );
              aborted = true;
              break;
            }
          }
        }

        if (aborted) {
          const source = handle.get_cell_source(cellId) ?? "";
          scheduleEditorReconcile(vu.view, source);
          notifySourceChangedNow(source);
          onSyncNeeded();
          return;
        }

        // Read the full source back from WASM for the cell store.
        // Coalesce the React store notification so multi-transaction edits
        // (IME, paired insertions, autocomplete) do not force repeated cell
        // re-renders before the browser can paint the accepted CodeMirror text.
        const source = handle.get_cell_source(cellId) ?? "";
        notifySourceChangedSoon(source);
        onSyncNeeded();
      } finally {
        isProcessingOutbound = false;
      }
    }

    destroy() {
      currentView = null;
      destroyed = true;
    }
  }

  const outboundGuard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || isReconcileTx(tr)) return tr;
    if (!canWriteSource()) return [];
    if (!getHandle()) return [];
    return tr;
  });

  const plugin = [outboundGuard, ViewPlugin.fromClass(CrdtBridgePlugin)];

  function scheduleEditorReconcile(view: EditorView, source: string): void {
    queueMicrotask(() => reconcileEditorToSource(view, source));
  }

  function notifySourceChangedSoon(source: string): void {
    pendingSource = source;
    if (sourceChangeScheduled) return;
    sourceChangeScheduled = true;
    queueMicrotask(() => {
      sourceChangeScheduled = false;
      if (destroyed) return;
      const source = pendingSource;
      pendingSource = null;
      if (source !== null) {
        onSourceChanged(source);
      }
    });
  }

  function notifySourceChangedNow(source: string): void {
    pendingSource = null;
    onSourceChanged(source);
  }

  function reconcileEditorToSource(view: EditorView, source: string): void {
    const currentSource = view.state.doc.toString();
    if (currentSource === source) return;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: source,
      },
      annotations: externalChangeAnnotation.of(true),
    });
  }

  // ── Inbound methods ──────────────────────────────────────────────

  function applyRemoteChanges(changes: RemoteChange[]): void {
    const view = currentView;
    if (!view || changes.length === 0) return;

    // Skip if we're in the middle of processing outbound changes.
    // The CRDT already has these changes from our splices; applying
    // them to CM would be an echo.
    if (isProcessingOutbound) {
      logger.debug(
        `[crdt-bridge] skipping ${changes.length} remote changes (outbound in progress) cell=${cellId.slice(0, 8)}`,
      );
      return;
    }

    // If CodeMirror and WASM are already in sync, skip — the changes
    // are already reflected. This guards against stale text_attributions
    // from delayed sync convergence (e.g., after the app returns from
    // background with multiple peers connected). Without this check,
    // patches computed from WASM's pre-merge state can have indices
    // that don't match CM's current state, wiping the user's edits.
    const handle = getHandle();
    if (handle) {
      const wasmSource = handle.get_cell_source(cellId);
      const cmSource = view.state.doc.toString();
      if (wasmSource === cmSource) {
        logger.debug(
          `[crdt-bridge] skipping ${changes.length} remote changes (already in sync) cell=${cellId.slice(0, 8)}`,
        );
        return;
      }
    }

    logger.debug(
      `[crdt-bridge] applying ${changes.length} remote changes to cell=${cellId.slice(0, 8)}`,
    );

    try {
      // Apply each change as a separate dispatch so positions are
      // cumulative (each change's index is relative to the doc state
      // after the previous dispatch), matching Automerge's patch ordering.
      for (const change of changes) {
        const docLen = view.state.doc.length;
        const spec: ChangeSpec[] = [];

        // Clamp indices to document bounds to prevent CM dispatch errors
        // if the editor state has diverged from the CRDT.
        const from = Math.min(change.index, docLen);

        if (change.deleted > 0 && change.text.length > 0) {
          // Replace: delete + insert at same position
          const to = Math.min(from + change.deleted, docLen);
          spec.push({ from, to, insert: change.text });
        } else if (change.deleted > 0) {
          // Pure deletion
          const to = Math.min(from + change.deleted, docLen);
          spec.push({ from, to });
        } else if (change.text.length > 0) {
          // Pure insertion
          spec.push({ from, insert: change.text });
        }

        if (spec.length > 0) {
          view.dispatch({
            changes: spec,
            annotations: externalChangeAnnotation.of(true),
          });
        }
      }
    } finally {
      // intentionally empty — structured for future error handling
    }
  }

  function applyFullSource(source: string): void {
    const view = currentView;
    if (!view) return;
    if (isProcessingOutbound) return;

    const currentContent = view.state.doc.toString();
    if (currentContent === source) return;

    logger.debug(
      `[crdt-bridge] applyFullSource cell=${cellId.slice(0, 8)} (${currentContent.length} → ${source.length} chars)`,
    );

    try {
      view.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: source,
        },
        annotations: externalChangeAnnotation.of(true),
      });
    } finally {
      // intentionally empty — structured for future error handling
    }
  }

  function replaceSource(source: string): boolean {
    if (!canWriteSource()) return false;

    const handle = getHandle();
    if (!handle) return false;

    // 1. Update the CRDT via full-text Myers diff (correct for bulk replacement).
    const updated = handle.update_source(cellId, source);
    if (!updated) return false;

    // 2. Update CodeMirror (reconcile-annotated so the outbound path skips it).
    applyFullSource(source);

    // 3. Update the cell store for non-CM consumers.
    notifySourceChangedNow(source);

    // 4. Trigger sync to daemon.
    onSyncNeeded();

    return true;
  }

  return {
    extension: plugin,
    applyRemoteChanges,
    applyFullSource,
    replaceSource,
    getView: () => currentView,
  };
}
