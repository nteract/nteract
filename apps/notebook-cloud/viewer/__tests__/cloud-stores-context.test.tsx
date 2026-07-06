import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { cloudAccessRequestStore, CloudAccessRequestStore } from "../cloud-access-request-store";
import { CloudAuthStoreProvider, useCloudAuthStore } from "../cloud-auth-context";
import { CloudAuthStore, cloudAuthStore } from "../cloud-auth-store";
import { cloudCatalogStore } from "../cloud-catalog-store";
import { CloudStoresProvider, type CloudStores } from "../cloud-stores-context";
import { cloudWorkstationsStore } from "../cloud-workstations-store";
import { useCloudSelectedMode } from "../use-cloud-access-request-controller";

// The seam's whole contract in one probe: a domain hook resolves its store from
// context, which is the module singleton by default and an override under a
// provider. `useCloudSelectedMode` reads `accessRequest.selectedMode$`; the
// singleton seeds that mode from the URL (no ?mode= in jsdom, so "view") while
// the fixture seeds "edit", so the read tells unambiguously which instance won.
describe("CloudStoresProvider", () => {
  it("routes a domain hook to the provider's store instance", () => {
    expect(cloudAccessRequestStore.selectedModeSnapshot).toBe("view");

    const fixtureAccessRequest = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const fixtureStores: CloudStores = {
      accessRequest: fixtureAccessRequest,
      catalog: cloudCatalogStore,
      workstations: cloudWorkstationsStore,
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(CloudStoresProvider, { stores: fixtureStores, children });

    const { result } = renderHook(() => useCloudSelectedMode(), { wrapper });

    // The fixture won: the hook read the override, not the singleton.
    expect(result.current).toBe("edit");
    expect(result.current).not.toBe(cloudAccessRequestStore.selectedModeSnapshot);
  });

  it("falls back to the singleton bundle with no provider", () => {
    const { result } = renderHook(() => useCloudSelectedMode());

    expect(result.current).toBe("view");
    expect(result.current).toBe(cloudAccessRequestStore.selectedModeSnapshot);
  });
});

describe("CloudAuthStoreProvider", () => {
  it("routes auth consumers to the provider's store instance", () => {
    const fixtureAuth = new CloudAuthStore({
      readAuthState: () => ({
        mode: "dev",
        token: "fixture-token",
        user: "Fixture User",
        oidcClaims: null,
        requestedScope: "viewer",
        problem: null,
      }),
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(CloudAuthStoreProvider, { store: fixtureAuth, children });

    const { result } = renderHook(() => useCloudAuthStore(), { wrapper });

    expect(result.current).toBe(fixtureAuth);
    expect(result.current.authSnapshot.user).toBe("Fixture User");
    expect(result.current).not.toBe(cloudAuthStore);
  });

  it("falls back to the singleton auth store with no provider", () => {
    const { result } = renderHook(() => useCloudAuthStore());

    expect(result.current).toBe(cloudAuthStore);
  });
});
