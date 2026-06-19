/**
 * SyncableHandle — minimal interface for the WASM NotebookHandle.
 *
 * The SyncEngine operates against this interface rather than the concrete
 * WASM class, enabling testing with mocks and future alternative
 * implementations.
 *
 * Methods mirror the subset of `NotebookHandle` used by the sync pipeline.
 * Most cell mutation methods (update_source, etc.) are NOT part of this
 * interface — they're used directly by consumers, not the engine. Optional
 * changeset-returning wrappers are declared here for feature detection.
 */

import type { CellChangeset } from "./cell-changeset";

// ── Session status ───────────────────────────────────────────────────

export type NotebookDocPhase = "pending" | "syncing" | "interactive";

export type RuntimeStatePhase = "pending" | "syncing" | "ready";

export type InitialLoadPhase =
  | { phase: "not_needed" }
  | { phase: "streaming" }
  | { phase: "ready" }
  | { phase: "failed"; reason: string };

export interface SessionStatus {
  notebook_doc: NotebookDocPhase;
  runtime_state: RuntimeStatePhase;
  initial_load: InitialLoadPhase;
}

// ── FrameEvent ───────────────────────────────────────────────────────

/** Attribution for text changes, produced by WASM sync. */
export interface TextAttribution {
  cell_id: string;
  index: number;
  text: string;
  deleted: number;
  actors: string[];
}

export interface ExecutionViewSnapshot {
  execution_count: number | null;
  status: "queued" | "running" | "done" | "error" | "cancelled" | (string & {});
  success: boolean | null;
  output_ids: string[];
  submitted_by_actor_label?: string | null;
}

export interface ExecutionQueueProjection {
  executing_execution_id?: string | null;
  queued_execution_ids: string[];
  notebook?: {
    executing_cell_id?: string | null;
    queued_cell_ids: string[];
  } | null;
}

export interface ExecutionViewChangeset {
  cell_pointer_changes?: Array<[cell_id: string, execution_id: string | null]>;
  execution_upserts?: Array<[execution_id: string, snapshot: ExecutionViewSnapshot]>;
  removed_execution_ids?: string[];
  queue?: ExecutionQueueProjection;
}

export interface CommsState {
  comms: Record<string, Record<string, unknown>>;
}

export type CommentAnchor =
  | { kind: "notebook" }
  | { kind: "cell"; cell_id: string; observed_cell_position?: string | null }
  | {
      kind: "cell_range";
      start_cell_id: string;
      end_cell_id: string;
      start_position?: string | null;
      end_position?: string | null;
    }
  | {
      kind: "source_range";
      cell_id: string;
      start_line: number;
      start_column: number;
      end_line: number;
      end_column: number;
      prefix_quote?: string | null;
      exact_quote?: string | null;
      suffix_quote?: string | null;
    }
  | {
      kind: "output";
      cell_id: string;
      execution_id?: string | null;
      output_id?: string | null;
    };

export type CommentThreadStatus = "open" | "resolved";

export interface CommentMessageSnapshot {
  id: string;
  position: string;
  body: string;
  created_at: string;
  created_by_actor_label?: string | null;
}

export interface CommentThreadSnapshot {
  id: string;
  anchor: CommentAnchor;
  position: string;
  status: CommentThreadStatus;
  messages: CommentMessageSnapshot[];
  badge_cell_ids: string[];
  created_at: string;
  created_by_actor_label?: string | null;
  resolved_at?: string | null;
  resolved_by_actor_label?: string | null;
}

export interface CommentsProjection {
  comments_doc_id: string;
  threads: CommentThreadSnapshot[];
}

/**
 * Typed event returned by WASM `receive_frame()`.
 *
 * Event types:
 * - `sync_applied` — Automerge sync message applied successfully
 * - `broadcast` — Daemon broadcast (kernel status, output, etc.)
 * - `presence` — Remote peer presence update
 * - `session_control` — Connection-local readiness / bootstrap status
 * - `runtime_state_sync_applied` — RuntimeStateDoc sync applied
 * - `comms_doc_sync_applied` — CommsDoc sync applied
 * - `comments_doc_sync_applied` — CommentsDoc sync applied
 * - `sync_error` — Sync failed, doc rebuilt + sync state normalized, reply restarts negotiation
 * - `runtime_state_sync_error` — RuntimeState sync failed, same recovery pattern
 * - `comms_doc_sync_error` — CommsDoc sync failed, same recovery pattern
 * - `comments_doc_sync_error` — CommentsDoc sync failed, same recovery pattern
 * - `unknown` — Unrecognized frame type
 */
