import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { cloudAuthStore } from "../cloud-auth-store";
import {
  useCloudAppSession,
  useCloudAuthState,
  useCloudAuthRenewal,
} from "../use-cloud-auth-store";

// The domain hooks are the read boundary between the auth store and the view
// tree. The store's driver behavior (identity-stable app-session fetches, OIDC
// refresh cadence, establish backoff) is covered headlessly in
// cloud-auth-store.test.ts; these tests pin only the useSyncExternalStore wiring
// - that each hook reflects the current store snapshot and re-renders when the
// store emits.

describe("cloud auth store domain hooks", () => {
  it("reflects the app-session snapshot and re-renders when the store changes", () => {
    const { result } = renderHook(() => useCloudAppSession());
    expect(result.current).toBe(cloudAuthStore.appSessionSnapshot);

    act(() => {
      cloudAuthStore.clearAppSessionStatus();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.session).toBe(null);
    expect(result.current).toBe(cloudAuthStore.appSessionSnapshot);
  });

  it("reflects the auth snapshot and re-renders when auth is re-read", () => {
    const { result } = renderHook(() => useCloudAuthState());
    expect(result.current).toEqual(cloudAuthStore.authSnapshot);

    act(() => {
      cloudAuthStore.refreshAuthState();
    });

    expect(result.current).toEqual(cloudAuthStore.authSnapshot);
  });

  it("reflects the renewal notice snapshot", () => {
    const { result } = renderHook(() => useCloudAuthRenewal());
    expect(result.current).toEqual(cloudAuthStore.renewalSnapshot);
  });
});
