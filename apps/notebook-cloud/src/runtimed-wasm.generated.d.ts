declare module "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js" {
  export default function init(moduleOrPath?: {
    module_or_path: unknown | Promise<unknown>;
  }): Promise<unknown>;
  export function decode_presence_frame(payload: Uint8Array): unknown;
  export function encode_cursor_presence(
    peerId: string,
    peerLabel: string,
    actorLabel: string,
    cellId: string,
    line: number,
    column: number,
  ): Uint8Array;
  export function encode_heartbeat_presence(peerId: string): Uint8Array;
  export function encode_interaction_presence(
    peerId: string,
    peerLabel: string,
    actorLabel: string,
    target: unknown,
  ): Uint8Array;
  export function encode_presence_frame(message: unknown): Uint8Array;
  export function encode_selection_presence(
    peerId: string,
    peerLabel: string,
    actorLabel: string,
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ): Uint8Array;
  export function rewrite_presence_ingress(
    payload: Uint8Array,
    peerId: string,
    peerLabel: string,
    principal: string,
    fallbackOperator: string,
  ): Uint8Array;

  export class NotebookHandle {
    constructor(notebookId: string);
    static create_bootstrap(actorLabel: string): NotebookHandle;
    static load_snapshot(notebookBytes: Uint8Array, runtimeStateBytes: Uint8Array): NotebookHandle;
    add_cell_after(
      cellId: string,
      cellType: "code" | "markdown" | "raw",
      afterCellId?: string | null,
    ): string;
    cell_count(): number;
    cancel_last_flush(): void;
    cancel_last_comms_doc_flush(): void;
    cancel_last_pool_state_flush(): void;
    cancel_last_runtime_state_flush(): void;
    flush_comms_doc_sync(): Uint8Array | undefined;
    flush_local_changes(): Uint8Array | undefined;
    flush_pool_state_sync(): Uint8Array | undefined;
    flush_runtime_state_sync(): Uint8Array | undefined;
    generate_comms_doc_sync_reply(): Uint8Array | undefined;
    generate_pool_state_sync_reply(): Uint8Array | undefined;
    generate_runtime_state_sync_reply(): Uint8Array | undefined;
    get_cells_json(): string;
    get_comms_state(): unknown;
    get_dependency_fingerprint(): string | undefined;
    get_heads_hex(): string[];
    get_metadata_snapshot_json(): string | undefined;
    get_runtime_state_doc_id(): string | undefined;
    get_runtime_state(): unknown;
    load_comms_doc(commsBytes: Uint8Array): void;
    move_cell(cellId: string, afterCellId?: string | null): string;
    delete_cell(cellId: string): boolean;
    get_runtime_state_heads_hex(): string[];
    receive_frame(frameBytes: Uint8Array): unknown;
    reset_sync_state(): void;
    resolve_comm_state(commId: string): unknown;
    set_actor(actorLabel: string): void;
    set_blob_port(port: number): void;
    set_runtime_state_doc_id(runtimeStateDocId: string): void;
    set_comm_state_batch(commId: string, patchJson: string): boolean;
    set_comm_state_property(commId: string, key: string, valueJson: string): boolean;
    update_source(cellId: string, source: string): boolean;
    free(): void;
  }

  export class RoomHostHandle {
    static create_empty(notebookId: string, actorLabel: string): RoomHostHandle;
    static load_snapshot(notebookBytes: Uint8Array, runtimeStateBytes: Uint8Array): RoomHostHandle;
    get_comms_doc_heads_hex(): string[];
    get_heads_hex(): string[];
    get_runtime_state_heads_hex(): string[];
    load_comms_doc(commsBytes: Uint8Array): void;
    receive_peer_frame(
      peerId: string,
      principal: string,
      connectionScope: "viewer" | "editor" | "runtime_peer" | "owner",
      canWriteAllNotebookChanges: boolean,
      frameBytes: Uint8Array,
    ): unknown;
    remove_peer(peerId: string): void;
    save_notebook(): Uint8Array;
    save_comms_doc(): Uint8Array;
    save_runtime_state_doc(): Uint8Array;
    seed_initial_code_cell_if_empty(cellId: string): boolean;
    sync_peer(
      peerId: string,
      connectionScope: "viewer" | "editor" | "runtime_peer" | "owner",
    ): unknown;
    free(): void;
  }

  export class RuntimeStatePeerHandle {
    constructor(actorLabel: string);
    append_output_json(executionId: string, manifestJson: string): string;
    cancel_last_comms_doc_flush(): void;
    cancel_last_runtime_state_flush(): void;
    create_execution(executionId: string): void;
    create_execution_with_source(executionId: string, source: string, seq: number): boolean;
    flush_comms_doc_sync(): Uint8Array | undefined;
    flush_runtime_state_sync(): Uint8Array | undefined;
    generate_comms_doc_sync_reply(): Uint8Array | undefined;
    generate_runtime_state_sync_reply(): Uint8Array | undefined;
    put_comm_json(
      commId: string,
      targetName: string,
      modelModule: string,
      modelName: string,
      stateJson: string,
      seq: number,
    ): void;
    receive_frame(frameBytes: Uint8Array): unknown;
    save(): Uint8Array;
    save_comms_doc(): Uint8Array;
    set_actor(actorLabel: string): void;
    set_execution_count(executionId: string, executionCount: number): void;
    set_execution_done(executionId: string, success: boolean): void;
    set_execution_running(executionId: string): void;
    free(): void;
  }
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
