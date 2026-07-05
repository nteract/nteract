/**
 * Cloud viewer catalog store: the single owner of the per-notebook catalog
 * access facts (resolved scope, load-failure) and the notebook title, plus the
 * one-shot fetch that resolves them on an auth/loader change.
 *
 * State is one object so the title and its error can no longer drift out of sync
 * with the catalog scope the way two independent React effects let them - the
 * title is written only by `applyLoaded` (a fresh catalog load) and
 * `applyTitleSaved` (a successful rename); the reset paths (`beginLoad`,
 * `applyLoadFailure`, `clearForSignedOut`) only clear it.
 *
 * `canUseAuthenticatedCloudApi` is not persistent state: it is an auth-derived
 * input pushed through `inputs$`, mirrored into `_canUseAuthenticatedApi$` so the
 * catalog-facts and live-room projections (which need it to tell an anonymous
 * `idle` from an authenticated `loading`) stay pure `distinctUntilChanged`
 * projections. The store projects the live-room policy through the same pure
 * `projectCloudAccessLiveRoomPolicy` the component used; it never re-derives it.
 *
 * The fetch lives behind `activate(inputs$)`, which returns a disposer. The
 * network operation is injected through `inputs$` (a `loadCatalogAccess` closure
 * carrying the auth-scoped catalog fetch), so the whole store is node-testable
 * without a browser.
 */

import {
  BehaviorSubject,
  EMPTY,
  Subscription,
  catchError,
  combineLatest,
  defer,
  distinctUntilChanged,
  from,
  map,
  shareReplay,
  type Observable,
} from "rxjs";
import { ObservableStore, fetchLatest, select } from "runtimed";
import {
  cloudCatalogAccessFacts,
  projectCloudAccessLiveRoomPolicy,
  type CloudCatalogAccessFacts,
} from "./cloud-access-facts";
import type {
  CloudNotebookCatalogAccessLoadResult,
  CloudNotebookCatalogAccessScope,
  CloudNotebookLiveRoomConnectionPolicy,
} from "./cloud-notebook-catalog-access";

/** The store's authoritative catalog + title state. */
export interface CloudCatalogState {
  /** Resolved catalog scope for this notebook, or null when unresolved. */
  scope: CloudNotebookCatalogAccessScope | null;
  /** Whether a catalog access load has completed for the current identity. */
  resolved: boolean;
  /** Whether the last catalog access load failed. */
  loadFailed: boolean;
  /** Loaded catalog title; `undefined` until a load carries one. */
  title: string | null | undefined;
  /** Last catalog-load or rename error surfaced through the title chrome. */
  titleError: string | null;
}

/** The SSR-hydrated catalog payload, seeded synchronously on first render. */
export interface CloudCatalogSeed {
  scope: CloudNotebookCatalogAccessScope;
  title?: string | null;
}

/**
 * The auth-derived inputs the fetch driver reads. Assembled by the controller
 * and pushed through `useLiveInputs` on every render. `loadCatalogAccess` is the
 * auth-scoped catalog fetch closure; `fetchLatest` hands it the abort signal.
 */
export interface CloudCatalogInputs {
  /** Whether the browser may call the authenticated catalog API. */
  canUseAuthenticatedCloudApi: boolean;
  /** One catalog access load. `signal` aborts on supersede/teardown. */
  loadCatalogAccess: (signal: AbortSignal) => Promise<CloudNotebookCatalogAccessLoadResult>;
}

const EMPTY_CATALOG_STATE: CloudCatalogState = {
  scope: null,
  resolved: false,
  loadFailed: false,
  title: undefined,
  titleError: null,
};

/** Field-by-field dedup for the catalog access facts the component reprojects. */
export function cloudCatalogAccessFactsEquals(
  a: CloudCatalogAccessFacts,
  b: CloudCatalogAccessFacts,
): boolean {
  return a === b || (a.status === b.status && a.scope === b.scope);
}
// Adding a field to `CloudCatalogAccessFacts` breaks this manifest's typecheck,
// flagging the comparator for update.
const _CLOUD_CATALOG_ACCESS_FACTS_FIELDS = {
  status: true,
  scope: true,
} satisfies Record<keyof CloudCatalogAccessFacts, true>;
void _CLOUD_CATALOG_ACCESS_FACTS_FIELDS;

