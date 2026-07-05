/**
 * React domain hooks over the cloud auth store.
 *
 * Views import the named hooks here, never the store's raw observables or the
 * generic binding. This module is the read boundary between the RxJS auth store
 * and the component tree.
 *
 * The store's drivers own the auth/app-session sources (they run from boot via
 * `auth.activate`), so each hook binds a store-owned projection through the
 * shared `useObservableProjection`. The projections are stable per store
 * instance, so the binding cache stays hot across renders. The store instance
 * comes from `useCloudStores()`, which is the singleton by default and an
 * override under `CloudStoresProvider`.
 */

import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { useCloudStores } from "./cloud-stores-context";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { HostedCatalogAuthProjection } from "./hosted-catalog-auth";
import type { CloudAuthRenewalState } from "./notice-types";
import type { CloudAppSessionViewState } from "./use-cloud-auth";

/** Deduped prototype auth state (mode/token/user/scope/oidc subject). */
export function useCloudAuthState(): CloudPrototypeAuthState {
  const { auth } = useCloudStores();
  return useObservableProjection(auth.authState$);
}

/** Full app-session view (status/session/error), reference-stable session. */
export function useCloudAppSession(): CloudAppSessionViewState {
  const { auth } = useCloudStores();
  return useObservableProjection(auth.appSessionView$);
}

/** OIDC renewal notice. */
export function useCloudAuthRenewal(): CloudAuthRenewalState {
  const { auth } = useCloudStores();
  return useObservableProjection(auth.renewal$);
}

/** Stable auth object for host-owned browser API and blob fetches. */
export function useBrowserApiAuthState(): CloudPrototypeAuthState {
  const { auth } = useCloudStores();
  return useObservableProjection(auth.browserApiAuthState$);
}

/** Stable connection key for the live-room reconnect dependency. */
export function useCloudSyncAuthConnectionKey(): string {
  const { auth } = useCloudStores();
  return useObservableProjection(auth.syncAuthConnectionKey$);
}

/** Hosted catalog auth projection for the current auth/app-session state. */
export function useHostedCatalogAuth(): HostedCatalogAuthProjection {
  const { auth } = useCloudStores();
  return useObservableProjection(auth.hostedAuth$);
}
