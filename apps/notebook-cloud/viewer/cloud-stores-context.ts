/**
 * Consumption seam for the four cloud viewer source stores (auth,
 * access-request, catalog, workstations).
 *
 * The stores stay module singletons - that is the boot and instant-paint
 * reality, not something this seam changes. `cloud-auth-store.ts` MUST live at
 * module scope because `instant-paint.ts` reads `authSnapshot` synchronously
 * before React mounts, and every store's drivers activate once at viewer boot,
 * outside any React subtree. Decision 8 (`docs/adr/frontend-sync-bridge.md`)
 * records why.
 *
 * What this adds is an override of CONSUMPTION, never of activation. The context
 * defaults to the singleton bundle, so a viewer with no provider resolves every
 * domain hook to the same singletons the drivers booted - no provider is mounted
 * on any production path and behavior stays byte-identical. A test, an Elements
 * fixture, or a future embedded viewer can mount `CloudStoresProvider` with its
 * own store instances and every domain hook downstream reads them instead. The
 * override's owner activates its own instances (calls `activate`/`seedFromSsr`);
 * the provider swaps which stores are read, not which stores are driven.
 */

import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";
import {
  cloudAccessRequestStore,
  type CloudAccessRequestStore,
} from "./cloud-access-request-store";
import { cloudAuthStore, type CloudAuthStore } from "./cloud-auth-store";
import { cloudCatalogStore, type CloudCatalogStore } from "./cloud-catalog-store";
import { cloudWorkstationsStore, type CloudWorkstationsStore } from "./cloud-workstations-store";

/** The four cloud viewer source stores a subtree consumes. */
export interface CloudStores {
  auth: CloudAuthStore;
  accessRequest: CloudAccessRequestStore;
  catalog: CloudCatalogStore;
  workstations: CloudWorkstationsStore;
}

/**
 * The module singletons, bundled. This is the context default, so a subtree with
 * no provider consumes exactly the instances the boot drivers activate.
 */
const singletonCloudStores: CloudStores = {
  auth: cloudAuthStore,
  accessRequest: cloudAccessRequestStore,
  catalog: cloudCatalogStore,
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