/** Dedup identity for the live-room policy: the fields the connect decision reads. */
export function cloudNotebookLiveRoomPolicyEquals(
  a: CloudNotebookLiveRoomConnectionPolicy,
  b: CloudNotebookLiveRoomConnectionPolicy,
): boolean {
  return (
    a === b ||
    (a.shouldConnectLiveRoom === b.shouldConnectLiveRoom &&
      (a.disabledStatus?.kind ?? null) === (b.disabledStatus?.kind ?? null) &&
      (a.disabledStatus?.message ?? null) === (b.disabledStatus?.message ?? null))
  );
}
// Adding a field to `CloudNotebookLiveRoomConnectionPolicy` breaks this
// manifest's typecheck, flagging the comparator for update.
const _CLOUD_LIVE_ROOM_POLICY_FIELDS = {
  shouldConnectLiveRoom: true,
  disabledStatus: true,
} satisfies Record<keyof CloudNotebookLiveRoomConnectionPolicy, true>;
void _CLOUD_LIVE_ROOM_POLICY_FIELDS;

/** Dedup the fetch driver's inputs: refetch only on canUse or loader identity. */
function catalogFetchInputEquals(
  a: { canUse: boolean; loadCatalogAccess: CloudCatalogInputs["loadCatalogAccess"] },
  b: { canUse: boolean; loadCatalogAccess: CloudCatalogInputs["loadCatalogAccess"] },
): boolean {
  return a.canUse === b.canUse && a.loadCatalogAccess === b.loadCatalogAccess;
}

export class CloudCatalogStore extends ObservableStore<CloudCatalogState> {
  private readonly _canUseAuthenticatedApi$ = new BehaviorSubject<boolean>(false);

  /** Catalog access facts (status + scope), keyed by the authenticated gate. */
  readonly catalogAccessFacts$: Observable<CloudCatalogAccessFacts>;
  /** Live-room connection policy derived from the catalog facts. */
  readonly catalogLiveRoomPolicy$: Observable<CloudNotebookLiveRoomConnectionPolicy>;
  /** Loaded catalog title (undefined until a load carries one). */
  readonly title$: Observable<string | null | undefined>;
  /** Catalog-load / rename error for the title chrome. */
  readonly titleError$: Observable<string | null>;

  /** Suppresses the first `beginLoad` reset so an SSR seed survives one fetch. */
  private seededFromSsr = false;

