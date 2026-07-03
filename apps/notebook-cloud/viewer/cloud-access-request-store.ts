/**
 * Cloud viewer access-request store: the single owner of the viewer's edit
 * intent - the selected interaction mode, the user's own pending edit-access
 * request, and the request error - plus the drivers that keep the request fresh
 * (an initial load, a fixed-rate visibility-gated poll) and the transition side
 * effects a loaded request cascades into.
 *
 * The store projects, it does not re-derive authority. The gate that decides
 * whether to poll (`shouldLoadOwnEditAccessRequest`, a pending
 * `effectiveAccessRequest`) is computed by the React-owned
 * `CloudAccessFactsStore` projection and fed in through `inputs$`; the store
 * only reacts to it. The reactive cycle - this store's request feeds the facts
 * projection, whose gate feeds this store's poll - is broken at the React
 * boundary: `useLiveInputs` re-pushes on render (not a live reactive edge) and
 * every driver dedups its gate through `select`/`distinctUntilChanged`.
 *
 * The drivers live behind `activate(inputs$, deps)`, which returns a disposer.
 * Every timer threads `deps.scheduler`, every clock reads `deps.now()`, the
 * visibility gate and the network operations are injectable, so the whole store
 * is virtual-time-total and node-testable without a browser.
 */

import {
  EMPTY,
  Subscription,
  catchError,
  defer,
  filter,
  from,
  map,
  type Observable,
  type SchedulerLike,
} from "rxjs";
import { ObservableStore, createPoll, fetchLatest, select } from "runtimed";
import type { ConnectionScope } from "../src/auth-shared";
import {
  fetchWithCloudPrototypeAuth,
  storeCloudRequestedScope,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import type { CloudAccessFactsProjection, CloudAccessRequestFacts } from "./cloud-access-facts";
import { projectCloudAccessRequestTransition } from "./cloud-access-request-state";
import type { CloudNotebookCatalogAccessScope } from "./cloud-notebook-catalog-access";
import { cloudNotebookModeFromSearch, type CloudNotebookUrlMode } from "./cloud-notebook-mode";
import { cloudResponseError } from "./cloud-response";
import { documentVisible$ } from "./browser-signals";
import type { CloudNotebookAccessRequest } from "./sharing-client";

/** Cadence of the pending-request poll. */
const CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS = 30_000;

/** The store's authoritative edit-intent state. */
export interface CloudAccessRequestState {
  /** The user's own latest edit-access request, or null. */
  latest: CloudNotebookAccessRequest | null;
  /** Last user-initiated request error; poll/load failures never set it. */
  error: string | null;
  /** Whether the user has asked for edit access this edit session. */
  requestedByUser: boolean;
  /** The viewer's selected interaction mode (`?mode=`), corrected by access. */
  selectedMode: CloudNotebookUrlMode;
}

/**
 * The React-owned inputs the drivers read. Assembled by the controller and
 * pushed through `useLiveInputs` on every render. The store treats these as the
 * live gate and the transition context; it never mutates them.
 */
export interface CloudAccessRequestInputs {
  /** Access facts projection: the poll gate and the mode corrections. */
  facts: CloudAccessFactsProjection;
  /** Stable fetch identity for the access-request GET/POST. */
  browserAuth: CloudPrototypeAuthState;
  /** The access-requests endpoint for this notebook. */
  endpoint: string;
  /** Prototype auth mode/scope the transition reads (not the fetch identity). */
  authState: Pick<CloudPrototypeAuthState, "mode" | "requestedScope">;
  /** Live-room connection scope the transition reads. */
  connectionScope: string | null;
  /** Resolved catalog scope the transition reads as the access source of truth. */
  catalogAccessScope: CloudNotebookCatalogAccessScope | null;
  /** Whether a browser app session is present (cookie-backed auth). */
  hasAppSession: boolean;
}

/** Side effects a loaded request cascades into, plus injected clock/network. */
export interface CloudAccessRequestStoreDeps {
  scheduler?: SchedulerLike;
  /** Epoch milliseconds. The synthetic already-granted request stamps read this. */
  now?: () => number;
  documentVisible$?: Observable<boolean>;
  pollIntervalMs?: number;
  /** This notebook's id, for the synthetic already-granted request. */
  notebookId: string;
  /** Retry the live room after an approval transition. */
  onRetryLiveConnection: () => void;
  /** Re-read prototype auth after a scope-refresh transition. */
  onRefreshAuth: () => void;
  /** Persist the requested scope. Defaults to a localStorage write. */
  storeRequestedScope?: (scope: ConnectionScope) => void;
  /** Fetch the user's own access requests. Rejects on non-ok; caller swallows. */
  loadOwnAccessRequest?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
    signal: AbortSignal;
  }) => Promise<CloudNotebookAccessRequest | null>;
  /** POST an edit-access request. Rejects on non-ok; the store surfaces it. */
  postEditAccessRequest?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
  }) => Promise<CloudAccessRequestPostResult>;
}

