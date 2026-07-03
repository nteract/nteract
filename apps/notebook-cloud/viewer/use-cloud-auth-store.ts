/**
 * React domain hooks over the cloud auth store.
 *
 * Views import the named hooks here, never the store's raw observables or the
 * generic binding. This module is the read boundary between the RxJS auth store
 * and the component tree.
 *
 * The store's drivers own the auth/app-session sources (they run from boot via
 * `cloudAuthStore.activate`), so each hook binds a store-owned projection
 * through the shared `useObservableProjection`. The projections are stable
 * module-level observables, so the binding cache stays hot across renders.
 */

import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { cloudAuthStore } from "./cloud-auth-store";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { HostedCatalogAuthProjection } from "./hosted-catalog-auth";
import type { CloudAuthRenewalState } from "./notice-types";
import type { CloudAppSessionViewState } from "./use-cloud-auth";

/** Deduped prototype auth state (mode/token/user/scope/oidc subject). */
export function useCloudAuthState(): CloudPrototypeAuthState {
  return useObservableProjection(cloudAuthStore.authState$);
}

/** Full app-session view (status/session/error), reference-stable session. */
export function useCloudAppSession(): CloudAppSessionViewState {
  return useObservableProjection(cloudAuthStore.appSessionView$);
}

/** OIDC renewal notice. */
export function useCloudAuthRenewal(): CloudAuthRenewalState {
  return useObservableProjection(cloudAuthStore.renewal$);
}

/** Stable auth object for host-owned browser API and blob fetches. */
export function useBrowserApiAuthState(): CloudPrototypeAuthState {
  return useObservableProjection(cloudAuthStore.browserApiAuthState$);
}

/** Stable connection key for the live-room reconnect dependency. */
export function useCloudSyncAuthConnectionKey(): string {
  return useObservableProjection(cloudAuthStore.syncAuthConnectionKey$);
}

/** Hosted catalog auth projection for the current auth/app-session state. */
export function useHostedCatalogAuth(): HostedCatalogAuthProjection {
  return useObservableProjection(cloudAuthStore.hostedAuth$);
}
