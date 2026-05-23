declare module "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js" {
  export default function init(moduleOrPath?: unknown): Promise<unknown>;
  export function decode_presence_frame(payload: Uint8Array): unknown;
  export function encode_presence_frame(message: unknown): Uint8Array;
  export function rewrite_presence_ingress(
    payload: Uint8Array,
    peerId: string,
    peerLabel: string,
    principal: string,
    fallbackOperator: string,
  ): Uint8Array;

  export class NotebookHandle {
    static load_snapshot(notebookBytes: Uint8Array, runtimeStateBytes: Uint8Array): NotebookHandle;
    get_cells_json(): string;
    get_heads_hex(): string;
    get_metadata_snapshot_json(): string | undefined;
    get_runtime_state_heads_hex(): string;
    free(): void;
  }
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