  constructor() {
    super(EMPTY_CATALOG_STATE);
    this.title$ = this.select((state) => state.title);
    this.titleError$ = this.select((state) => state.titleError);
    this.catalogAccessFacts$ = combineLatest([this.state$, this._canUseAuthenticatedApi$]).pipe(
      map(([state, canUseAuthenticatedCloudApi]) =>
        cloudCatalogAccessFacts({
          canUseAuthenticatedCloudApi,
          loadFailed: state.loadFailed,
          resolved: state.resolved,
          scope: state.scope,
        }),
      ),
      distinctUntilChanged(cloudCatalogAccessFactsEquals),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.catalogLiveRoomPolicy$ = combineLatest([
      this.catalogAccessFacts$,
      this._canUseAuthenticatedApi$,
    ]).pipe(
      map(([catalog, canUseAuthenticatedCloudApi]) =>
        projectCloudAccessLiveRoomPolicy({ canUseAuthenticatedCloudApi, catalog }),
      ),
      distinctUntilChanged(cloudNotebookLiveRoomPolicyEquals),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
  }

  /**
   * Catalog access facts read synchronously by the live-room sync-scope
   * resolver. Mirrors `catalogAccessFacts$` off the current snapshot.
   */
  get catalogAccessFactsSnapshot(): CloudCatalogAccessFacts {
    return cloudCatalogAccessFacts({
      canUseAuthenticatedCloudApi: this._canUseAuthenticatedApi$.getValue(),
      loadFailed: this.snapshot.loadFailed,
      resolved: this.snapshot.resolved,
      scope: this.snapshot.scope,
    });
  }

  /**
   * Seed the catalog + title state from the SSR payload. Called once
   * synchronously on first render so the title and scope projections read
   * hydrated values without a route-title flash. `seededFromSsr` records the
   * seed so the first `beginLoad` preserves it through the first fetch.
   */
  seedFromSsr(
    seed: CloudCatalogSeed | null | undefined,
    canUseAuthenticatedCloudApi: boolean,
  ): void {
    this.seededFromSsr = Boolean(seed);
    this._canUseAuthenticatedApi$.next(canUseAuthenticatedCloudApi);
    this.setState({
      scope: seed?.scope ?? null,
      resolved: Boolean(seed),
      loadFailed: false,
      title: seed?.title,
      titleError: null,
    });
  }

  /**
   * Start the catalog fetch driver and return a disposer. A change in the
   * authenticated gate or the loader identity `switchMap`s away the prior
   * request (replacing the hand-rolled cancelled flag) and refetches; a fall to
   * `!canUseAuthenticatedCloudApi` clears the catalog + title state instead.
   */
  activate(inputs$: Observable<CloudCatalogInputs>): () => void {
    const subscription = new Subscription();

    // Mirror the authenticated gate for the facts/live-room projections.
    subscription.add(
      inputs$.subscribe((inputs) =>
        this._canUseAuthenticatedApi$.next(inputs.canUseAuthenticatedCloudApi),
      ),
    );

    subscription.add(
      fetchLatest(
        select(
          inputs$,
          (inputs) => ({
            canUse: inputs.canUseAuthenticatedCloudApi,
            loadCatalogAccess: inputs.loadCatalogAccess,
          }),
          catalogFetchInputEquals,
        ),
        ({ canUse, loadCatalogAccess }, signal) =>
          canUse
            ? defer(() => {
                this.beginLoad();
                return from(loadCatalogAccess(signal));
              }).pipe(
                map((access) => ({ access })),
                catchError((error) => {
                  this.applyLoadFailure(error instanceof Error ? error.message : String(error));
                  return EMPTY;
                }),
              )
            : defer(() => {
                this.clearForSignedOut();
                return EMPTY;
              }),
      ).subscribe((result) => this.applyLoaded(result.access)),
    );

    return () => subscription.unsubscribe();
  }

  /** Record a successful rename. Title single-writer path (alongside applyLoaded). */
  applyTitleSaved(title: string | null): void {
    this.updateState((state) => ({ ...state, title, titleError: null }));
  }

  /** Record a failed rename without touching the title. */
  applyTitleSaveFailure(message: string): void {
    this.updateState((state) => ({ ...state, titleError: message }));
  }

  /** Clear the title error while a rename is in flight. */
  clearTitleError(): void {
    this.updateState((state) =>
      state.titleError === null ? state : { ...state, titleError: null },
    );
  }

  /**
   * Reset to loading before a fetch, unless an SSR seed is still pending - the
   * seed is preserved through exactly one fetch so hydrated scope/title do not
   * flash to loading. `loadFailed` always clears here.
   */
  private beginLoad(): void {
    const consumeSeed = this.seededFromSsr;
    this.seededFromSsr = false;
    this.updateState((state) => {
      if (consumeSeed) {
        return state.loadFailed ? { ...state, loadFailed: false } : state;
      }
      return { ...state, scope: null, resolved: false, loadFailed: false, title: undefined };
    });
  }

  /**
   * Apply a resolved catalog load. Sets scope + resolved and clears the failure
   * flag; a load that carries a title (the direct catalog response) writes the
   * title and clears its error - the list-based load leaves the title alone.
   */
  private applyLoaded(access: CloudNotebookCatalogAccessLoadResult): void {
    this.updateState((state) => {
      const next: CloudCatalogState = {
        ...state,
        scope: access.catalogScope,
        resolved: access.catalogResolved,
        loadFailed: false,
      };
      if ("catalogTitle" in access) {
        next.title = access.catalogTitle ?? null;
        next.titleError = null;
      }
      return next;
    });
  }

  /**
   * Record a catalog load failure. Surfaces the message through the title error
   * slot, preserving the deliberate coupling the component effect carried.
   */
  private applyLoadFailure(message: string): void {
    this.setState({
      scope: null,
      resolved: false,
      loadFailed: true,
      title: undefined,
      titleError: message,
    });
  }

  /** Signed-out reset: clear catalog scope, title, and errors together. */
  private clearForSignedOut(): void {
    this.seededFromSsr = false;
    this.setState(EMPTY_CATALOG_STATE);
  }
}

/**
 * The per-notebook catalog store. A module singleton (survives route changes
 * like the auth and access-request stores); seeded synchronously so the
 * live-room scope resolver can read `catalogAccessFactsSnapshot`.
 */
export const cloudCatalogStore = new CloudCatalogStore();
