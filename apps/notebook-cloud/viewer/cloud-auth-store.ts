/**
 * Cloud viewer auth store: the single owner of prototype auth state, the
 * app-session view state, and the OIDC renewal notice, plus the drivers that
 * keep them fresh (OIDC token refresh, app-session status fetch, app-session
 * establish/bridge).
 *
 * Three module-level `BehaviorSubject`s, seeded synchronously at construction.
 * `cloudInstantPaintPrincipalMatcher` reads `authSnapshot`/`appSessionSnapshot`
 * synchronously, before React mounts and before `cloud_room_ready`, so the auth
 * state cannot be seeded inside a `useEffect` without losing instant paint (F7).
 * That is why this is a module-level subject store, not a source-in-React store.
 *
 * The drivers live behind `activate(config, deps)`, which returns a disposer.
 * Every timer threads `deps.scheduler`, every clock reads `deps.now()`, and the
 * network operations are injectable, so the whole store is virtual-time-total
 * and node-testable without a browser.
 */

import {
  BehaviorSubject,
  EMPTY,
  Subject,
  Subscription,
  catchError,
  combineLatest,
  defer,
  distinctUntilChanged,
  exhaustMap,
  filter,
  finalize,
  from,
  map,
  merge,
  pairwise,
  shareReplay,
  switchMap,
  tap,
  timer,
  type Observable,
  type SchedulerLike,
} from "rxjs";
import { select } from "runtimed";
import {
  cloudAppSessionIsFresh,
  cloudAppSessionNeedsRenewal,
  establishCloudAppSession,
  readCloudAppSessionStatus,
  type CloudAppSession,
  type CloudAppSessionStatus,
} from "./app-session";
import { cloudOidcRenewalFailureMessage } from "./auth-renewal-copy";
import { documentVisible$, windowFocus$, cloudAuthStorage$ } from "./browser-signals";
import {
  cloudBrowserApiAuthStateForFetch,
  cloudPrototypeAuthFromWindow,
  cloudSyncAuthConnectionKey,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";
import {
  projectHostedCatalogAuthState,
  type HostedCatalogAuthProjection,
} from "./hosted-catalog-auth";
import type { CloudAuthRenewalState } from "./notice-types";
import {
  refreshStoredOidcToken,
  storedOidcTokenNeedsRefresh,
  type CloudOidcAuthConfig,
  type CloudOidcStorage,
  type CloudOidcTokenState,
} from "./oidc-auth";
import { cloudAppSessionsEqual, type CloudAppSessionViewState } from "./use-cloud-auth";

/** Cadence of the OIDC refresh and app-session establish timers. */
const AUTH_REFRESH_INTERVAL_MS = 60_000;

/** Establish is not retried for an unchanged token inside this window. */
const ESTABLISH_BACKOFF_SECONDS = 5 * 60;

const RENEWAL_IDLE: CloudAuthRenewalState = { kind: "idle", message: null };

/**
 * Dedup identity for the prototype auth state: the fields that change a fetch
 * identity or the instant-paint principal. `problem` and the full `oidcClaims`
 * object are derived from `mode`/`token`, so they are not part of the identity.
 */
export function cloudPrototypeAuthStateEquals(
  a: CloudPrototypeAuthState,
  b: CloudPrototypeAuthState,
): boolean {
  return (
    a === b ||
    (a.mode === b.mode &&
      a.token === b.token &&
      a.user === b.user &&
      a.requestedScope === b.requestedScope &&
      (a.oidcClaims?.sub ?? null) === (b.oidcClaims?.sub ?? null))
  );
}
// Adding a field to `CloudPrototypeAuthState` breaks this manifest's typecheck,
// flagging the comparator for update.
const _CLOUD_PROTOTYPE_AUTH_FIELDS = {
  mode: true,
  token: true,
  user: true,
  oidcClaims: true,
  requestedScope: true,
  problem: true,
} satisfies Record<keyof CloudPrototypeAuthState, true>;
void _CLOUD_PROTOTYPE_AUTH_FIELDS;

/** Field-by-field dedup for the hosted catalog auth projection. */
export function hostedCatalogAuthEquals(
  a: HostedCatalogAuthProjection,
  b: HostedCatalogAuthProjection,
): boolean {
  return (
    a === b ||
    (a.appSessionLoading === b.appSessionLoading &&
      a.canFetchCatalog === b.canFetchCatalog &&
      a.hasAppSession === b.hasAppSession &&
      a.hasExplicitAuth === b.hasExplicitAuth &&
      a.showSignIn === b.showSignIn &&
      a.signedIn === b.signedIn &&
      a.waitingForAppSession === b.waitingForAppSession)
  );
}
const _HOSTED_CATALOG_AUTH_FIELDS = {
  appSessionLoading: true,
  canFetchCatalog: true,
  hasAppSession: true,
  hasExplicitAuth: true,
  showSignIn: true,
  signedIn: true,
  waitingForAppSession: true,
} satisfies Record<keyof HostedCatalogAuthProjection, true>;
void _HOSTED_CATALOG_AUTH_FIELDS;

/**
 * Dedup for the browser-API fetch auth state. Non-dev modes collapse to one
 * frozen object (so `Object.is` holds); dev mode allocates, so every field the
 * fetch identity depends on is compared.
 */
export function cloudBrowserApiAuthStateEquals(
  a: CloudPrototypeAuthState,
  b: CloudPrototypeAuthState,
): boolean {
  return (
    a === b ||
    (a.mode === b.mode &&
      a.token === b.token &&
      a.user === b.user &&
      a.requestedScope === b.requestedScope &&
      a.problem === b.problem &&
      a.oidcClaims === b.oidcClaims)
  );
}

/** Boot inputs for the auth drivers. */
export interface CloudAuthStoreConfig {
  authConfig: CloudViewerAuthConfig;
  /** SSR/bootstrap app session, if one was delivered with the page. */
  initialSession?: CloudAppSession | null;
  /** When true, a failed OIDC refresh falls back to a fresh app-session cookie. */
  appSessionRefreshFallback?: boolean;
  /** Set false to disable the OIDC refresh driver entirely. */
  autoRefreshOidc?: boolean;
}

/** Injected clock, scheduler, signals, and network operations. */
export interface CloudAuthStoreDeps {
  scheduler?: SchedulerLike;
  /** Epoch milliseconds. Establish backoff and session skew read this. */
  now?: () => number;
  oidcStorage?: CloudOidcStorage;
  windowFocus$?: Observable<void>;
  documentVisible$?: Observable<boolean>;
  cloudAuthStorage$?: Observable<StorageEvent>;
  readAppSessionStatus?: (signal?: AbortSignal) => Promise<CloudAppSessionStatus>;
  establishAppSession?: (authState: CloudPrototypeAuthState) => Promise<void>;
  refreshOidcToken?: (
    config: CloudOidcAuthConfig,
    input: { storage: CloudOidcStorage; nowSeconds?: number },
  ) => Promise<CloudOidcTokenState>;
}

interface CloudAuthStoreOptions {
  /** Seeds `_authState$` and backs `refreshAuthState()`. Defaults to window. */
  readAuthState?: () => CloudPrototypeAuthState;
}

const NOOP_OIDC_STORAGE: CloudOidcStorage = {
  getItem: () => null,
  removeItem: () => {},
  setItem: () => {},
};

function defaultOidcStorage(): CloudOidcStorage {
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage) {
        return window.localStorage;
      }
    } catch {
      return NOOP_OIDC_STORAGE;
    }
  }
  return NOOP_OIDC_STORAGE;
}

