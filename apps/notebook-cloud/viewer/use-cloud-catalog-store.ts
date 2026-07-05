/**
 * React boundary for the cloud catalog store.
 *
 * Views import the named domain hooks here (`useCloudCatalogAccessFacts`,
 * `useCloudCatalogLiveRoomPolicy`, `useCloudNotebookTitle`,
 * `useCloudNotebookTitleError`) and the controller, never the store's raw
 * observables or the generic binding. The store owns catalog access and the
 * notebook title; this module reads its projections and feeds the auth-derived
 * fetch inputs (the authenticated gate, the catalog loader) back in.
 *
 * `useLiveInputs` is the render-to-store seam: it re-pushes the current inputs
 * on every render through a `BehaviorSubject`. The seed runs once synchronously
 * on first render so the title/scope projections read the SSR-hydrated values
 * without a route-title flash.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BehaviorSubject } from "rxjs";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import {
  cloudCatalogStore,
  type CloudCatalogInputs,
  type CloudCatalogSeed,
} from "./cloud-catalog-store";
import type { CloudCatalogAccessFacts } from "./cloud-access-facts";
import type { CloudNotebookLiveRoomConnectionPolicy } from "./cloud-notebook-catalog-access";

/** Catalog access facts (status + scope) for the current identity. */
export function useCloudCatalogAccessFacts(): CloudCatalogAccessFacts {
  return useObservableProjection(cloudCatalogStore.catalogAccessFacts$);
}

/** Live-room connection policy derived from the catalog facts. */
export function useCloudCatalogLiveRoomPolicy(): CloudNotebookLiveRoomConnectionPolicy {
  return useObservableProjection(cloudCatalogStore.catalogLiveRoomPolicy$);
}

/** Loaded catalog title (undefined until a load carries one). */
export function useCloudNotebookTitle(): string | null | undefined {
  return useObservableProjection(cloudCatalogStore.title$);
}

/** Catalog-load / rename error for the title chrome. */
export function useCloudNotebookTitleError(): string | null {
  return useObservableProjection(cloudCatalogStore.titleError$);
}

export interface UseCloudCatalogControllerParams {
  /** Whether the browser may call the authenticated catalog API. */
  canUseAuthenticatedCloudApi: boolean;
  /** The auth-scoped catalog access load closure. */
  loadCatalogAccess: CloudCatalogInputs["loadCatalogAccess"];
  /** The SSR-hydrated catalog payload for the synchronous first-render seed. */
  initialCatalogAccess: CloudCatalogSeed | null | undefined;
}

/**
 * A `BehaviorSubject` re-pushed on every render. Seeded synchronously so the
 * store's driver reads the current inputs the moment `activate` subscribes.
 */
function useLiveInputs<T>(value: T): BehaviorSubject<T> {
  const subjectRef = useRef<BehaviorSubject<T> | null>(null);
  if (subjectRef.current === null) {
    subjectRef.current = new BehaviorSubject(value);
  }
  const subject = subjectRef.current;
  useLayoutEffect(() => {
    subject.next(value);
  });
  return subject;
}

/**
 * Wire the catalog store to its fetch inputs. Seeds the store once from the SSR
 * payload, pushes the live inputs on every render, and activates the fetch
 * driver for the component's lifetime.
 */
export function useCloudCatalogController({
  canUseAuthenticatedCloudApi,
  loadCatalogAccess,
  initialCatalogAccess,
}: UseCloudCatalogControllerParams): void {
  // Seed synchronously on first render, before any title/facts projection read.
  useState(() => {
    cloudCatalogStore.seedFromSsr(initialCatalogAccess, canUseAuthenticatedCloudApi);
    return null;
  });

  const inputs$ = useLiveInputs<CloudCatalogInputs>({
    canUseAuthenticatedCloudApi,
    loadCatalogAccess,
  });

  useEffect(() => cloudCatalogStore.activate(inputs$), [inputs$]);
}
