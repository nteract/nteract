/**
 * Stub runtimed WASM module for exercising the runtimed-wasm-client
 * bindings (load + set_actor + free) without building real WASM.
 *
 * Mirrors the module surface initializeRuntimedWasmClient touches: a
 * default init function, project_markdown_json, and NotebookHandle.
 */

export const stubCalls: { freedHandles: StubNotebookHandle[] } = { freedHandles: [] };

export default async function init(_options: { module_or_path: unknown }): Promise<void> {}

export function project_markdown_json(): null {
  return null;
}

export class StubNotebookHandle {
  loadedBytes: Uint8Array = new Uint8Array(0);
  actors: string[] = [];
  freed = 0;

  static load(bytes: Uint8Array): StubNotebookHandle {
    const handle = new StubNotebookHandle();
    handle.loadedBytes = bytes;
    return handle;
  }

  set_actor(label: string): void {
    this.actors.push(label);
    if (label.startsWith("throw:")) {
      throw new Error("synthetic set_actor failure");
    }
  }

  free(): void {
    this.freed += 1;
    stubCalls.freedHandles.push(this);
  }
}

export { StubNotebookHandle as NotebookHandle };
