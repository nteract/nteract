import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

interface IsolatedRendererBundle {
  rendererCode: string;
  rendererCss: string;
}

interface IsolatedRendererContextValue {
  rendererCode: string | undefined;
  rendererCss: string | undefined;
  isLoading: boolean;
  error: Error | null;
  /**
   * Sticky failure: stays populated while a retry ladder kicked from a
   * terminal error is in flight, so degraded UI (fallback wells, the
   * aggregated notice) does not flap back to blank frames until the
   * bundle actually loads. Cleared on success.
   */
  lastError: Error | null;
  /**
   * Re-attempt a failed bundle load. The bundle state is module-level, so
   * one successful retry un-blanks every mounted consumer at once. No-op
   * while a load is in flight or once the bundle has loaded.
   */
  retry: () => void;
}

const IsolatedRendererContext = createContext<IsolatedRendererContextValue | null>(null);

interface IsolatedRendererProviderProps {
  children: ReactNode;
  /**
   * Start loading the core renderer bundle as soon as the provider mounts.
   * Defaults to true for desktop/local parity. Hosted notebook routes can
   * defer this until an isolated output actually mounts so read-mostly pages
   * do not fetch the multi-megabyte renderer bundle on the critical path.
   */
  autoLoad?: boolean;
  /** Base path to fetch isolated-renderer.js and isolated-renderer.css from */
  basePath?: string;
  /**
   * Bundle filenames under `basePath` — content-hashed names from a deploy
   * manifest (e.g. `isolated-renderer.<sha16>.js`) get immutable caching on
   * the renderer-assets origin. Defaults to the stable names. When hashed
   * names exhaust the retry ladder (deploy-window skew: the page predates a
   * deploy that replaced the hashed copies), the stable names are tried
   * once before the failure goes terminal — they are deployed alongside
   * the hashed copies for exactly this.
   */
  assetNames?: { js?: string; css?: string };
  /** Custom loader function (e.g., for Vite virtual modules) */
  loader?: () => Promise<IsolatedRendererBundle>;
}

/**
 * Bounded in-load backoff before a failure is surfaced at all. A transient
 * asset-origin blip recovers invisibly; only a persistent failure reaches
 * consumers (who then hold `retry()`, and a window `online` event re-kicks
 * the load automatically).
 */
const RENDERER_BUNDLE_RETRY_DELAYS_MS = [150, 500, 1500];

/**
 * Per-rung settle deadline so a black-holed fetch becomes a failed rung
 * (and eventually a visible, retryable error) instead of pinning the
 * provider in a permanent isLoading state where neither the fallback
 * wells nor the notice can surface.
 */
const RENDERER_BUNDLE_RUNG_TIMEOUT_MS = 20_000;

interface RendererBundleLoadState {
  bundle: IsolatedRendererBundle | null;
  isLoading: boolean;
  error: Error | null;
  lastError: Error | null;
}

// Module-level load state (shared across all provider instances): a single
// recovery propagates to every mounted consumer because they all subscribe
// to this store.
let loadState: RendererBundleLoadState = {
  bundle: null,
  isLoading: false,
  error: null,
  lastError: null,
};
const loadListeners = new Set<() => void>();
let loadGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function getLoadState(): RendererBundleLoadState {
  return loadState;
}

function subscribeLoadState(listener: () => void): () => void {
  loadListeners.add(listener);
  return () => {
    loadListeners.delete(listener);
  };
}

function setLoadState(next: RendererBundleLoadState): void {
  loadState = next;
  for (const listener of loadListeners) {
    listener();
  }
}

interface RendererBundleLoader {
  load: () => Promise<IsolatedRendererBundle>;
  /**
   * Stable-name retry used once after the primary ladder exhausts — only
   * set when the primary names are content-hashed (hashed→stable skew
   * absorption, mirroring the runtimed WASM client).
   */
  stableFallback: (() => Promise<IsolatedRendererBundle>) | null;
}

/**
 * Idempotent load kick: no-ops while a load is in flight or after success,
 * starts a fresh attempt (with the backoff ladder) otherwise — including
 * after a terminal failure, which is what makes `retry()` and the
 * historical retry-on-next-mount behavior work. A kick from a terminal
 * error keeps that error visible via `lastError` until the load succeeds.
 */
function startRendererBundleLoad(loader: RendererBundleLoader): void {
  if (loadState.bundle || loadState.isLoading) return;
  const generation = ++loadGeneration;
  setLoadState({
    bundle: null,
    isLoading: true,
    error: null,
    lastError: loadState.error ?? loadState.lastError,
  });
  void runRendererBundleLoad(loader, generation);
}

async function runRendererBundleLoad(
  loader: RendererBundleLoader,
  generation: number,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const bundle = await loader.load();
      if (generation !== loadGeneration) return;
      setLoadState({ bundle, isLoading: false, error: null, lastError: null });
      return;
    } catch (error) {
      if (generation !== loadGeneration) return;
      const delay = RENDERER_BUNDLE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        await finishWithStableFallbackOrError(loader, generation, error);
        return;
      }
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          resolve();
        }, delay);
      });
      if (generation !== loadGeneration) return;
    }
  }
}

