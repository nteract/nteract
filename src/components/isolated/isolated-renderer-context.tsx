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
   * Re-attempt a failed bundle load. The bundle state is module-level, so
   * one successful retry un-blanks every mounted consumer at once. No-op
   * while a load is in flight or once the bundle has loaded.
   */
  retry: () => void;
}

const IsolatedRendererContext = createContext<IsolatedRendererContextValue | null>(null);

interface IsolatedRendererProviderProps {
  children: ReactNode;
  /** Base path to fetch isolated-renderer.js and isolated-renderer.css from */
  basePath?: string;
  /**
   * Bundle filenames under `basePath` — content-hashed names from a deploy
   * manifest (e.g. `isolated-renderer.<sha16>.js`) get immutable caching on
   * the renderer-assets origin. Defaults to the stable names.
   */
  assetNames?: { js?: string; css?: string };
  /** Custom loader function (e.g., for Vite virtual modules) */
  loader?: () => Promise<IsolatedRendererBundle>;
}

/**
 * Bounded in-load backoff before a failure is surfaced at all. A transient
 * asset-origin blip or deploy-window 404 recovers invisibly; only a
 * persistent failure reaches consumers (who then hold `retry()`).
 */
const RENDERER_BUNDLE_RETRY_DELAYS_MS = [150, 500, 1500];

interface RendererBundleLoadState {
  bundle: IsolatedRendererBundle | null;
  isLoading: boolean;
  error: Error | null;
}

// Module-level load state (shared across all provider instances): a single
// recovery propagates to every mounted consumer because they all subscribe
// to this store.
let loadState: RendererBundleLoadState = { bundle: null, isLoading: false, error: null };
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

/**
 * Idempotent load kick: no-ops while a load is in flight or after success,
 * starts a fresh attempt (with the backoff ladder) otherwise — including
 * after a terminal failure, which is what makes `retry()` and the
 * historical retry-on-next-mount behavior work.
 */
function startRendererBundleLoad(load: () => Promise<IsolatedRendererBundle>): void {
  if (loadState.bundle || loadState.isLoading) return;
  const generation = ++loadGeneration;
  setLoadState({ bundle: null, isLoading: true, error: null });
  void runRendererBundleLoad(load, generation);
}

async function runRendererBundleLoad(
  load: () => Promise<IsolatedRendererBundle>,
  generation: number,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const bundle = await load();
      if (generation !== loadGeneration) return;
      setLoadState({ bundle, isLoading: false, error: null });
      return;
    } catch (error) {
      if (generation !== loadGeneration) return;
      const delay = RENDERER_BUNDLE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error("[IsolatedRendererProvider] Bundle load failed:", error);
        setLoadState({
          bundle: null,
          isLoading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
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

const ISOLATED_RENDERER_JS_STABLE_NAME = "isolated-renderer.js";
const ISOLATED_RENDERER_CSS_STABLE_NAME = "isolated-renderer.css";

async function fetchRendererBundle(
  basePath: string,
  jsName: string,
  cssName: string,
): Promise<IsolatedRendererBundle> {
  const [rendererCode, rendererCss] = await Promise.all([
    fetch(`${basePath}/${jsName}`).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch renderer JS: ${r.status}`);
      return r.text();
    }),
    fetch(`${basePath}/${cssName}`).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch renderer CSS: ${r.status}`);
      return r.text();
    }),
  ]);
  return { rendererCode, rendererCss };
}

const MISSING_CONFIG_ERROR_MESSAGE =
  "IsolatedRendererProvider requires either 'basePath' or 'loader' prop. " +
  "See: https://elements.nteract.io/docs/outputs/isolated-frame#setup";

const noopRetry = () => {};

/**
 * Provider for the isolated renderer bundle.
 *
 * Wrap your app (or the part that uses IsolatedFrame) with this provider.
 * Fetch failures retry on a bounded backoff ladder before surfacing an
 * error; consumers can call `retry()` from the context value to start a
 * fresh ladder after a terminal failure.
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
  basePath,
  assetNames,
  loader,
}: IsolatedRendererProviderProps) {
  const jsName = assetNames?.js || ISOLATED_RENDERER_JS_STABLE_NAME;
  const cssName = assetNames?.css || ISOLATED_RENDERER_CSS_STABLE_NAME;
  const loadBundle = useMemo(() => {
    if (loader) return loader;
    if (basePath) return () => fetchRendererBundle(basePath, jsName, cssName);
    return null;
  }, [basePath, cssName, jsName, loader]);

  const snapshot = useSyncExternalStore(subscribeLoadState, getLoadState, getLoadState);

  useEffect(() => {
    if (!loadBundle) return;
    startRendererBundleLoad(loadBundle);
  }, [loadBundle]);

  const retry = useCallback(() => {
    if (!loadBundle) return;
    startRendererBundleLoad(loadBundle);
  }, [loadBundle]);

  const value = useMemo<IsolatedRendererContextValue>(() => {
    if (!loadBundle) {
      return {
        rendererCode: undefined,
        rendererCss: undefined,
        isLoading: false,
        error: new Error(MISSING_CONFIG_ERROR_MESSAGE),
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
      retry,
    };
  }, [loadBundle, retry, snapshot]);

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
  setLoadState({ bundle: null, isLoading: false, error: null });
}