export interface FrameEvent {
  type: string;
  changed?: boolean;
  changeset?: CellChangeset;
  attributions?: TextAttribution[];
  /** Inline sync reply bytes from receive_frame (#1067 fix).
   *  Also used for recovery replies in sync_error / runtime_state_sync_error events. */
  reply?: number[];
  payload?: unknown;
  /** RuntimeState from RuntimeStateSyncApplied. */
  state?: unknown;
  /** CommentsProjection from CommentsDocSyncApplied. */
  projection?: CommentsProjection;
  /** Connection-local session status from SESSION_CONTROL frames. */
  status?: SessionStatus;
  /**
   * Per-output diff for RuntimeStateSyncApplied events. Each `changed` entry
   * is `[output_id, narrowed_manifest]` — manifests are already MIME-narrowed
   * + ContentRef-resolved so the frontend's outputs store can write them
   * directly. `removed` lists output_ids no longer present in any execution.
   */
  output_changeset?: {
    changed?: Array<[string, unknown]>;
    removed?: string[];
  };
  /**
   * Cross-document execution view diff produced by the shared Rust projector.
   * NotebookDoc owns cell -> execution_id pointers; RuntimeStateDoc owns
   * execution snapshots.
   */
  execution_view_changeset?: ExecutionViewChangeset;
}

export interface LocalMutationResult<T = unknown> {
  result: T;
  event?: FrameEvent;
}

// ── SyncableHandle ───────────────────────────────────────────────────

export interface SyncableHandle {
  /**
   * Process an inbound frame from the daemon.
   *
   * Returns an array of typed events (sync_applied, broadcast, presence,
   * session_control, runtime_state_sync_applied, unknown).
   */
  receive_frame(bytes: Uint8Array): FrameEvent[] | null;

  /**
   * Flush local Automerge changes into a sync message.
   *
   * Returns the message bytes, or null if there are no pending changes.
   * Advances internal sync state (sent_hashes) — call `cancel_last_flush()`
   * if the send fails.
   */
  flush_local_changes(): Uint8Array | null;

  /**
   * Roll back the sync state advanced by the last `flush_local_changes()`.
   *
   * Prevents sent_hashes from permanently filtering out change data
   * the daemon never received.
   */
  cancel_last_flush(): void;

  /**
   * Flush RuntimeStateDoc sync message.
   *
   * Returns the message bytes, or null if there are no pending changes.
   */
  flush_runtime_state_sync(): Uint8Array | null;

  /** Roll back the last RuntimeStateDoc flush. */
  cancel_last_runtime_state_flush(): void;

  /** Generate a sync reply for the RuntimeStateDoc. */
  generate_runtime_state_sync_reply(): Uint8Array | null;

  /**
   * Flush CommsDoc sync message.
   *
   * Returns the message bytes, or null if there are no pending changes.
   */
  flush_comms_doc_sync(): Uint8Array | null;

  /** Roll back the last CommsDoc flush. */
  cancel_last_comms_doc_flush(): void;

  /** Generate a sync reply for the CommsDoc. */
  generate_comms_doc_sync_reply(): Uint8Array | null;

  /**
   * Flush CommentsDoc sync message.
   *
   * Returns null when comments are not initialized or there is no pending
   * sync message.
   */
  flush_comments_doc_sync?(): Uint8Array | null;

  /** Roll back the last CommentsDoc flush. */
  cancel_last_comments_doc_flush?(): void;

  /** Generate a sync reply for the CommentsDoc. */
  generate_comments_doc_sync_reply?(): Uint8Array | null;

  /**
   * Flush PoolDoc sync message.
   *
   * Returns the message bytes, or null if there are no pending changes.
   */
  flush_pool_state_sync(): Uint8Array | null;

  /** Roll back the last PoolDoc flush. */
  cancel_last_pool_state_flush(): void;

  /** Generate a sync reply for the PoolDoc. */
  generate_pool_state_sync_reply(): Uint8Array | null;

  /** Reset sync state so the next flush requests the full document. */
  reset_sync_state(): void;

  /** Number of cells in the document. */
  cell_count(): number;

  /** Current Automerge notebook document heads as hex strings. */
  get_heads_hex(): string[];

  /** Dependency metadata fingerprint covered by trust approval. */
  get_dependency_fingerprint(): string | undefined;

