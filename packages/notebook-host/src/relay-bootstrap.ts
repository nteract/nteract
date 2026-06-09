import type { DaemonReadyPayload, Unlisten } from "./types";
import { catchError, EMPTY, Observable, from, ignoreElements, switchMap } from "rxjs";

export type RelayBootstrapTrigger = { kind: "ready"; payload: DaemonReadyPayload };

export interface RelayBootstrapCoordinatorOptions {
  onReady: (cb: (payload: DaemonReadyPayload) => void) => Unlisten;
  requiresReadyGeneration: boolean;
  beforeBootstrap?: (trigger: RelayBootstrapTrigger) => void;
  prepareRelay?: (generation?: number) => Promise<void>;
  bootstrap: (isCancelled: () => boolean, trigger: RelayBootstrapTrigger) => Promise<boolean>;
  notifyRelayReady: (generation?: number) => Promise<void>;
  onBootstrapError?: (error: unknown, trigger: RelayBootstrapTrigger) => void;
  onMissingGeneration?: (payload: DaemonReadyPayload) => void;
  onNotifyError?: (error: unknown, generation?: number) => void;
}

export interface RelayBootstrapCoordinator {
  stop(): void;
}

/**
 * Own the frontend side of the relay bootstrap handshake.
 *
 * The host's `onReady` surface is sticky: it subscribes to future daemon-ready
 * events and backfills the cached payload for late-mounted webviews. This
 * coordinator turns that into one ordered bootstrap pipeline, so cache backfill,
 * live ready, reconnect, cancellation, and generation acknowledgement all share
 * the same path.
 */
export function startRelayBootstrapCoordinator(
  options: RelayBootstrapCoordinatorOptions,
): RelayBootstrapCoordinator {
  let stopped = false;
  let cycle = 0;
  let latestReadyGeneration: number | null = null;

  const trigger$ = new Observable<RelayBootstrapTrigger>((subscriber) => {
    const unlisten = options.onReady((payload) => {
      const generation = payload.relay_generation;
      if (generation === undefined && options.requiresReadyGeneration) {
        options.onMissingGeneration?.(payload);
        return;
      }
      if (
        generation !== undefined &&
        latestReadyGeneration !== null &&
        generation <= latestReadyGeneration
      ) {
        return;
      }
      // Ungated browser/dev hosts do not have a generation token to dedupe on;
      // every ready emission is treated as a real host lifecycle event.
      if (generation !== undefined) {
        latestReadyGeneration = generation;
      }
      subscriber.next({ kind: "ready", payload });
    });

    return () => unlisten();
  });

  const subscription = trigger$
    .pipe(
      switchMap((trigger) => {
        const currentCycle = ++cycle;
        const isCancelled = () => stopped || currentCycle !== cycle;

        try {
          options.beforeBootstrap?.(trigger);
        } catch (error) {
          options.onBootstrapError?.(error, trigger);
          return EMPTY;
        }

        const generation = trigger.payload.relay_generation;
        const bootstrap$ = options.prepareRelay
          ? from(options.prepareRelay(generation)).pipe(
              switchMap(() => options.bootstrap(isCancelled, trigger)),
            )
          : from(options.bootstrap(isCancelled, trigger));

        return bootstrap$.pipe(
          switchMap((bootstrapped) => {
            if (!bootstrapped || isCancelled()) return EMPTY;

            return from(options.notifyRelayReady(generation)).pipe(
              catchError((error: unknown) => {
                options.onNotifyError?.(error, generation);
                return EMPTY;
              }),
              ignoreElements(),
            );
          }),
          catchError((error: unknown) => {
            if (!isCancelled()) {
              options.onBootstrapError?.(error, trigger);
            }
            return EMPTY;
          }),
        );
      }),
    )
    .subscribe();

  return {
    stop() {
      stopped = true;
      cycle += 1;
      subscription.unsubscribe();
    },
  };
}
