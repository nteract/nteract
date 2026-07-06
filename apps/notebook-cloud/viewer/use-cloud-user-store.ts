/**
 * React boundary for the cloud user store.
 *
 * Views import `useResolvedActor` here, never the store's raw observables or the
 * generic binding. The hook subscribes to the resolved profile for one principal
 * and then asks the store's synchronous resolver to build the shared
 * `ActorDisplay`.
 */

import { useMemo } from "react";
import { notebookActorProjectionFromLabel, type ActorDisplay } from "runtimed";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { useCloudStores } from "./cloud-stores-context";

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