  /**
   * Read the current RuntimeStateDoc snapshot from the handle.
   *
   * Optional: used by projection replays to recover from adapter bootstrap
   * races where the handle has already applied sync frames before subscribers
   * attach to the engine observables.
   */
  get_runtime_state?(): unknown;

  /**
   * Read the current CommsDoc snapshot from the handle.
   *
   * Optional for the same reason as `get_runtime_state`.
   */
  get_comms_state?(): unknown;

  /** Read the current CommentsDoc projection from the handle. */
  get_comments_projection?(): CommentsProjection | undefined;

  /** Current CommentsDoc heads as hex strings. */
  get_comments_doc_heads_hex?(): string[];

  /** Initialize CommentsDoc sync from daemon-provided room identity. */
  init_comments_sync_target?(commentsDocId: string): void;

  /** Create a local comment thread. */
  create_comment_thread?(
    threadId: string,
    messageId: string,
    anchor: CommentAnchor,
    body: string,
    afterThreadId: string | null | undefined,
    createdAt: string,
  ): FrameEvent;

  /** Demote a comment thread to a notebook-level comment. */
  demote_comment_thread_to_notebook?(threadId: string): void;

  /** Add a local reply to a comment thread. */
  reply_comment_thread?(
    threadId: string,
    messageId: string,
    body: string,
    afterMessageId: string | null | undefined,
    createdAt: string,
  ): FrameEvent;

  /** Resolve a comment thread. */
  resolve_comment_thread?(threadId: string, resolvedAt: string): FrameEvent;

  /** Reopen a resolved comment thread. */
  reopen_comment_thread?(threadId: string): FrameEvent;

  /**
   * Resolve ContentRef values in a comm's state.
   *
   * Returns `{ state, buffer_paths, text_paths }` where blob ContentRefs are
   * replaced with plain URL strings and inline ContentRefs are unwrapped.
   * `buffer_paths` records JSON paths for binary blobs (caller fetches as
   * ArrayBuffer for ipywidgets buffer handling). `text_paths` records JSON
   * paths for text blobs (caller must fetch and substitute the decoded
   * string in place before delivering state to widget code).
   *
   * Returns undefined if blob_port is not set or the comm doesn't exist.
   *
   * Optional — implementations that don't support comm state resolution
   * (e.g. test mocks) may omit this method.
   */
  resolve_comm_state?(comm_id: string):
    | {
        state: Record<string, unknown>;
        buffer_paths: string[][];
        text_paths?: string[][];
      }
    | undefined;

  /**
   * Project pending execution-view changes after local notebook mutations or
   * initial materialization. Same shape as FrameEvent.execution_view_changeset.
   *
   * Optional so tests and non-WASM handles can omit it until they consume the
   * shared projection.
   */
  project_execution_view_changeset?(): ExecutionViewChangeset | undefined;

  /**
   * Serialize every NotebookDoc change that is not a transitive dependency
   * of the given heads (empty heads = the full compressed save). Stateless;
   * callers own the heads bookkeeping. Optional: older deployed bundles
   * and test mocks may omit it — the cloud tab bridge checks for it at
   * arm time (`createCloudNotebookTabBridge` returns null without it)
   * and the chunked persistence controller only arms alongside the same
   * bundle that ships the export.
   */
  save_since_heads?(heads_hex: string[]): Uint8Array;

  /**
   * Apply serialized NotebookDoc changes (from `save_since_heads` or a full
   * save) and return the same `sync_applied`-shaped event `receive_frame`
   * produces — `changed` via heads compare, one diff_doc changeset,
   * attributions, execution-view changeset, never a `reply`. Known changes
   * dedupe to `changed: false`. Optional for the same reason as above.
   */
  apply_change_bytes?(bytes: Uint8Array): FrameEvent | undefined;

  add_cell_after_with_changeset?(
    cell_id: string,
    cell_type: string,
    after_cell_id?: string | null,
  ): LocalMutationResult<string>;

  move_cell_with_changeset?(
    cell_id: string,
    after_cell_id?: string | null,
  ): LocalMutationResult<string>;

  delete_cell_with_changeset?(cell_id: string): LocalMutationResult<boolean>;

  clear_outputs_with_changeset?(cell_id: string): LocalMutationResult<boolean>;

  set_cell_source_hidden_with_changeset?(
    cell_id: string,
    hidden: boolean,
  ): LocalMutationResult<boolean>;

  set_cell_outputs_hidden_with_changeset?(
    cell_id: string,
    hidden: boolean,
  ): LocalMutationResult<boolean>;
}
