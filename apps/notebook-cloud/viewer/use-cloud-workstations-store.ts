/**
 * React boundary for the cloud workstations store.
 *
 * The notebook rail manager and the standalone `/workstations` page import the
 * named domain hooks here (`useCloudWorkstationsRegistry`,
 * `useCloudWorkstationsStatus`, `useCloudWorkstationsError`,
 * `useCloudWorkstationMutation`, `useCloudWorkstationPairing`) and the
 * controller, never the store's raw observables or the generic binding.
 *
 * `useLiveInputs` is the render-to-store seam: it re-pushes the current fetch
 * gate/identity/cadence inputs on every render through a `BehaviorSubject`. The
 * controller wires the live workstation-attachment projection into the store for
 * the attach cross-channel confirm and activates the drivers for the component's
 * lifetime.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { BehaviorSubject } from "rxjs";
import { runtimeStateStore } from "@/components/notebook/state/runtime-state";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { useCloudStores } from "./cloud-stores-context";
import type {
  CloudWorkstationMutationState,
  CloudWorkstationPairing,
  CloudWorkstationsInputs,
  CloudWorkstationsRegistry,
  CloudWorkstationsRegistryStatus,
} from "./cloud-workstations-store";

/** The registered workstations + default id. */
export function useCloudWorkstationsRegistry(): CloudWorkstationsRegistry {
  const { workstations } = useCloudStores();
  return useObservableProjection(workstations.registry$);
}

/** Registry lifecycle status (loading / signed-out / error / ready). */
export function useCloudWorkstationsStatus(): CloudWorkstationsRegistryStatus {
  const { workstations } = useCloudStores();
  return useObservableProjection(workstations.status$);
}

/** Last surfaced registry error. */
export function useCloudWorkstationsError(): string | null {
  const { workstations } = useCloudStores();
  return useObservableProjection(workstations.error$);
}

/** The in-flight mutation for the toolbar/panel. */
export function useCloudWorkstationMutation(): CloudWorkstationMutationState {
  const { workstations } = useCloudStores();
  return useObservableProjection(workstations.mutation$);
}

/** The pairing with its registered workstation's display name resolved. */
export function useCloudWorkstationPairing(): CloudWorkstationPairing | null {
  const { workstations } = useCloudStores();
  return useObservableProjection(workstations.pairingWithName$);
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
 * Wire the workstations store to its fetch inputs. Pushes the live inputs on
 * every render and activates the drivers once for the component's lifetime; the
 * live workstation-attachment projection feeds the attach cross-channel confirm.
 */
export function useCloudWorkstationsController(inputs: CloudWorkstationsInputs): void {
  const { workstations } = useCloudStores();
  const inputs$ = useLiveInputs(inputs);
  useEffect(
    () => workstations.activate(inputs$, { workstation$: runtimeStateStore.workstation$ }),
    [inputs$, workstations],
  );
}
