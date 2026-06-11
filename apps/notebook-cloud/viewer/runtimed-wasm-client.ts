import {
  notebookInteractionTargetToPresenceTarget,
  type NotebookInteractionTarget,
} from "runtimed";
import { setMarkdownProjectionProjector } from "../../../src/lib/markdown-projection";
import type { NotebookHandle } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { asRuntimedWasmAssetFailure } from "./runtimed-wasm-failure";

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
 *
 * Bounds (accepted): the ladders are sequential (module, then binary) and
 * each name tier runs its own ladder, so a fully-skewed page (hashed module
 * AND hashed binary both falling back to stable) pays ~4.3s of sleeps plus
 * up to ~10 round trips before a NotebookHandle exists. The healthy path
 * pays zero sleeps. Each rung is also time-bounded (see
 * RUNTIMED_WASM_RUNG_TIMEOUT_MS) so a black-holed request becomes a failed
 * rung instead of wedging the shared init promise forever.
 */
const RUNTIMED_WASM_RETRY_DELAYS_MS = [150, 500, 1500];

/**
 * Per-rung time bound. A stalled (slow-loris) attempt that never settles
 * would otherwise park every caller — including retryLiveConnection, which
 * awaits the same cached singleton promise — in a permanent loading state.
 * fetch rungs also get an AbortSignal so the network request is actually
 * cancelled; import() cannot be aborted, so its rung is abandoned via the
 * same race and left to the module map.
 */
const RUNTIMED_WASM_RUNG_TIMEOUT_MS = 20_000;

/**
 * Hashed deploys keep stable-name copies (`runtimed_wasm.js` /
 * `runtimed_wasm_bg.wasm`) alongside the content-hashed files precisely so
 * a viewer holding a stale hashed URL across a deploy window can fall back.
 */
const CONTENT_HASHED_RUNTIMED_ASSET_RE = /^(.+)\.[a-f0-9]{12,64}(\.(?:js|wasm))$/;

/**
 * True when the currently cached module was imported from the STABLE name
 * after its hashed name failed. The module and binary must fall back as a
 * PAIR: hashed wasm-bindgen glue against a stable binary (or vice versa)
 * is exactly the silent missing-export skew class from PR #3416.
 */
let moduleLoadedFromStableFallback = false;

/**
 * Monotonic cache-buster for module import retries. Same-specifier
 * import() retries are served from the browser module map — the HTML spec
 * caches FAILED module fetches for the life of the page (whatwg/html#6768)
 * and Chromium/WebKit conform — so rungs >= 1 would replay the pinned
 * rejection without touching the network. A unique query per retry rung
 * forces a fresh fetch; the module is side-effect-light glue, so a second
 * evaluation under a different specifier is benign, and
 * stableRuntimedAssetHref preserves queries on fallback.
 */
let moduleImportBusterSequence = 0;

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
      const binary = await resolveRuntimedWasmBinary(moduleOrPath);
      if (binary.usedStableFallback && !moduleLoadedFromStableFallback) {
        // Couple the fallback decision: the binary fell back to its stable
        // copy, so the (hashed) glue must follow or the pair can silently
        // mix deploys (#3416's missing-export class).
        module = await reloadModuleFromStablePair(module);
      }
      await module.default({ module_or_path: binary.value });
      setMarkdownProjectionProjector(module.project_markdown_json);
      resolvedModule = module;
      return module;
    })
    .catch((error: unknown) => {
      initialized = undefined;
      initializedSource = undefined;
      resolvedModule = undefined;
      throw asRuntimedWasmAssetFailure(error);
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
        moduleLoadedFromStableFallback = false;
      }
      throw error;
    });
    loadedModule = pending;
  }
  return loadedModule;
}

async function importRuntimedWasmModuleWithRecovery(href: string): Promise<RuntimedWasmModule> {
  try {
    const module = await importRuntimedWasmModuleWithRetries(href);
    moduleLoadedFromStableFallback = false;
    return module;
  } catch (error) {
    const stableHref = stableRuntimedAssetHref(href);
    if (!stableHref) throw error;
    console.warn(
      `[notebook-cloud] runtimed WASM module failed from ${href}; falling back to ${stableHref}`,
      error,
    );
    const module = await importRuntimedWasmModuleWithRetries(stableHref);
    moduleLoadedFromStableFallback = true;
    return module;
  }
}

/**
 * The binary fell back to its stable copy while the cached module came
 * from a hashed name: re-import the module from ITS stable name so the
 * glue/binary pair stays deploy-consistent. No-op when the module name
 * carries no hash (already stable — the pair is consistent).
 */
async function reloadModuleFromStablePair(module: RuntimedWasmModule): Promise<RuntimedWasmModule> {
  const requestedHref = loadedModuleSource;
  const stableHref = requestedHref ? stableRuntimedAssetHref(requestedHref) : null;
  if (!stableHref) return module;
  console.warn(
    `[notebook-cloud] runtimed WASM binary fell back to stable; reloading module from ${stableHref} to keep the pair consistent`,
  );
  const pending = importRuntimedWasmModuleWithRetries(stableHref)
    .then((stableModule) => {
      moduleLoadedFromStableFallback = true;
      return stableModule;
    })
    .catch((error: unknown) => {
      if (loadedModule === pending) {
        loadedModule = undefined;
        loadedModuleSource = undefined;
        moduleLoadedFromStableFallback = false;
      }
      throw error;
    });
  // Cache stays keyed on the REQUESTED href; only the resolution swaps.
  loadedModule = pending;
  return pending;
}