export class CloudAuthStore {
  private readonly readAuthState: () => CloudPrototypeAuthState;
  private readonly _authState$: BehaviorSubject<CloudPrototypeAuthState>;
  private readonly _appSession$: BehaviorSubject<CloudAppSessionViewState>;
  private readonly _renewal$: BehaviorSubject<CloudAuthRenewalState>;
  private readonly _appSessionFetch$ = new Subject<void>();

  /** Deduped prototype auth stream (mode/token/user/scope/oidc subject). */
  readonly authState$: Observable<CloudPrototypeAuthState>;
  /** The current app session, reference-held across content-equal fetches. */
  readonly appSession$: Observable<CloudAppSession | null>;
  /** Full app-session view (status/session/error), for the domain hook. */
  readonly appSessionView$: Observable<CloudAppSessionViewState>;
  /** Whether the app session is still resolving. */
  readonly appSessionLoading$: Observable<boolean>;
  /** OIDC renewal notice. */
  readonly renewal$: Observable<CloudAuthRenewalState>;
  /** Hosted catalog auth projection, the first wiring target of this store. */
  readonly hostedAuth$: Observable<HostedCatalogAuthProjection>;
  /** Stable auth object for host-owned browser API fetches. */
  readonly browserApiAuthState$: Observable<CloudPrototypeAuthState>;
  /** Stable connection key for the live-room reconnect dependency. */
  readonly syncAuthConnectionKey$: Observable<string>;

