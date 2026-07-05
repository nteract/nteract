import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { cloudAccessRequestStore, CloudAccessRequestStore } from "../cloud-access-request-store";
import { cloudAuthStore } from "../cloud-auth-store";
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
      auth: cloudAuthStore,
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
