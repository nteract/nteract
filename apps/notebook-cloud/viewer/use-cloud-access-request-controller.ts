/**
 * React boundary for the cloud access-request store.
 *
 * Views import the named domain hooks here (`useCloudSelectedMode`,
 * `useCloudAccessRequestFacts`) and the controller, never the store's raw
 * observables or the generic binding. The store owns the selected mode and the
 * user's edit-access request; this module reads its projections and feeds the
 * still-React-owned inputs (the access-facts gate, connection scope, auth
 * context) back in.
 *
 * `useLiveInputs` is the render-to-store seam: it re-pushes the current inputs
 * on every render through a `BehaviorSubject`, which is what breaks the
 * access-request reactive cycle (this store's request feeds the facts gate,
 * which feeds this store's poll) at the React boundary rather than as a live
 * reactive edge. It disappears once connection facts move into a store
 * (`viewerInputs$`, Phase 6).
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { BehaviorSubject } from "rxjs";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { useCloudStores } from "./cloud-stores-context";
import type { CloudAccessRequestInputs } from "./cloud-access-request-store";
import type { CloudAccessFactsProjection, CloudAccessRequestFacts } from "./cloud-access-facts";
import type { CloudNotebookCatalogAccessScope } from "./cloud-notebook-catalog-access";
import type { CloudNotebookUrlMode } from "./cloud-notebook-mode";
import type { CloudPrototypeAuthState } from "./collaborator-auth";

/** The selected interaction mode, corrected by access. */
export function useCloudSelectedMode(): CloudNotebookUrlMode {
  const { accessRequest } = useCloudStores();
  return useObservableProjection(accessRequest.selectedMode$);
}

/** The user's own edit-access request sub-facts, for reprojection. */
export function useCloudAccessRequestFacts(): CloudAccessRequestFacts {
  const { accessRequest } = useCloudStores();
  return useObservableProjection(accessRequest.requestFacts$);
}

export interface UseCloudAccessRequestControllerParams {
  /** Access facts projection: the poll gate and the mode corrections. */
  facts: CloudAccessFactsProjection;
  /** Stable fetch identity for the access-request GET/POST. */
  browserAuth: CloudPrototypeAuthState;
  /** Prototype auth mode/scope the transition reads. */
  authState: Pick<CloudPrototypeAuthState, "mode" | "requestedScope">;
  /** Whether a browser app session is present. */
  hasAppSession: boolean;
  /** Live-room connection scope the transition reads. */
  connectionScope: string | null;
  /** Resolved catalog scope the transition reads. */
  catalogAccessScope: CloudNotebookCatalogAccessScope | null;
  /** This notebook's access-requests endpoint. */
  endpoint: string;
  /** This notebook's id, for the synthetic already-granted request. */
  notebookId: string;
  /** Retry the live room after an approval transition. */
  onRetryLiveConnection: () => void;
  /** Re-read prototype auth after a scope-refresh transition. */
  onRefreshAuth: () => void;
}

/**
 * A `BehaviorSubject` re-pushed on every render. Seeded synchronously so the
 * store's drivers read the current inputs the moment `activate` subscribes.
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
 * Wire the access-request store to its React inputs. Pushes the live inputs on
 * every render and activates the drivers once for the component's lifetime; the
 * side-effect callbacks are read through a ref so a re-render never re-arms the
 * drivers.
 */
export function useCloudAccessRequestController({
  facts,
  browserAuth,
  authState,
  hasAppSession,
  connectionScope,
  catalogAccessScope,
  endpoint,
  notebookId,
  onRetryLiveConnection,
  onRefreshAuth,
}: UseCloudAccessRequestControllerParams): void {
  const { accessRequest } = useCloudStores();
  const inputs$ = useLiveInputs<CloudAccessRequestInputs>({
    facts,
    browserAuth,
    endpoint,
    authState,
    connectionScope,
    catalogAccessScope,
    hasAppSession,
  });

  const callbacksRef = useRef({ onRetryLiveConnection, onRefreshAuth });
  callbacksRef.current = { onRetryLiveConnection, onRefreshAuth };

  useEffect(
    () =>
      accessRequest.activate(inputs$, {
        notebookId,
        onRetryLiveConnection: () => callbacksRef.current.onRetryLiveConnection(),
        onRefreshAuth: () => callbacksRef.current.onRefreshAuth(),
      }),
    [inputs$, notebookId, accessRequest],
  );
}
