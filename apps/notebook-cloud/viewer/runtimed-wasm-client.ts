import {
  notebookInteractionTargetToPresenceTarget,
  type NotebookInteractionTarget,
} from "runtimed";
import { setMarkdownProjectionProjector } from "../../../src/lib/markdown-projection";
import type { NotebookHandle } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

type RuntimedWasmModule = typeof import("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js");
type WasmModuleOrPath = string | URL | Request | Response | ArrayBuffer | WebAssembly.Module;

let loadedModule: Promise<RuntimedWasmModule> | undefined;
let loadedModuleSource: string | undefined;
let initialized: Promise<RuntimedWasmModule> | undefined;
let initializedSource: string | undefined;
let resolvedModule: RuntimedWasmModule | undefined;

type RuntimedWasmModuleImporter = (href: string) => Promise<RuntimedWasmModule>;

const defaultModuleImporter: RuntimedWasmModuleImporter = (href) =>
  import(/* @vite-ignore */ href) as Promise<RuntimedWasmModule>;

let importModule: RuntimedWasmModuleImporter = defaultModuleImporter;

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

export async function loadNotebookHandleFromBytes(
  notebookBytes: Uint8Array,
  actorLabel: string,
  modulePath: string | URL,
  moduleOrPath: WasmModuleOrPath,
): Promise<NotebookHandle> {
  const module = await initializeRuntimedWasmClient(modulePath, moduleOrPath);
  const handle = module.NotebookHandle.load(notebookBytes);
  try {
    // load() restores NotebookDoc bytes only (state/comms docs start empty)
    // and leaves a random actor — the connection's label must be set before
    // any authoring. Actor labels must never be reused across doc instances
    // (DuplicateSeqNumber); freshness comes from the CLIENT-minted operator
    // nonce (`browser:<sessionId>`, re-minted per connect effect run) — the
    // worker only rewrites the principal segment, it does not mint the
    // operator. Keep sessionId per-run or this invariant silently breaks.
    handle.set_actor(actorLabel);
  } catch (error) {
    handle.free();
    throw error;
  }
  return handle;
}

export async function loadSnapshotPairHandle(
  notebookBytes: Uint8Array,
  runtimeStateBytes: Uint8Array,
  commsBytes: Uint8Array | undefined,
  modulePath: string | URL,
  moduleOrPath: WasmModuleOrPath,
): Promise<NotebookHandle> {
  const module = await initializeRuntimedWasmClient(modulePath, moduleOrPath);
  const handle = module.NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
  if (commsBytes) {
    handle.load_comms_doc(commsBytes);
  }
  return handle;
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
  if (!loadedModule) {
    // Cache by REQUESTED href, and clear the cache when the import rejects:
    // a pinned rejected promise would turn one transient failure into a
    // permanent one — every later attempt (manual retry, reconnect) would
    // re-await the same rejection for the life of the page.
    const pending = importModule(href).catch((error: unknown) => {
      if (loadedModule === pending) {
        loadedModule = undefined;
        loadedModuleSource = undefined;
      }
      throw error;
    });
    loadedModule = pending;
  }
  return loadedModule;
}

/**
 * Swap the dynamic `import()` used for the runtimed WASM module. Node test
 * runners cannot intercept real dynamic imports, so retry/caching tests
 * inject failures here. Pass `null` to restore the real importer.
 * @internal
 */
export function _setRuntimedWasmModuleImporterForTests(
  importer: ((href: string) => Promise<unknown>) | null,
): void {
  importModule = (importer as RuntimedWasmModuleImporter | null) ?? defaultModuleImporter;
}

/**
 * Reset the module-level load/init caches between tests.
 * @internal
 */
export function _resetRuntimedWasmClientForTests(): void {
  loadedModule = undefined;
  loadedModuleSource = undefined;
  initialized = undefined;
  initializedSource = undefined;
  resolvedModule = undefined;
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