async function importRuntimedWasmModuleWithRetries(href: string): Promise<RuntimedWasmModule> {
  let lastFailure: unknown = null;
  // import() exposes no response status — every failure shape (network
  // error, 404 mid-deploy, MIME rejection) surfaces as a rejection, so the
  // whole ladder applies.
  for (let attempt = 0; attempt <= RUNTIMED_WASM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      // Rungs >= 1 carry a unique ?retry= query: the module map pins failed
      // fetches per specifier (see moduleImportBusterSequence), so a bare
      // same-href retry would replay the cached rejection network-free.
      return await withRungTimeout(
        importModule(bustedModuleHref(href, attempt)),
        `runtimed WASM module import (${href})`,
      );
    } catch (error) {
      lastFailure = error;
    }
    const delay = RUNTIMED_WASM_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

function bustedModuleHref(href: string, attempt: number): string {
  if (attempt === 0) return href;
  const separator = href.includes("?") ? "&" : "?";
  moduleImportBusterSequence += 1;
  return `${href}${separator}retry=${moduleImportBusterSequence}`;
}

interface ResolvedRuntimedWasmBinary {
  value: WasmModuleOrPath;
  usedStableFallback: boolean;
}

/**
 * Resolve the wasm-bindgen `module_or_path` input. URL-shaped inputs are
 * fetched here (instead of inside wasm-bindgen's init) so the ladder and
 * the hashed→stable fallback cover the binary exactly like the module;
 * everything else (Response, ArrayBuffer, compiled module) passes through.
 * When the module already fell back to its stable name, the hashed binary
 * name is skipped outright — fallback decisions are coupled pairwise.
 */
async function resolveRuntimedWasmBinary(
  moduleOrPath: WasmModuleOrPath,
): Promise<ResolvedRuntimedWasmBinary> {
  if (typeof moduleOrPath !== "string" && !(moduleOrPath instanceof URL)) {
    return { value: moduleOrPath, usedStableFallback: false };
  }
  const href = typeof moduleOrPath === "string" ? moduleOrPath : moduleOrPath.href;
  if (!isLadderFetchableHref(href)) {
    // Non-network schemes (file:, data:, blob: in tests/embeddings) go
    // straight to wasm-bindgen; the ladder exists for HTTP asset origins.
    return { value: moduleOrPath, usedStableFallback: false };
  }
  const stableHref = stableRuntimedAssetHref(href);
  if (stableHref && moduleLoadedFromStableFallback) {
    console.warn(
      `[notebook-cloud] runtimed WASM module fell back to stable; fetching binary from ${stableHref} to keep the pair consistent`,
    );
    return {
      value: await fetchRuntimedWasmBinaryWithRetries(stableHref),
      usedStableFallback: true,
    };
  }
  try {
    return { value: await fetchRuntimedWasmBinaryWithRetries(href), usedStableFallback: false };
  } catch (error) {
    if (!stableHref) throw error;
    console.warn(
      `[notebook-cloud] runtimed WASM binary failed from ${href}; falling back to ${stableHref}`,
      error,
    );
    return {
      value: await fetchRuntimedWasmBinaryWithRetries(stableHref),
      usedStableFallback: true,
    };
  }
}

async function fetchRuntimedWasmBinaryWithRetries(href: string): Promise<Response> {
  let lastFailure: unknown = null;
  for (let attempt = 0; attempt <= RUNTIMED_WASM_RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await withRungTimeout(
        fetchImpl(href, rungAbortInit()),
        `runtimed WASM fetch (${href})`,
      );
    } catch (error) {
      // Thrown fetch errors (network drop, DNS, CORS, rung timeout) are
      // always retryable.
      lastFailure = error;
    }
    if (response) {
      if (response.ok) return response;
      const failure = new Error(`Failed to fetch runtimed WASM (${response.status}): ${href}`);
      if (!shouldRetryRuntimedWasmResponse(response)) {
        await cancelResponseBody(response);
        throw failure;
      }
      lastFailure = failure;
      await cancelResponseBody(response);
    }
    const delay = RUNTIMED_WASM_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

/**
 * Bound a rung with a settle deadline. The race (not just AbortSignal)
 * carries the bound so a hung attempt advances the ladder even where
 * abort is unsupported (dynamic import) — the loser is abandoned.
 */
async function withRungTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // The abandoned loser may still settle later; observe its
          // rejection so it never surfaces as unhandled.
          void Promise.resolve(work).catch(() => undefined);
          reject(new Error(`${label} timed out after ${RUNTIMED_WASM_RUNG_TIMEOUT_MS}ms`));
        }, RUNTIMED_WASM_RUNG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rungAbortInit(): RequestInit | undefined {
  // Best-effort network cancellation alongside the race; the race is the
  // load-bearing bound (AbortSignal.timeout is not mockable in tests and
  // unsupported in some embedders).
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }
  return { signal: AbortSignal.timeout(RUNTIMED_WASM_RUNG_TIMEOUT_MS) };
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
  moduleLoadedFromStableFallback = false;
  moduleImportBusterSequence = 0;
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
