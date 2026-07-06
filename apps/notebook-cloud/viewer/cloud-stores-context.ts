/**
 * Lazy consumption seam for the four non-auth cloud viewer source stores
 * (access-request, catalog, user directory, workstations).
 *
 * These stores stay module singletons; their route-level controllers activate
 * the instances they consume, not this seam. Auth has its own always-loaded
 * context because `instant-paint.ts` reads `authSnapshot` synchronously before
 * React mounts and the auth driver activates once at viewer boot. Decision 8
 * (`docs/adr/frontend-sync-bridge.md`) records why.
 *
 * This context overrides CONSUMPTION, never activation. The context defaults to
 * the singleton bundle, so a viewer with no provider resolves every non-auth
 * domain hook to the same singletons the route controllers activate - no
 * provider is mounted on any production path. A test, an Elements fixture, or a
 * future embedded viewer can mount `CloudStoresProvider` with its own store
 * instances and every non-auth domain hook downstream reads them instead. The
 * override's owner activates its own instances (calls `activate`/`seedFromSsr`);
 * the provider swaps which stores are read, not which stores are driven.
 */

import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";
import {
  cloudAccessRequestStore,
  type CloudAccessRequestStore,
} from "./cloud-access-request-store";
import { cloudCatalogStore, type CloudCatalogStore } from "./cloud-catalog-store";
import { cloudUserStore, type CloudUserStore } from "./cloud-user-store";
import { cloudWorkstationsStore, type CloudWorkstationsStore } from "./cloud-workstations-store";

/** The non-auth cloud viewer source stores a subtree consumes. */
export interface CloudStores {
  accessRequest: CloudAccessRequestStore;
  catalog: CloudCatalogStore;
  user: CloudUserStore;
  workstations: CloudWorkstationsStore;
}

/**
 * The module singletons, bundled. This is the context default, so a subtree with
 * no provider consumes exactly the instances the route controllers activate.
 */
const singletonCloudStores: CloudStores = {
  accessRequest: cloudAccessRequestStore,
  catalog: cloudCatalogStore,
  user: cloudUserStore,
  workstations: cloudWorkstationsStore,
};

/**
 * Defaulted to the singleton bundle, so `useCloudStores()` needs no provider and
 * no null check. A provider overrides consumption for its subtree only.
 */
const CloudStoresContext = createContext<CloudStores>(singletonCloudStores);

export interface CloudStoresProviderProps {
  stores: CloudStores;
  children: ReactNode;
}

/**
 * Override the stores a subtree consumes. Production mounts none of these; the
 * owner that supplies `stores` is responsible for activating those instances.
 */
export function CloudStoresProvider({ stores, children }: CloudStoresProviderProps): ReactElement {
  return createElement(CloudStoresContext.Provider, { value: stores }, children);
}

/** The stores the current subtree consumes; the singleton bundle by default. */
export function useCloudStores(): CloudStores {
  return useContext(CloudStoresContext);
}