/** Parsed shape of the POST edit-access response. */
export interface CloudAccessRequestPostResult {
  accessStatus?: string;
  accessRequest?: CloudNotebookAccessRequest | null;
}

interface CloudAccessRequestStoreOptions {
  /** Seeds `selectedMode`. Defaults to the current `?mode=` search param. */
  readSelectedMode?: () => CloudNotebookUrlMode;
}

interface ResolvedAccessRequestDeps {
  notebookId: string;
  now: () => number;
  onRetryLiveConnection: () => void;
  onRefreshAuth: () => void;
  storeRequestedScope: (scope: ConnectionScope) => void;
  loadOwnAccessRequest: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
    signal: AbortSignal;
  }) => Promise<CloudNotebookAccessRequest | null>;
  postEditAccessRequest: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
  }) => Promise<CloudAccessRequestPostResult>;
}

function defaultSelectedMode(): CloudNotebookUrlMode {
  if (typeof window === "undefined") {
    return "view";
  }
  return cloudNotebookModeFromSearch(window.location.search);
}

function defaultStoreRequestedScope(scope: ConnectionScope): void {
  if (typeof window === "undefined") {
    return;
  }
  storeCloudRequestedScope(window.localStorage, scope);
}

async function defaultLoadOwnAccessRequest({
  endpoint,
  auth,
  signal,
}: {
  endpoint: string;
  auth: CloudPrototypeAuthState;
  signal: AbortSignal;
}): Promise<CloudNotebookAccessRequest | null> {
  const response = await fetchWithCloudPrototypeAuth(
    endpoint,
    { headers: { Accept: "application/json" }, signal },
    auth,
  );
  if (!response.ok) {
    throw await cloudResponseError(response, "Unable to load access requests");
  }
  const body = (await response.json()) as { access_requests?: CloudNotebookAccessRequest[] };
  return Array.isArray(body.access_requests) ? (body.access_requests[0] ?? null) : null;
}

async function defaultPostEditAccessRequest({
  endpoint,
  auth,
}: {
  endpoint: string;
  auth: CloudPrototypeAuthState;
}): Promise<CloudAccessRequestPostResult> {
  const response = await fetchWithCloudPrototypeAuth(
    endpoint,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "editor" }),
    },
    auth,
  );
  if (!response.ok) {
    throw await cloudResponseError(response, "Unable to request edit access");
  }
  return (await response.json()) as CloudAccessRequestPostResult;
}

/** Field-by-field dedup for the request sub-facts the component reprojects. */
export function cloudAccessRequestFactsEquals(
  a: CloudAccessRequestFacts,
  b: CloudAccessRequestFacts,
): boolean {
  return (
    a === b ||
    (a.error === b.error && a.latest === b.latest && a.requestedByUser === b.requestedByUser)
  );
}
// Adding a field to `CloudAccessRequestFacts` breaks this manifest's typecheck,
// flagging the comparator for update.
const _CLOUD_ACCESS_REQUEST_FACTS_FIELDS = {
  error: true,
  latest: true,
  requestedByUser: true,
} satisfies Record<keyof CloudAccessRequestFacts, true>;
void _CLOUD_ACCESS_REQUEST_FACTS_FIELDS;

export class CloudAccessRequestStore extends ObservableStore<CloudAccessRequestState> {
  /** The selected interaction mode, deduped. */
  readonly selectedMode$: Observable<CloudNotebookUrlMode>;
  /** The request sub-facts the component reprojects into the access facts. */
  readonly requestFacts$: Observable<CloudAccessRequestFacts>;

  private latestInputs: CloudAccessRequestInputs | null = null;
  private resolvedDeps: ResolvedAccessRequestDeps | null = null;

