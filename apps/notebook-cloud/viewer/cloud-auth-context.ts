/**
 * Consumption seam for the cloud viewer auth source store.
 *
 * Auth stays a module singleton - that is the boot and instant-paint reality,
 * not something this seam changes. `cloud-auth-store.ts` MUST live at module
 * scope because `instant-paint.ts` reads `authSnapshot` synchronously before
 * React mounts, and the auth driver activates once at viewer boot, outside any
 * React subtree. The three non-auth source stores live in the lazy
 * `cloud-stores-context.ts` seam.
 *
 * This context overrides CONSUMPTION, never activation. The context defaults to
 * the singleton, so a viewer with no provider resolves every auth consumer to
 * the same singleton the boot driver activated - no provider is mounted on any
 * production path. A test, an Elements fixture, or a future embedded viewer can
 * mount `CloudAuthStoreProvider` with its own store instance and every auth
 * consumer downstream reads it instead. The override's owner activates its own
 * instance (calls `activate`); the provider swaps which store is read, not which
 * store is driven.
 */

import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";
import { cloudAuthStore, type CloudAuthStore } from "./cloud-auth-store";

/** The cloud viewer auth source store a subtree consumes. */
const CloudAuthStoreContext = createContext<CloudAuthStore>(cloudAuthStore);

export interface CloudAuthStoreProviderProps {
  store: CloudAuthStore;
  children: ReactNode;
}

/**
 * Override the auth store a subtree consumes. Production mounts none of these;
 * the owner that supplies `store` is responsible for activating that instance.
 */
export function CloudAuthStoreProvider({
  store,
  children,
}: CloudAuthStoreProviderProps): ReactElement {
  return createElement(CloudAuthStoreContext.Provider, { value: store }, children);
}

/** The auth store the current subtree consumes; the singleton by default. */
export function useCloudAuthStore(): CloudAuthStore {
  return useContext(CloudAuthStoreContext);
}
