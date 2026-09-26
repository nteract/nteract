import {
  Subject,
  concatMap,
  defaultIfEmpty,
  defer,
  from,
  lastValueFrom,
  map,
  of,
  takeUntil,
  type Observable,
  type ObservableInput,
} from "rxjs";

/**
 * Browser-side continuation guard for hosted execution requests.
 *
 * Hosted Run / Run all / Restart and run all first wait for local document
 * sync (and sometimes a workstation attach) before they send execution intent
 * to the room. Those waits are local async continuations: once the room
 * accepts the request the queue is server-owned, but until then nothing on the
 * server knows the intent exists. Interrupt, restart, and connection teardown
 * must therefore invalidate the pending browser continuation, or the old intent
 * fires later against the replacement runtime.
 *
 * This is not a queue. A cancelled command is dropped, never replayed; the
 * user issues a fresh explicit action to run again.
 */
export interface CloudExecutionCommand {
  /** False once the live room connection that issued this command is gone. */
  isCurrent: () => boolean;
  /** Deliver local NotebookDoc changes so the room executes the synced cell. */
  flush: () => ObservableInput<boolean>;
  /** Optional compute start/attach; `false` means the attach did not happen. */
  start?: () => ObservableInput<boolean>;
  /** Send execution intent to the room (execute_cell / run_all_cells). */
  execute: () => ObservableInput<unknown>;
}

export type CloudExecutionOutcome = "submitted" | "cancelled" | "sync_failed" | "start_failed";

/**
 * Cancel only the preparation phase. Once execute is called, the room owns
 * the request; cancellation must not pretend that delivered intent was lost.
 * Observable inputs let tests control each boundary with virtual time.
 */
export function cloudExecutionCommand$(
  command: CloudExecutionCommand,
  cancelled$: Observable<unknown>,
): Observable<CloudExecutionOutcome> {
  type Prepared = "ready" | Exclude<CloudExecutionOutcome, "submitted">;
  const prepare$ = defer(() => {
    if (!command.isCurrent()) return of<Prepared>("cancelled");
    return from(command.flush()).pipe(
      concatMap((delivered): Observable<Prepared> => {
        if (!command.isCurrent()) return of("cancelled");
        if (!delivered) return of("sync_failed");
        if (!command.start) return of("ready");
        return defer(command.start).pipe(
          map((started): Prepared => {
            if (!command.isCurrent()) return "cancelled";
            return started ? "ready" : "start_failed";
          }),
        );
      }),
    );
  });
  return prepare$.pipe(
    takeUntil(cancelled$),
    defaultIfEmpty<Prepared, Prepared>("cancelled"),
    concatMap(
      (prepared): Observable<CloudExecutionOutcome> =>
        prepared === "ready"
          ? defer(command.execute).pipe(map(() => "submitted" as const))
          : of(prepared),
    ),
  );
}

export class CloudExecutionCommands {
  private readonly cancelled$ = new Subject<void>();

  /** Invalidate every command that has not yet sent execution intent. */
  cancelPending(): void {
    this.cancelled$.next();
  }

  submit(command: CloudExecutionCommand): Promise<CloudExecutionOutcome> {
    return lastValueFrom(cloudExecutionCommand$(command, this.cancelled$.asObservable()));
  }
}
