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
let fetchImpl: typeof fetch = (input, init) => fetch(input, init);

/**
 * Retry ladder shared by the module import and the .wasm binary fetch —
 * the blob-resolver shape with one extra rung for the heavier asset.
 * 404 is deliberately retryable: freshly deployed hashed assets propagate
 * eventually, exactly like fresh blobs.
 */
const RUNTIMED_WASM_RETRY_DELAYS_MS = [150, 500, 1500];

/**
 * Hashed deploys keep stable-name copies (`runtimed_wasm.js` /
 * `runtimed_wasm_bg.wasm`) alongside the content-hashed files precisely so
 * a viewer holding a stale hashed URL across a deploy window can fall back.
 */
const CONTENT_HASHED_RUNTIMED_ASSET_RE = /^(.+)\.[a-f0-9]{12,64}(\.(?:js|wasm))$/;

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
      await module.default({ module_or_path: await resolveRuntimedWasmBinary(moduleOrPath) });
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
    const pending = importRuntimedWasmModuleWithRecovery(href).catch((error: unknown) => {
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

async function importRuntimedWasmModuleWithRecovery(href: string): Promise<RuntimedWasmModule> {
  try {
    return await importRuntimedWasmModuleWithRetries(href);
  } catch (error) {
    const stableHref = stableRuntimedAssetHref(href);
    if (!stableHref) throw error;
    console.warn(
      `[notebook-cloud] runtimed WASM module failed from ${href}; falling back to ${stableHref}`,
      error,
    );
    return importRuntimedWasmModuleWithRetries(stableHref);
  }
}

async function importRuntimedWasmModuleWithRetries(href: string): Promise<RuntimedWasmModule> {
  let lastFailure: unknown = null;
  // import() exposes no response status — every failure shape (network
  // error, 404 mid-deploy, MIME rejection) surfaces as a rejection, so the
  // whole ladder applies.
  for (let attempt = 0; attempt <= RUNTIMED_WASM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await importModule(href);
    } catch (error) {
      lastFailure = error;
    }
    const delay = RUNTIMED_WASM_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

/**
 * Resolve the wasm-bindgen `module_or_path` input. URL-shaped inputs are
 * fetched here (instead of inside wasm-bindgen's init) so the ladder and
 * the hashed→stable fallback cover the binary exactly like the module;
 * everything else (Response, ArrayBuffer, compiled module) passes through.
 */
async function resolveRuntimedWasmBinary(
  moduleOrPath: WasmModuleOrPath,
): Promise<WasmModuleOrPath> {
  if (typeof moduleOrPath !== "string" && !(moduleOrPath instanceof URL)) {
    return moduleOrPath;
  }
  const href = typeof moduleOrPath === "string" ? moduleOrPath : moduleOrPath.href;
  if (!isLadderFetchableHref(href)) {
    // Non-network schemes (file:, data:, blob: in tests/embeddings) go
    // straight to wasm-bindgen; the ladder exists for HTTP asset origins.
    return moduleOrPath;
  }
  try {
    return await fetchRuntimedWasmBinaryWithRetries(href);
  } catch (error) {
    const stableHref = stableRuntimedAssetHref(href);
    if (!stableHref) throw error;
    console.warn(
      `[notebook-cloud] runtimed WASM binary failed from ${href}; falling back to ${stableHref}`,
      error,
    );
    return fetchRuntimedWasmBinaryWithRetries(stableHref);
  }
}

async function fetchRuntimedWasmBinaryWithRetries(href: string): Promise<Response> {
  let lastFailure: unknown = null;
  for (let attempt = 0; attempt <= RUNTIMED_WASM_RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetchImpl(href);
    } catch (error) {
      // Thrown fetch errors (network drop, DNS, CORS) are always retryable.
      lastFailure = error;
    }
    if (response) {
      if (response.ok) return response;
      const failure = new Error(`Failed to fetch runtimed WASM (${response.status}): ${href}`);
      if (!shouldRetryRuntimedWasmResponse(response)) throw failure;
      lastFailure = failure;
      await cancelResponseBody(response);
    }
    const delay = RUNTIMED_WASM_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

function shouldRetryRuntimedWasmResponse(response: Response): boolean {
  return (
    response.status === 404 ||
    response.status === 409 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort; a failed cancel should not mask the retryable response.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLadderFetchableHref(href: string): boolean {
  // Bare and root-relative paths resolve against the page origin (http/s).
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
  return !hasScheme || href.startsWith("http:") || href.startsWith("https:");
}

/**
 * `runtimed_wasm.<sha16>.js` → `runtimed_wasm.js` (same directory, query
 * preserved). Returns null when the name carries no content hash — stable
 * names have nowhere further to fall.
 */
function stableRuntimedAssetHref(href: string): string | null {
  const suffixIndex = href.search(/[?#]/);
  const path = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : href.slice(suffixIndex);
  const nameIndex = path.lastIndexOf("/") + 1;
  const match = CONTENT_HASHED_RUNTIMED_ASSET_RE.exec(path.slice(nameIndex));
  if (!match) return null;
  return `${path.slice(0, nameIndex)}${match[1]}${match[2]}${suffix}`;
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
 * Swap the fetch used for the .wasm binary ladder. Pass `null` to restore
 * the global fetch.
 * @internal
 */
export function _setRuntimedWasmFetchForTests(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((input, init) => fetch(input, init));
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