  constructor(options: CloudAccessRequestStoreOptions = {}) {
    const readSelectedMode = options.readSelectedMode ?? defaultSelectedMode;
    super({ latest: null, error: null, requestedByUser: false, selectedMode: readSelectedMode() });
    this.selectedMode$ = this.select((state) => state.selectedMode);
    this.requestFacts$ = this.select(
      (state) => ({
        error: state.error,
        latest: state.latest,
        requestedByUser: state.requestedByUser,
      }),
      cloudAccessRequestFactsEquals,
    );
  }

  /** Current selected mode, read synchronously by the live-room scope resolver. */
  get selectedModeSnapshot(): CloudNotebookUrlMode {
    return this.snapshot.selectedMode;
  }

  /** User toggled the interaction mode from the toolbar. */
  setSelectedMode(mode: CloudNotebookUrlMode): void {
    this.applySelectedMode(mode);
  }

  /** Sign-out reset: drop the request, the error, and fall back to view mode. */
  reset(): void {
    this.setState({ latest: null, error: null, requestedByUser: false, selectedMode: "view" });
  }

  /**
   * Request edit access. Records the intent, POSTs, and applies the resulting
   * request as if the viewer had explicitly chosen edit mode. A failed POST
   * surfaces its error (unlike the silently-swallowed background load).
   */
  requestEditAccess(): void {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    if (!inputs || !deps) {
      return;
    }
    this.updateState((state) => ({ ...state, requestedByUser: true, error: null }));
    void (async () => {
      try {
        const result = await deps.postEditAccessRequest({
          endpoint: inputs.endpoint,
          auth: inputs.browserAuth,
        });
        if (result.accessStatus === "granted") {
          const stamp = new Date(deps.now()).toISOString();
          this.applyLoaded(
            {
              id: "already-granted",
              notebook_id: deps.notebookId,
              requester_principal: "",
              scope: "editor",
              status: "approved",
              requested_by_actor_label: "",
              resolved_by_actor_label: null,
              created_at: stamp,
              updated_at: stamp,
              resolved_at: stamp,
            },
            { overrideSelectedMode: "edit" },
          );
          return;
        }
        this.applyLoaded(result.accessRequest ?? null, { overrideSelectedMode: "edit" });
      } catch (error) {
        this.updateState((state) => ({
          ...state,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
  }

  /**
   * Start the access-request drivers and return a disposer. Called once per
   * mount from the controller; every clock/scheduler/network operation is taken
   * from `deps`, so tests drive it with virtual time and injected fakes.
   */
  activate(
    inputs$: Observable<CloudAccessRequestInputs>,
    deps: CloudAccessRequestStoreDeps,
  ): () => void {
    const resolved: ResolvedAccessRequestDeps = {
      notebookId: deps.notebookId,
      now: deps.now ?? (() => Date.now()),
      onRetryLiveConnection: deps.onRetryLiveConnection,
      onRefreshAuth: deps.onRefreshAuth,
      storeRequestedScope: deps.storeRequestedScope ?? defaultStoreRequestedScope,
      loadOwnAccessRequest: deps.loadOwnAccessRequest ?? defaultLoadOwnAccessRequest,
      postEditAccessRequest: deps.postEditAccessRequest ?? defaultPostEditAccessRequest,
    };
    this.resolvedDeps = resolved;
    const pollIntervalMs = deps.pollIntervalMs ?? CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS;
    const visible$ = deps.documentVisible$ ?? documentVisible$;

    const subscription = new Subscription();

    // Track the latest inputs so the fetch closures and the transition read the
    // current gate/context, not a stale render's. Added first so it is set
    // before any driver's fetch fires.
    subscription.add(inputs$.subscribe((inputs) => (this.latestInputs = inputs)));

    // Initial load: a rise in `shouldLoad` fetches once; a fall clears `latest`
    // (leaving `error` and `requestedByUser` untouched). `fetchLatest` aborts a
    // superseded request when the gate flips.
    subscription.add(
      fetchLatest(
        select(inputs$, (inputs) => inputs.facts.shouldLoadOwnEditAccessRequest),
        (shouldLoad, signal) =>
          shouldLoad
            ? from(this.runLoad(resolved, signal)).pipe(
                map((request) => ({ apply: true as const, request })),
                catchError(() => EMPTY),
              )
            : defer(() => {
                this.clearLatest();
                return EMPTY;
              }),
      ).subscribe((result) => this.applyLoaded(result.request)),
    );

    // Poll: a pending, load-eligible request polls at the fixed cadence, gated
    // by document visibility. One `exhaustMap` inside `createPoll` shares the
    // in-flight guard across the interval tick and the visibility rise, so a
    // wakeup mid-fetch never starts a second request. All errors are swallowed.
    subscription.add(
      createPoll<CloudNotebookAccessRequest | null>({
        strategy: "fixed-rate",
        interval$: select(inputs$, (inputs) =>
          inputs.facts.effectiveAccessRequest?.status === "pending" &&
          inputs.facts.shouldLoadOwnEditAccessRequest
            ? pollIntervalMs
            : null,
        ),
        active$: visible$,
        scheduler: deps.scheduler,
        fetch: (signal) => this.runLoad(resolved, signal),
        onError: () => {},
      }).subscribe((request) => this.applyLoaded(request)),
    );

    // Mode corrections fold in here: a copied edit link denied access falls back
    // to view, and an access-derived correction realigns the selected mode.
    subscription.add(
      select(inputs$, (inputs) => inputs.facts.shouldFallbackEditUrlToView)
        .pipe(filter(Boolean))
        .subscribe(() => this.applySelectedMode("view")),
    );
    subscription.add(
      select(inputs$, (inputs) => inputs.facts.selectedModeCorrection).subscribe((correction) => {
        if (correction) {
          this.applySelectedMode(correction);
        }
      }),
    );

    return () => {
      subscription.unsubscribe();
      this.resolvedDeps = null;
      this.latestInputs = null;
    };
  }

  private runLoad(
    deps: ResolvedAccessRequestDeps,
    signal: AbortSignal,
  ): Promise<CloudNotebookAccessRequest | null> {
    const inputs = this.latestInputs;
    if (!inputs) {
      return Promise.resolve(null);
    }
    return deps.loadOwnAccessRequest({
      endpoint: inputs.endpoint,
      auth: inputs.browserAuth,
      signal,
    });
  }

  /**
   * Apply a loaded/posted request: record it, clear the load error, then run the
   * pure transition and dispatch its side effects. The transition reads the
   * current inputs and the current (or overridden) selected mode.
   */
  private applyLoaded(
    request: CloudNotebookAccessRequest | null,
    options?: { overrideSelectedMode?: CloudNotebookUrlMode },
  ): void {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    this.updateState((state) => ({ ...state, error: null, latest: request }));
    if (!inputs || !deps) {
      return;
    }
    const selectedMode = options?.overrideSelectedMode ?? this.snapshot.selectedMode;
    const transition = projectCloudAccessRequestTransition({
      accessScope: inputs.catalogAccessScope,
      authState: inputs.authState,
      connectionScope: inputs.connectionScope,
      hasAppSession: inputs.hasAppSession,
      request: inputs.facts.catalogGrantsDocumentEdit ? null : request,
      selectedMode,
    });
    if (transition.requestedScope) {
      deps.storeRequestedScope(transition.requestedScope);
    }
    if (transition.selectedMode) {
      this.applySelectedMode(transition.selectedMode);
    }
    if (transition.retryLiveConnection) {
      deps.onRetryLiveConnection();
    }
    if (transition.refreshPrototypeAuth) {
      deps.onRefreshAuth();
    }
  }

  /** Drop `latest` without touching `error` or `requestedByUser`. */
  private clearLatest(): void {
    this.updateState((state) => (state.latest === null ? state : { ...state, latest: null }));
  }

  /**
   * Set the selected mode. Leaving edit mode drops the user's edit request,
   * matching the invariant that edit intent does not survive a mode switch.
   */
  private applySelectedMode(mode: CloudNotebookUrlMode): void {
    this.updateState((state) => {
      if (state.selectedMode === mode) {
        return state;
      }
      return {
        ...state,
        selectedMode: mode,
        requestedByUser: mode === "edit" ? state.requestedByUser : false,
      };
    });
  }
}

/**
 * The per-notebook access-request store. A module singleton (survives route
 * changes like the auth store); seeded synchronously so the live-room scope
 * resolver can read `selectedModeSnapshot` before the drivers run.
 */
export const cloudAccessRequestStore = new CloudAccessRequestStore();
