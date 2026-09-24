import {
  EMPTY,
  Subject,
  Subscription,
  defer,
  finalize,
  from,
  merge,
  of,
  retry,
  switchMap,
  timer,
  type Observable,
  type SchedulerLike,
} from "rxjs";
import { ObservableStore } from "runtimed";
import type {
  CloudNotebookListResponse,
  CloudNotebookListSnapshot,
  CloudNotebookListState,
} from "./cloud-viewer-types";
import { normalizeCloudNotebookListTotalCount } from "./notebook-dashboard";

export interface NotebookHomeState {
  list: CloudNotebookListState;
  displayName: string | null;
  avatar: string | null;
}

export interface NotebookHomeDriver {
  gate: "open" | "waiting" | "closed";
  seed: CloudNotebookListSnapshot | null;
  waitMs: number;
  scheduler: SchedulerLike;
  load: (signal: AbortSignal) => Promise<CloudNotebookListResponse>;
  events: Observable<void>;
  wake: Observable<unknown>;
  saved: (body: CloudNotebookListResponse) => void;
  clear: () => void;
}

const initialState = (): NotebookHomeState => ({
  list: { kind: "loading" },
  displayName: null,
  avatar: null,
});

export class NotebookHomeAccessError extends Error {}

/** Browser projection of the authorized catalog, refreshed by the home stream. */
export class CloudNotebookHomeStore extends ObservableStore<NotebookHomeState> {
  private readonly refreshes = new Subject<void>();
  private epoch = 0;

  constructor() {
    super(initialState());
  }

  seed(seed: CloudNotebookListSnapshot | null): void {
    this.setState({
      ...initialState(),
      list: seed ? { kind: "ready", ...seed } : { kind: "loading" },
    });
  }

  refresh(): void {
    this.refreshes.next();
  }

  /** Captured by mutations so completion cannot refresh another account. */
  get identityEpoch(): number {
    return this.epoch;
  }

  activate(driver: NotebookHomeDriver): () => void {
    const epoch = ++this.epoch;
    const subscriptions = new Subscription();
    this.seed(driver.seed);
    if (driver.gate === "closed") {
      driver.clear();
      this.setState({ ...initialState(), list: { kind: "signed_out" } });
    } else {
      const initial = driver.gate === "waiting" ? timer(driver.waitMs, driver.scheduler) : of(0);
      const events =
        driver.gate === "open"
          ? merge(of(0), driver.wake).pipe(switchMap(() => driver.events))
          : EMPTY;
      subscriptions.add(
        merge(initial, events, this.refreshes)
          .pipe(
            // A change during a fetch supersedes that fetch. An invalidation must
            // never be dropped just because the pre-change request is still busy.
            switchMap(() =>
              defer(() => {
                const controller = new AbortController();
                return from(driver.load(controller.signal)).pipe(
                  finalize(() => controller.abort()),
                );
              }).pipe(
                retry({
                  delay: (error, attempt) => {
                    if (error instanceof NotebookHomeAccessError) {
                      if (epoch === this.epoch) {
                        driver.clear();
                        this.setState({ ...initialState(), list: { kind: "signed_out" } });
                      }
                      return EMPTY;
                    }
                    if (epoch === this.epoch) this.failed(error);
                    return timer(
                      Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000),
                      driver.scheduler,
                    );
                  },
                }),
              ),
            ),
          )
          .subscribe((body) => {
            if (epoch !== this.epoch) return;
            driver.saved(body);
            this.setState({
              list: {
                kind: "ready",
                notebooks: body.notebooks,
                totalCount: normalizeCloudNotebookListTotalCount(body.notebooks, body.total_count),
              },
              displayName: body.current_user_display?.trim() || null,
              avatar: body.current_user_avatar?.trim() || null,
            });
          }),
      );
    }
    return () => {
      subscriptions.unsubscribe();
      if (epoch === this.epoch) ++this.epoch;
    };
  }

  private failed(error: unknown): void {
    if (this.snapshot.list.kind === "ready") {
      console.warn("[notebook-cloud] notebook list refresh failed; keeping cached list", error);
      return;
    }
    this.setState({
      ...this.snapshot,
      list: {
        kind: "error",
        message:
          error instanceof DOMException && error.name === "TimeoutError"
            ? "Loading notebooks timed out - the service may be mid-deploy. Retry, or hard-refresh if this persists."
            : error instanceof Error
              ? error.message
              : String(error),
      },
    });
  }
}

export const cloudNotebookHomeStore = new CloudNotebookHomeStore();
