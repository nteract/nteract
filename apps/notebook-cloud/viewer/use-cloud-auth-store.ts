/**
 * React domain hooks over the cloud auth store.
 *
 * Views import the named hooks here, never the store's raw observables or the
 * generic binding. This module is the read boundary between the RxJS auth store
 * and the component tree.
 *
 * While the store's own auth/app-session sources are still React-owned (the
 * `use-cloud-auth` hooks remain the live drivers), the hosted catalog auth
 * projection is a render-source projection: the caller passes the current
 * auth/app-session inputs and the projection is derived and reference-stabilized
 * through the shared `useCloudFactsProjection` adapter. When the store's own
 * drivers become the source (`activate` from boot), this hook flips to reading
 * `cloudAuthStore.hostedAuth$` through the store-owned binding with no change at
 * the call sites.
 */

import { BehaviorSubject, type Observable } from "rxjs";
import type { CloudAppSession } from "./app-session";
import { useCloudFactsProjection, type CloudFactsProjectionStore } from "./cloud-facts-react";
import { hostedCatalogAuthEquals } from "./cloud-auth-store";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import {
  projectHostedCatalogAuthState,
  type HostedCatalogAuthProjection,
} from "./hosted-catalog-auth";

export interface HostedCatalogAuthInputs {
  authState: CloudPrototypeAuthState;
  appSession: CloudAppSession | null;
  appSessionLoading: boolean;
}

function projectHostedCatalogAuth(inputs: HostedCatalogAuthInputs): HostedCatalogAuthProjection {
  return projectHostedCatalogAuthState(inputs.authState, {
    appSession: inputs.appSession,
    appSessionLoading: inputs.appSessionLoading,
  });
}

/**
 * Render-source projection store for hosted catalog auth. Mirrors the
 * two-phase `set(notify:false)` + `flush()` machinery of the other cloud facts
 * stores: the projection is kept current during render, and a notification is
 * published after commit only when the projection actually changed.
 */
class HostedCatalogAuthFactsStore implements CloudFactsProjectionStore<
  HostedCatalogAuthInputs,
  HostedCatalogAuthProjection
> {
  private currentProjection: HostedCatalogAuthProjection;
  private publishedProjection: HostedCatalogAuthProjection;
  private pendingNotification = false;
  private readonly projectionSubject: BehaviorSubject<HostedCatalogAuthProjection>;

  readonly projection$: Observable<HostedCatalogAuthProjection>;

  constructor(initial: HostedCatalogAuthInputs) {
    this.currentProjection = projectHostedCatalogAuth(initial);
    this.publishedProjection = this.currentProjection;
    this.projectionSubject = new BehaviorSubject(this.currentProjection);
    this.projection$ = this.projectionSubject.asObservable();
  }

  get snapshot(): HostedCatalogAuthProjection {
    return this.currentProjection;
  }

  set(next: HostedCatalogAuthInputs, options: { notify?: boolean } = {}): void {
    const nextProjection = projectHostedCatalogAuth(next);
    if (hostedCatalogAuthEquals(this.currentProjection, nextProjection)) {
      if (options.notify !== false) {
        this.flush();
      }
      return;
    }
    this.currentProjection = nextProjection;
    this.pendingNotification = !hostedCatalogAuthEquals(
      this.publishedProjection,
      this.currentProjection,
    );
    if (options.notify === false) {
      return;
    }
    this.flush();
  }

  flush(): void {
    if (!this.pendingNotification) {
      return;
    }
    this.pendingNotification = false;
    if (hostedCatalogAuthEquals(this.publishedProjection, this.currentProjection)) {
      return;
    }
    this.publishedProjection = this.currentProjection;
    this.projectionSubject.next(this.currentProjection);
  }
}

function createHostedCatalogAuthFactsStore(
  initial: HostedCatalogAuthInputs,
): CloudFactsProjectionStore<HostedCatalogAuthInputs, HostedCatalogAuthProjection> {
  return new HostedCatalogAuthFactsStore(initial);
}

/** Hosted catalog auth projection for the current auth/app-session inputs. */
export function useHostedCatalogAuth(inputs: HostedCatalogAuthInputs): HostedCatalogAuthProjection {
  return useCloudFactsProjection(inputs, createHostedCatalogAuthFactsStore);
}