async function finishWithStableFallbackOrError(
  loader: RendererBundleLoader,
  generation: number,
  ladderError: unknown,
): Promise<void> {
  if (loader.stableFallback) {
    console.warn(
      "[IsolatedRendererProvider] Hashed bundle names exhausted the ladder; trying stable names:",
      ladderError,
    );
    try {
      const bundle = await loader.stableFallback();
      if (generation !== loadGeneration) return;
      setLoadState({ bundle, isLoading: false, error: null, lastError: null });
      return;
    } catch (fallbackError) {
      if (generation !== loadGeneration) return;
      ladderError = fallbackError;
    }
  }
  console.error("[IsolatedRendererProvider] Bundle load failed:", ladderError);
  const error = ladderError instanceof Error ? ladderError : new Error(String(ladderError));
  setLoadState({ bundle: null, isLoading: false, error, lastError: error });
}

const ISOLATED_RENDERER_JS_STABLE_NAME = "isolated-renderer.js";
const ISOLATED_RENDERER_CSS_STABLE_NAME = "isolated-renderer.css";
const CONTENT_HASHED_RENDERER_ASSET_RE = /^isolated-renderer\.[a-f0-9]{12,64}\.(?:js|css)$/;

async function fetchRendererBundle(
  basePath: string,
  jsName: string,
  cssName: string,
): Promise<IsolatedRendererBundle> {
  const [rendererCode, rendererCss] = await Promise.all([
    fetchBundleAsset(`${basePath}/${jsName}`, "JS"),
    fetchBundleAsset(`${basePath}/${cssName}`, "CSS"),
  ]);
  return { rendererCode, rendererCss };
}

