import {
  notebookInteractionTargetToPresenceTarget,
  type NotebookInteractionTarget,
} from "runtimed";
import { setMarkdownProjectionProjector } from "../../notebook/src/lib/markdown-projection";
import type { NotebookHandle } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

type RuntimedWasmModule = typeof import("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js");
type WasmModuleOrPath = string | URL | Request | Response | ArrayBuffer | WebAssembly.Module;

let loadedModule: Promise<RuntimedWasmModule> | undefined;
let loadedModuleSource: string | undefined;
let initialized: Promise<RuntimedWasmModule> | undefined;
let initializedSource: string | undefined;
let resolvedModule: RuntimedWasmModule | undefined;

export async function initializeRuntimedWasmClient(
  modulePath: string | URL,
  moduleOrPath: WasmModuleOrPath,
): Promise<RuntimedWasmModule> {
  const source = wasmSourceLabel(moduleOrPath);
  if (initialized && initializedSource !== source) {
    return Promise.reject(
      new Error(
        `runtimed WASM is already initialized from ${initializedSource}; refusing ${source}`,
      ),
    );
  }

  initializedSource = source;
  initialized ??= loadRuntimedWasmModule(modulePath)
    .then(async (module) => {
      await module.default({ module_or_path: moduleOrPath });
      setMarkdownProjectionProjector(module.project_markdown_json);
      resolvedModule = module;
      return module;
    })
    .catch((error: unknown) => {
      initialized = undefined;
      initializedSource = undefined;
      resolvedModule = undefined;
      throw error;
    });
  return initialized;
}

export async function createBootstrapNotebookHandle(
  actorLabel: string,
  modulePath: string | URL,
  moduleOrPath: WasmModuleOrPath,
): Promise<NotebookHandle> {
  const module = await initializeRuntimedWasmClient(modulePath, moduleOrPath);
  return module.NotebookHandle.create_bootstrap(actorLabel);
}

export async function loadSnapshotPairHandle(
  notebookBytes: Uint8Array,
  runtimeStateBytes: Uint8Array,
  modulePath: string | URL,
  moduleOrPath: WasmModuleOrPath,
): Promise<NotebookHandle> {
  const module = await initializeRuntimedWasmClient(modulePath, moduleOrPath);
  return module.NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
}

export function encodeHeartbeatPresenceAfterInit(peerId: string): Uint8Array {
  return runtimedWasmModuleAfterInit().encode_heartbeat_presence(peerId);
}

export function encodeCursorPresenceAfterInit(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  cellId: string,
  line: number,
  column: number,
): Uint8Array {
  return runtimedWasmModuleAfterInit().encode_cursor_presence(
    peerId,
    peerLabel,
    actorLabel,
    cellId,
    line,
    column,
  );
}

export function encodeSelectionPresenceAfterInit(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  cellId: string,
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): Uint8Array {
  return runtimedWasmModuleAfterInit().encode_selection_presence(
    peerId,
    peerLabel,
    actorLabel,
    cellId,
    anchorLine,
    anchorCol,
    headLine,
    headCol,
  );
}

export function encodeInteractionPresenceAfterInit(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  target: NotebookInteractionTarget,
): Uint8Array {
  return runtimedWasmModuleAfterInit().encode_interaction_presence(
    peerId,
    peerLabel,
    actorLabel,
    notebookInteractionTargetToPresenceTarget(target),
  );
}

export type { NotebookHandle };

function loadRuntimedWasmModule(modulePath: string | URL): Promise<RuntimedWasmModule> {
  const href = typeof modulePath === "string" ? modulePath : modulePath.href;
  if (loadedModule && loadedModuleSource !== href) {
    return Promise.reject(
      new Error(
        `runtimed WASM module is already loaded from ${loadedModuleSource}; refusing ${href}`,
      ),
    );
  }

  loadedModuleSource = href;
  loadedModule ??= import(/* @vite-ignore */ href) as Promise<RuntimedWasmModule>;
  return loadedModule;
}

function runtimedWasmModuleAfterInit(): RuntimedWasmModule {
  if (!resolvedModule) {
    throw new Error("runtimed WASM is not initialized");
  }
  return resolvedModule;
}

function wasmSourceLabel(moduleOrPath: WasmModuleOrPath): string {
  if (typeof moduleOrPath === "string") return moduleOrPath;
  if (moduleOrPath instanceof URL) return moduleOrPath.href;
  if (typeof Request !== "undefined" && moduleOrPath instanceof Request) return moduleOrPath.url;
  if (typeof Response !== "undefined" && moduleOrPath instanceof Response) {
    return moduleOrPath.url || "[response]";
  }
  if (moduleOrPath instanceof WebAssembly.Module) return "[webassembly-module]";
  return "[wasm-bytes]";
}
