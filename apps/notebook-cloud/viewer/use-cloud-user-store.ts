/**
 * React boundary for the cloud user store.
 *
 * Views import `useResolvedActor`, `useCloudUserProfiles`, and the controller
 * here, never the store's raw observables or the generic binding. The hook
 * subscribes to the resolved profile for one principal and then asks the
 * store's synchronous resolver to build the shared `ActorDisplay`.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BehaviorSubject } from "rxjs";
import { notebookActorProjectionFromLabel, type ActorDisplay } from "runtimed";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { useCloudStores } from "./cloud-stores-context";
import type { CloudResolvedProfile, CloudUserStoreInputs } from "./cloud-user-store";
import { cloudBrowserApiAuthStateForFetch, fetchWithCloudPrototypeAuth } from "./collaborator-auth";
import { useCloudAuthState } from "./use-cloud-auth-store";

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

function principalFromActorLabel(actorLabel: string): string {
  const trimmed = actorLabel.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return notebookActorProjectionFromLabel(trimmed, {
      source: "cloud",
      isPublic: trimmed.startsWith("anonymous:"),
    }).principal.id;
  } catch {
    return "";
  }
}

/** Resolve one actor label through the cloud user directory. */
export function useResolvedActor(actorLabel: string): ActorDisplay {
  const { user } = useCloudStores();
  const principal = principalFromActorLabel(actorLabel);
  const profile$ = useMemo(() => user.profileFor$(principal), [principal, user]);
  void useObservableProjection(profile$);
  return user.resolve(actorLabel);
}

/** Principal-keyed user directory snapshot for surfaces that resolve many actors. */
export function useCloudUserProfiles(): ReadonlyMap<string, CloudResolvedProfile> {
  const { user } = useCloudStores();
  return useObservableProjection(user.profiles$);
}

/** Wire the cloud user store to auth identity and the notebook-scoped resolver endpoint. */
export function useCloudUserStoreController(authorProfilesEndpoint: string | null): void {
  const { user } = useCloudStores();
  const auth = useCloudAuthState();
  const inputs$ = useLiveInputs<CloudUserStoreInputs>({
    auth,
    authorProfilesEndpoint,
  });

  useEffect(
    () =>
      user.activate(inputs$, {
        // The resolver endpoint is viewer-gated, so backfill must carry the
        // same credentials as every other browser API call. Auth is read at
        // call time from the live inputs so a token refresh mid-session does
        // not strand backfill on stale credentials.
        fetchProfiles: (url, signal) =>
          fetchWithCloudPrototypeAuth(
            url,
            { headers: { Accept: "application/json" }, signal },
            cloudBrowserApiAuthStateForFetch(inputs$.getValue().auth),
          ),
      }),
    [inputs$, user],
  );
}