  private authConfig: CloudViewerAuthConfig | null = null;
  private autoRefreshOidc = true;
  private appSessionRefreshFallback = false;
  private nowFn: () => number = () => Date.now();
  private oidcStorage: CloudOidcStorage = NOOP_OIDC_STORAGE;
  private readAppSessionStatusOp: (signal?: AbortSignal) => Promise<CloudAppSessionStatus> = (
    signal,
  ) => readCloudAppSessionStatus({ signal });
  private establishAppSessionOp: (authState: CloudPrototypeAuthState) => Promise<void> =
    establishCloudAppSession;
  private refreshOidcTokenOp: (
    config: CloudOidcAuthConfig,
    input: { storage: CloudOidcStorage; nowSeconds?: number },
  ) => Promise<CloudOidcTokenState> = (config, input) => refreshStoredOidcToken(config, input);

  private establishedToken: string | null = null;
  private lastEstablishAtSeconds = 0;
  private establishInFlight: Promise<void> | null = null;

  constructor(options: CloudAuthStoreOptions = {}) {
    this.readAuthState = options.readAuthState ?? cloudPrototypeAuthFromWindow;
    this._authState$ = new BehaviorSubject<CloudPrototypeAuthState>(this.readAuthState());
    this._appSession$ = new BehaviorSubject<CloudAppSessionViewState>({
      status: "loading",
      session: null,
      error: null,
    });
    this._renewal$ = new BehaviorSubject<CloudAuthRenewalState>(RENEWAL_IDLE);

    this.authState$ = this._authState$.pipe(distinctUntilChanged(cloudPrototypeAuthStateEquals));
    this.appSession$ = select(this._appSession$, (view) => view.session, cloudAppSessionsEqual);
    this.appSessionView$ = this._appSession$.pipe(distinctUntilChanged(cloudAppSessionViewEquals));
    this.appSessionLoading$ = select(this._appSession$, (view) => view.status === "loading");
    this.renewal$ = this._renewal$.pipe(distinctUntilChanged(cloudAuthRenewalEquals));
    this.hostedAuth$ = combineLatest([
      this.authState$,
      this.appSession$,
      this.appSessionLoading$,
    ]).pipe(
      map(([authState, appSession, appSessionLoading]) =>
        projectHostedCatalogAuthState(authState, { appSession, appSessionLoading }),
      ),
      distinctUntilChanged(hostedCatalogAuthEquals),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.browserApiAuthState$ = select(
      this._authState$,
      cloudBrowserApiAuthStateForFetch,
      cloudBrowserApiAuthStateEquals,
    );
    this.syncAuthConnectionKey$ = combineLatest([this._authState$, this.appSession$]).pipe(
      map(([authState, appSession]) =>
        cloudSyncAuthConnectionKey(authState, { hasAppSession: Boolean(appSession) }),
      ),
      distinctUntilChanged(),
    );
  }

  /** Current auth state, read synchronously by the instant-paint matcher (F7). */
  get authSnapshot(): CloudPrototypeAuthState {
    return this._authState$.getValue();
  }

  /** Current app-session view state (synchronous, non-reactive). */
  get appSessionSnapshot(): CloudAppSessionViewState {
    return this._appSession$.getValue();
  }

  /** Current renewal notice (synchronous, non-reactive). */
  get renewalSnapshot(): CloudAuthRenewalState {
    return this._renewal$.getValue();
  }

  /** Re-read auth from storage. The access-request reducer and drivers call this. */
  refreshAuthState(): void {
    this._authState$.next(this.readAuthState());
  }

  /** Trigger an app-session status refetch. */
  refreshAppSessionStatus(): void {
    this._appSessionFetch$.next();
  }

  /** Drop the app session without a fetch (sign-out). */
  clearAppSessionStatus(): void {
    this._appSession$.next({ status: "ready", session: null, error: null });
  }

  /**
   * Start the auth drivers and return a disposer. Called once from boot; every
   * timer/clock/network operation is taken from `deps`, so tests drive it with
   * virtual time and injected fakes.
   */
  activate(config: CloudAuthStoreConfig, deps: CloudAuthStoreDeps = {}): () => void {
    this.authConfig = config.authConfig;
    this.autoRefreshOidc = config.autoRefreshOidc !== false;
    this.appSessionRefreshFallback = config.appSessionRefreshFallback === true;
    this.nowFn = deps.now ?? (() => Date.now());
    this.oidcStorage = deps.oidcStorage ?? defaultOidcStorage();
    this.readAppSessionStatusOp =
      deps.readAppSessionStatus ?? ((signal) => readCloudAppSessionStatus({ signal }));
    this.establishAppSessionOp = deps.establishAppSession ?? establishCloudAppSession;
    this.refreshOidcTokenOp =
      deps.refreshOidcToken ?? ((oidc, input) => refreshStoredOidcToken(oidc, input));

    const scheduler = deps.scheduler;
    const focus$ = deps.windowFocus$ ?? windowFocus$;
    const visible$ = deps.documentVisible$ ?? documentVisible$;
    const storage$ = deps.cloudAuthStorage$ ?? cloudAuthStorage$;
    const visibleRise$ = visible$.pipe(
      pairwise(),
      filter(([prev, next]) => !prev && next),
    );

    this.seedAppSession(config.initialSession ?? null);

    const subscription = new Subscription();

    // OIDC refresh: interval, focus, visibility rise, and cross-tab storage
    // writes all funnel through one `exhaustMap`, so a trigger landing mid
    // refresh is dropped rather than starting a second refresh.
    subscription.add(
      merge(
        timer(0, AUTH_REFRESH_INTERVAL_MS, scheduler),
        focus$,
        visibleRise$,
        storage$.pipe(tap(() => this.refreshAuthState())),
      )
        .pipe(exhaustMap(() => from(this.runRefreshOidc())))
        .subscribe(),
    );

    // App-session fetch: a newer trigger `switchMap`s away the in-flight fetch.
    subscription.add(
      this._appSessionFetch$
        .pipe(
          switchMap(() =>
            defer(() => {
              this.beginAppSessionFetch();
              const controller = new AbortController();
              return from(this.readAppSessionStatusOp(controller.signal)).pipe(
                finalize(() => controller.abort()),
                tap((status) => this.applyFetchedSession(status.session)),
                catchError((error) => {
                  this.applyAppSessionError(error);
                  return EMPTY;
                }),
              );
            }),
          ),
        )
        .subscribe(),
    );

    // App-session establish/bridge: `renewIfNeeded` guards single-flight, token
    // change, backoff, and renewal skew internally, so a plain trigger stream
    // is enough.
    subscription.add(
      merge(timer(0, AUTH_REFRESH_INTERVAL_MS, scheduler), focus$, visibleRise$).subscribe(() =>
        this.renewIfNeeded(),
      ),
    );

    if (!cloudAppSessionIsFresh(config.initialSession, this.nowSeconds())) {
      this._appSessionFetch$.next();
    }

    return () => subscription.unsubscribe();
  }

  private seedAppSession(initialSession: CloudAppSession | null): void {
    this._appSession$.next(
      initialSession
        ? { status: "ready", session: initialSession, error: null }
        : { status: "loading", session: null, error: null },
    );
  }

  private beginAppSessionFetch(): void {
    const current = this._appSession$.getValue();
    if (current.session || current.status === "loading") {
      return;
    }
    this._appSession$.next({ ...current, status: "loading", error: null });
  }

  /**
   * Apply a fetched session while holding object identity when the fetch only
   * confirms what we already have. A fresh-but-identical object would tear down
   * and reconnect the live room, so `cloudAppSessionsEqual` gates the write.
   */
  private applyFetchedSession(fetched: CloudAppSession | null): void {
    const current = this._appSession$.getValue();
    const session = cloudAppSessionsEqual(current.session, fetched) ? current.session : fetched;
    if (current.status === "ready" && current.session === session && current.error === null) {
      return;
    }
    this._appSession$.next({ status: "ready", session, error: null });
  }

  private applyAppSessionError(error: unknown): void {
    const current = this._appSession$.getValue();
    this._appSession$.next({
      status: "error",
      session: current.session,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async runRefreshOidc(): Promise<void> {
    const oidc = this.authConfig?.oidc ?? null;
    // The configured flag is the "refresh even without an app session" intent
    // (the notebook route enables it only for edit-mode links). An existing app
    // session always needs its OIDC token kept fresh, so a live session forces
    // refresh on - reproducing the view's `hasAppSession || editMode` gate now
    // that the store owns hasAppSession.
    const autoRefresh = this.autoRefreshOidc || Boolean(this._appSession$.getValue().session);
    if (!autoRefresh || !oidc || !this.shouldRefreshStoredOidc()) {
      return;
    }
    if (this.appSessionRefreshFallback) {
      const view = this._appSession$.getValue();
      if (view.status === "loading" && !view.session) {
        this.setRenewal(RENEWAL_IDLE);
        return;
      }
      if (cloudAppSessionIsFresh(view.session, this.nowSeconds())) {
        this.setRenewal(RENEWAL_IDLE);
        return;
      }
    }

    this.setRenewal({ kind: "refreshing", message: "Refreshing sign-in..." });
    try {
      await this.refreshOidcTokenOp(oidc, {
        storage: this.oidcStorage,
        nowSeconds: this.nowSeconds(),
      });
      this.refreshAuthState();
      this.setRenewal(RENEWAL_IDLE);
    } catch (error) {
      if (this.appSessionRefreshFallback) {
        const status = await this.readAppSessionStatusOp().catch(() => null);
        if (cloudAppSessionIsFresh(status?.session, this.nowSeconds())) {
          console.warn(
            "[notebook-cloud] OIDC session refresh failed; continuing with app session cookie",
            error,
          );
          this.refreshAuthState();
          this.setRenewal(RENEWAL_IDLE);
          return;
        }
      }
      console.warn("[notebook-cloud] OIDC session refresh failed", error);
      this.refreshAuthState();
      this.setRenewal({ kind: "failed", message: cloudOidcRenewalFailureMessage(error) });
    }
  }

  private renewIfNeeded(): void {
    const authState = this._authState$.getValue();
    if (authState.mode !== "oidc" || !authState.token) {
      this.establishedToken = null;
      return;
    }
    const view = this._appSession$.getValue();
    if (view.status === "loading" && !view.session) {
      return;
    }
    const nowSeconds = this.nowSeconds();
    const tokenChanged = this.establishedToken !== authState.token;
    const sessionNeedsRenewal = cloudAppSessionNeedsRenewal(view.session, nowSeconds);
    if (!tokenChanged && !sessionNeedsRenewal) {
      return;
    }
    if (this.establishInFlight) {
      return;
    }
    if (!tokenChanged && nowSeconds - this.lastEstablishAtSeconds < ESTABLISH_BACKOFF_SECONDS) {
      return;
    }

    this.lastEstablishAtSeconds = nowSeconds;
    this.establishInFlight = this.establishAppSessionOp(authState)
      .then(() => {
        this.establishedToken = authState.token;
        this.refreshAppSessionStatus();
      })
      .catch((error: unknown) => {
        console.warn("[notebook-cloud] app session exchange failed", error);
      })
      .finally(() => {
        this.establishInFlight = null;
      });
  }

  private shouldRefreshStoredOidc(): boolean {
    try {
      return Boolean(storedOidcTokenNeedsRefresh(this.oidcStorage, this.nowSeconds()));
    } catch {
      return false;
    }
  }

  private setRenewal(next: CloudAuthRenewalState): void {
    const current = this._renewal$.getValue();
    if (current.kind === next.kind && current.message === next.message) {
      return;
    }
    this._renewal$.next(next);
  }

  private nowSeconds(): number {
    return Math.floor(this.nowFn() / 1000);
  }
}

function cloudAuthRenewalEquals(a: CloudAuthRenewalState, b: CloudAuthRenewalState): boolean {
  return a === b || (a.kind === b.kind && a.message === b.message);
}

function cloudAppSessionViewEquals(
  a: CloudAppSessionViewState,
  b: CloudAppSessionViewState,
): boolean {
  return (
    a === b ||
    (a.status === b.status && a.error === b.error && cloudAppSessionsEqual(a.session, b.session))
  );
}

/**
 * The app-wide auth store. Seeded synchronously from window at module load so
 * the instant-paint matcher can read `authSnapshot` before React mounts.
 */
export const cloudAuthStore = new CloudAuthStore();
