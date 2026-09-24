const ROUTE_LOAD_RECOVERY_KEY = "nteract:cloud:route-load-recovery";

interface RouteLoadRecoveryOptions {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  reload?: () => void;
  warn?: (message: string, error: unknown) => void;
}

/** Browser failures to fetch a module, rather than errors evaluating it. */
export function isRouteAssetLoadError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)(:|\.|$)/i.test(
      error.message,
    )
  );
}

/**
 * Use only for a route the user is opening, never for background prefetches
 * or imports in an already editable notebook. Reloading clears the browser's
 * failed module map and fetches the current deployment's entrypoint.
 *
 * Our library build emits native import(), without Vite's preloadError event.
 * Catch the actual import promise. Keep a guard across navigation until a
 * route successfully imports: a slow or persistent outage must not turn into
 * a reload loop just because a timer elapsed. Storage failures fail closed.
 */
export async function loadRouteWithRecovery<T>(
  load: () => Promise<T>,
  options: RouteLoadRecoveryOptions = {},
): Promise<T> {
  let module: T;
  try {
    module = await load();
  } catch (error) {
    if (isRouteAssetLoadError(error)) {
      try {
        // Reading sessionStorage itself can throw when browser storage is blocked.
        const storage = options.storage ?? window.sessionStorage;
        if (!storage.getItem(ROUTE_LOAD_RECOVERY_KEY)) {
          storage.setItem(ROUTE_LOAD_RECOVERY_KEY, "attempted");
          (options.warn ?? console.warn)(
            "[notebook-cloud] route asset download failed; reloading once",
            error,
          );
          (options.reload ?? (() => window.location.reload()))();
        }
      } catch {
        // Preserve the import error and the manual retry UI if recovery fails.
      }
    }
    throw error;
  }

  try {
    (options.storage ?? window.sessionStorage).removeItem(ROUTE_LOAD_RECOVERY_KEY);
  } catch {
    // Storage is optional for loading a working route.
  }
  return module;
}