async function fetchBundleAsset(url: string, label: string): Promise<string> {
  // The race is the load-bearing settle bound (works under fake timers and
  // embedders without AbortSignal.timeout); the signal additionally
  // cancels the network request where supported.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetch(url, bundleAssetAbortInit()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Renderer ${label} fetch timed out after ${RENDERER_BUNDLE_RUNG_TIMEOUT_MS}ms`,
              ),
            ),
          RENDERER_BUNDLE_RUNG_TIMEOUT_MS,
        );
      }),
    ]);
    if (!response.ok) throw new Error(`Failed to fetch renderer ${label}: ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function bundleAssetAbortInit(): RequestInit | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }
  return { signal: AbortSignal.timeout(RENDERER_BUNDLE_RUNG_TIMEOUT_MS) };
}

const MISSING_CONFIG_ERROR_MESSAGE =
  "IsolatedRendererProvider requires either 'basePath' or 'loader' prop. " +
  "See: https://elements.nteract.io/docs/outputs/isolated-frame#setup";

const noopRetry = () => {};

/**
 * Provider for the isolated renderer bundle.
 *
 * Wrap your app (or the part that uses IsolatedFrame) with this provider.
 * Fetch failures retry on a bounded backoff ladder (content-hashed names
 * additionally fall back to the stable copies once) before surfacing an
 * error; consumers can call `retry()` from the context value to start a
 * fresh ladder after a terminal failure, and a browser `online` event
 * re-kicks a terminally failed load automatically.
 *
 * @example
 * // Option A: Fetch from a URL path
 * <IsolatedRendererProvider basePath="/isolated">
 *   <App />
 * </IsolatedRendererProvider>
 *
 * @example
 * // Option B: Use Vite virtual module (for Tauri/bundled apps)
 * <IsolatedRendererProvider loader={() => import("virtual:isolated-renderer")}>
 *   <App />
 * </IsolatedRendererProvider>
 */
export function IsolatedRendererProvider({
  children,
  autoLoad = true,
  basePath,
  assetNames,
  loader,
}: IsolatedRendererProviderProps) {
  const jsName = assetNames?.js || ISOLATED_RENDERER_JS_STABLE_NAME;
  const cssName = assetNames?.css || ISOLATED_RENDERER_CSS_STABLE_NAME;
  const bundleLoader = useMemo<RendererBundleLoader | null>(() => {
    if (loader) return { load: loader, stableFallback: null };
    if (basePath) {
      const hasHashedName =
        CONTENT_HASHED_RENDERER_ASSET_RE.test(jsName) ||
        CONTENT_HASHED_RENDERER_ASSET_RE.test(cssName);
      return {
        load: () => fetchRendererBundle(basePath, jsName, cssName),
        // Fall back as a PAIR so js and css always come from the same
        // deploy tier (mirrors the wasm client's coupled fallback).
        stableFallback: hasHashedName
          ? () =>
              fetchRendererBundle(
                basePath,
                ISOLATED_RENDERER_JS_STABLE_NAME,
                ISOLATED_RENDERER_CSS_STABLE_NAME,
              )
          : null,
      };
    }
    return null;
  }, [basePath, cssName, jsName, loader]);

  const snapshot = useSyncExternalStore(subscribeLoadState, getLoadState, getLoadState);
  const hasIsolatedOutputs = useHasIsolatedOutputs();

  useEffect(() => {
    if (!bundleLoader) return;
    if (!autoLoad && !hasIsolatedOutputs) return;
    startRendererBundleLoad(bundleLoader);
  }, [autoLoad, bundleLoader, hasIsolatedOutputs]);

  // Auto-recovery nudge: a terminal failure during an outage stays pinned
  // after the network returns (the transport reconnects itself, the bundle
  // did not). One principled listener — no polling; startRendererBundleLoad
  // is idempotent and generation-guarded.
  useEffect(() => {
    if (!bundleLoader || typeof window === "undefined") return;
    const handleOnline = () => {
      if (getLoadState().error) {
        startRendererBundleLoad(bundleLoader);
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [bundleLoader]);

  const retry = useCallback(() => {
    if (!bundleLoader) return;
    startRendererBundleLoad(bundleLoader);
  }, [bundleLoader]);

  const value = useMemo<IsolatedRendererContextValue>(() => {
    if (!bundleLoader) {
      const error = new Error(MISSING_CONFIG_ERROR_MESSAGE);
      return {
        rendererCode: undefined,
        rendererCss: undefined,
        isLoading: false,
        error,
        lastError: error,
        retry: noopRetry,
      };
    }
    return {
      rendererCode: snapshot.bundle?.rendererCode,
      rendererCss: snapshot.bundle?.rendererCss,
      // Before the mount effect kicks the first load the store is idle;
      // report that window as loading so consumers never see a false
      // "no bundle, no error, not loading" state.
      isLoading: snapshot.isLoading || (!snapshot.bundle && !snapshot.error),
      error: snapshot.error,
      lastError: snapshot.lastError,
      retry,
    };
  }, [bundleLoader, retry, snapshot]);

  return (
    <IsolatedRendererContext.Provider value={value}>{children}</IsolatedRendererContext.Provider>
  );
}

// Default state when no provider is present (e.g., during SSR)
const NO_PROVIDER_STATE: IsolatedRendererContextValue = {
  rendererCode: undefined,
  rendererCss: undefined,
  isLoading: true,
  error: null,
  lastError: null,
  retry: noopRetry,
};

/**
 * Hook to access the isolated renderer bundle.
 *
 * Returns a "loading" state if used outside IsolatedRendererProvider,
 * which allows components to render safely during SSR.
 * In development, logs a warning when no provider is present.
 */
export function useIsolatedRenderer(): IsolatedRendererContextValue {
  const context = useContext(IsolatedRendererContext);
  if (!context) {
    // During SSR or when provider is missing, return a "not ready" state
    // This allows components to render without crashing
    if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
      console.warn(
        "useIsolatedRenderer: No IsolatedRendererProvider found. " +
          "Wrap your app with <IsolatedRendererProvider>. " +
          "See: https://elements.nteract.io/docs/outputs/isolated-frame#setup",
      );
    }
    return NO_PROVIDER_STATE;
  }
  return context;
}

// Presence of isolation-needing outputs (module-level, mirrors the bundle
// store): lets page-level surfaces (the cloud's aggregated asset notice)
// stay silent on notebooks where nothing on screen is actually degraded.
let isolatedOutputConsumers = 0;
const presenceListeners = new Set<() => void>();

function notifyIsolatedOutputPresence(): void {
  for (const listener of presenceListeners) {
    listener();
  }
}

function subscribeIsolatedOutputPresence(listener: () => void): () => void {
  presenceListeners.add(listener);
  return () => {
    presenceListeners.delete(listener);
  };
}

function hasIsolatedOutputConsumers(): boolean {
  return isolatedOutputConsumers > 0;
}

/**
 * Report that this component currently renders isolation-needing outputs.
 * OutputArea calls this with its `shouldIsolate` so `useHasIsolatedOutputs`
 * reflects what is actually on screen.
 */
export function useRegisterIsolatedOutput(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    isolatedOutputConsumers += 1;
    notifyIsolatedOutputPresence();
    return () => {
      isolatedOutputConsumers -= 1;
      notifyIsolatedOutputPresence();
    };
  }, [active]);
}

/** True while at least one mounted consumer renders isolated outputs. */
export function useHasIsolatedOutputs(): boolean {
  return useSyncExternalStore(
    subscribeIsolatedOutputPresence,
    hasIsolatedOutputConsumers,
    () => false,
  );
}

/**
 * Reset the bundle cache (useful for testing).
 * @internal
 */
export function _resetBundleCache() {
  loadGeneration += 1;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  setLoadState({ bundle: null, isLoading: false, error: null, lastError: null });
}
