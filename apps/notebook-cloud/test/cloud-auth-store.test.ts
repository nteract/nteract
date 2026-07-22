/**
 * Cloud auth store driver contract tests.
 *
 * RxJS timers run on an injected `VirtualTimeScheduler`; the store's network
 * operations are injected fakes whose promises settle on the real microtask
 * queue, drained explicitly with `drainMicrotasks`. Every clock read goes
 * through the injected `now`, so backoff and session skew are virtual-time
 * total.
 *
 * The load-bearing case is F2: two content-equal app-session fetches keep the
 * session reference stable, so the live-room reconnect dependency does not
 * re-arm.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Subject, VirtualAction, VirtualTimeScheduler } from "rxjs";
import {
  CloudAuthStore,
  type CloudAuthStoreConfig,
  type CloudAuthStoreDeps,
} from "../viewer/cloud-auth-store";
import { cloudInstantPaintPrincipalMatcher } from "../viewer/instant-paint";
import { NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY } from "../viewer/oidc-auth";
import type {
  CloudOidcAuthConfig,
  CloudOidcStorage,
  CloudOidcTokenState,
} from "../viewer/oidc-auth";
import type { CloudAppSession, CloudAppSessionStatus } from "../viewer/app-session";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { HostedCatalogAuthProjection } from "../viewer/hosted-catalog-auth";

/** Advance the virtual clock by `ms`, stopping at the target frame. */
function advanceBy(scheduler: VirtualTimeScheduler, ms: number): void {
  const target = scheduler.frame + ms;
  scheduler.maxFrames = target;
  scheduler.schedule(() => {}, ms);
  scheduler.flush();
}

/** Let queued microtasks (promise `.then` chains) run to completion. */
async function drainMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function newScheduler(): VirtualTimeScheduler {
  return new VirtualTimeScheduler(VirtualAction, Infinity);
}

function anonymousAuth(): CloudPrototypeAuthState {
  return {
    mode: "anonymous",
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: null,
    problem: null,
  };
}

function devAuth(): CloudPrototypeAuthState {
  return {
    mode: "dev",
    token: "dev-token",
    user: "browser-editor",
    oidcClaims: null,
    requestedScope: "editor",
    problem: null,
  };
}

function oidcAuth(): CloudPrototypeAuthState {
  return {
    mode: "oidc",
    token: "oidc-token",
    user: "OIDC User",
    oidcClaims: { sub: "subject-1" },
    requestedScope: "editor",
    problem: null,
  };
}

function expiredOidcAuth(): CloudPrototypeAuthState {
  return {
    mode: "oidc_expired",
    token: null,
    user: "OIDC User",
    oidcClaims: { sub: "subject-1" },
    requestedScope: "editor",
    problem: "Stored OIDC session is expired. Sign in again.",
  };
}

function appSession(overrides: Partial<CloudAppSession> = {}): CloudAppSession {
  return { provider: "oidc", expires_at: 10_000, cache_key: "cache-a", ...overrides };
}

const oidcConfig: CloudOidcAuthConfig = {
  issuer: "https://issuer.test",
  clientId: "client-a",
  redirectUri: "https://viewer.test/callback",
  scope: "openid",
};

/** A storage stub whose stored OIDC token always needs refresh. */
function refreshableOidcStorage(): CloudOidcStorage {
  const token = JSON.stringify({
    accessToken: "stored-access",
    refreshToken: "stored-refresh",
    expiresAt: 0,
    claims: { sub: "subject-1" },
  });
  return {
    getItem: (key) => (key === NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY ? token : null),
    setItem: () => {},
    removeItem: () => {},
  };
}

function baseDeps(overrides: Partial<CloudAuthStoreDeps> = {}): CloudAuthStoreDeps {
  return {
    scheduler: newScheduler(),
    now: () => 0,
    windowFocus$: new Subject<void>(),
    documentVisible$: new Subject<boolean>(),
    cloudAuthStorage$: new Subject<StorageEvent>(),
    readAppSessionStatus: async () => ({ ok: true, session: null }),
    establishAppSession: async () => {},
    ...overrides,
  };
}

const anonConfig: CloudAuthStoreConfig = {
  authConfig: { oidc: null, localDev: null },
  initialSession: null,
};

describe("CloudAuthStore first paint (F7)", () => {
  it("populates authSnapshot synchronously so the instant-paint matcher is non-null", () => {
    const store = new CloudAuthStore({ readAuthState: oidcAuth });
    // No subscribe, no activate: the matcher reads the snapshot before React.
    assert.equal(store.authSnapshot.mode, "oidc");
    const matcher = cloudInstantPaintPrincipalMatcher(store.authSnapshot, { hasAppSession: false });
    assert.ok(matcher, "an OIDC principal must yield a paint matcher pre-subscribe");
  });
});

describe("CloudAuthStore app-session identity (F2)", () => {
  it("holds the session reference across two content-equal fetches", async () => {
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const sessionA = appSession();
    const sessionAEqual = appSession(); // distinct object, identical content
    const results: CloudAppSessionStatus[] = [
      { ok: true, session: sessionA },
      { ok: true, session: sessionAEqual },
    ];
    let call = 0;
    const values: (CloudAppSession | null)[] = [];
    const sub = store.appSession$.subscribe((value) => values.push(value));

    const dispose = store.activate(
      anonConfig,
      baseDeps({ readAppSessionStatus: async () => results[call++] }),
    );
    await drainMicrotasks();
    // Seed (null) then the first resolved session.
    assert.deepEqual(
      values.map((v) => v?.cache_key ?? null),
      [null, "cache-a"],
    );

    store.refreshAppSessionStatus();
    await drainMicrotasks();

    // The content-equal second fetch does not re-emit, and the snapshot holds
    // the original object reference.
    assert.equal(values.length, 2);
    assert.equal(values[1], sessionA);
    assert.equal(store.appSessionSnapshot.session, sessionA);

    sub.unsubscribe();
    dispose();
  });

  it("surfaces a fetch rejection as an error view without dropping the session", async () => {
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const dispose = store.activate(
      anonConfig,
      baseDeps({
        readAppSessionStatus: async () => {
          throw new Error("boom");
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(store.appSessionSnapshot.status, "error");
    assert.match(store.appSessionSnapshot.error ?? "", /boom/);
    dispose();
  });

  it("clearAppSessionStatus drops the session without a fetch", () => {
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    store.clearAppSessionStatus();
    assert.equal(store.appSessionSnapshot.status, "ready");
    assert.equal(store.appSessionSnapshot.session, null);
  });
});

describe("CloudAuthStore hosted catalog auth projection", () => {
  it("emits only when the projected facts change", () => {
    let current = anonymousAuth();
    const store = new CloudAuthStore({ readAuthState: () => current });
    const values: HostedCatalogAuthProjection[] = [];
    const sub = store.hostedAuth$.subscribe((value) => values.push(value));

    // Seed: anonymous cannot fetch the catalog.
    assert.equal(values.length, 1);
    assert.equal(values[0].canFetchCatalog, false);

    // Dev auth flips canFetchCatalog: a new projection emits.
    current = devAuth();
    store.refreshAuthState();
    assert.equal(values.length, 2);
    assert.equal(values[1].canFetchCatalog, true);

    // Re-reading the same dev auth changes nothing: no re-emit.
    store.refreshAuthState();
    assert.equal(values.length, 2);

    sub.unsubscribe();
  });
});

describe("CloudAuthStore OIDC refresh driver", () => {
  it("refreshes on cadence and drops a trigger that lands mid-refresh (single-flight)", async () => {
    const scheduler = newScheduler();
    const focus$ = new Subject<void>();
    const visible$ = new Subject<boolean>();
    const storage$ = new Subject<StorageEvent>();
    let refreshCalls = 0;
    const pending: Array<() => void> = [];
    const refreshOidcToken = (): Promise<CloudOidcTokenState> => {
      refreshCalls += 1;
      return new Promise<CloudOidcTokenState>((resolve) => {
        pending.push(() =>
          resolve({
            accessToken: "new",
            refreshToken: "r",
            expiresAt: 99_999,
            claims: { sub: "subject-1" },
          }),
        );
      });
    };

    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const renewals: string[] = [];
    const renewalSub = store.renewal$.subscribe((r) => renewals.push(r.kind));

    const dispose = store.activate(
      { authConfig: { oidc: oidcConfig, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        now: () => 100_000,
        oidcStorage: refreshableOidcStorage(),
        refreshOidcToken,
        windowFocus$: focus$,
        documentVisible$: visible$,
        cloudAuthStorage$: storage$,
      }),
    );

    // Initial timer(0) tick fires one refresh; it is held in flight.
    advanceBy(scheduler, 0);
    assert.equal(refreshCalls, 1);

    // Focus while the refresh is in flight: exhaustMap drops it.
    focus$.next();
    assert.equal(refreshCalls, 1);

    pending[0]();
    await drainMicrotasks();
    assert.equal(refreshCalls, 1);

    // The 60s cadence tick fires the next refresh.
    advanceBy(scheduler, 60_000);
    assert.equal(refreshCalls, 2);
    pending[1]();
    await drainMicrotasks();

    // Focus, visibility rise, and storage each drive one refresh once idle.
    focus$.next();
    assert.equal(refreshCalls, 3);
    pending[2]();
    await drainMicrotasks();

    visible$.next(false);
    visible$.next(true);
    assert.equal(refreshCalls, 4);
    pending[3]();
    await drainMicrotasks();

    storage$.next({} as StorageEvent);
    assert.equal(refreshCalls, 5);
    pending[4]();
    await drainMicrotasks();

    assert.ok(renewals.includes("refreshing"));
    assert.equal(renewals.at(-1), "idle");

    renewalSub.unsubscribe();
    dispose();
  });
});

describe("CloudAuthStore app-session establish driver", () => {
  it("establishes immediately when OIDC refresh finishes after the session probe", async () => {
    const scheduler = newScheduler();
    let currentAuth = expiredOidcAuth();
    let resolveRefresh: ((token: CloudOidcTokenState) => void) | undefined;
    const establishes: string[] = [];
    const store = new CloudAuthStore({ readAuthState: () => currentAuth });

    const dispose = store.activate(
      { authConfig: { oidc: oidcConfig, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        now: () => 100_000,
        oidcStorage: refreshableOidcStorage(),
        readAppSessionStatus: async () => ({ ok: true, session: null }),
        refreshOidcToken: () =>
          new Promise<CloudOidcTokenState>((resolve) => {
            resolveRefresh = resolve;
          }),
        establishAppSession: async (authState) => {
          establishes.push(authState.token ?? "");
        },
      }),
    );

    // The initial status GET settles while OIDC refresh is still in flight.
    // Its settle edge cannot establish from the expired auth snapshot.
    advanceBy(scheduler, 0);
    await drainMicrotasks();
    assert.deepEqual(establishes, []);

    currentAuth = oidcAuth();
    resolveRefresh?.({
      accessToken: "oidc-token",
      refreshToken: "stored-refresh",
      expiresAt: 99_999,
      claims: { sub: "subject-1" },
    });
    await drainMicrotasks();

    // The refreshed auth transition must re-arm session establishment now,
    // rather than leaving the page stuck until the 60-second cadence tick.
    assert.deepEqual(establishes, ["oidc-token"]);

    dispose();
  });

  it("attempts once per token, holds off inside the 5-minute backoff, and retries after it", async () => {
    const scheduler = newScheduler();
    let nowMs = 0;
    let establishCalls = 0;
    const store = new CloudAuthStore({ readAuthState: oidcAuth });

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        now: () => nowMs,
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    // Let the initial app-session fetch settle (session stays null).
    await drainMicrotasks();

    // First establish: the token has never been exchanged.
    advanceBy(scheduler, 0);
    await drainMicrotasks();
    assert.equal(establishCalls, 1);

    // Inside the backoff window the cadence tick does not re-establish.
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(establishCalls, 1);

    // Past 5 minutes the unchanged token is retried (session still needs renewal).
    nowMs = (5 * 60 + 1) * 1_000;
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(establishCalls, 2);

    dispose();
  });

  it("does not establish for a non-OIDC auth state", async () => {
    const scheduler = newScheduler();
    let establishCalls = 0;
    const store = new CloudAuthStore({ readAuthState: devAuth });
    const dispose = store.activate(
      anonConfig,
      baseDeps({
        scheduler,
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    await drainMicrotasks();
    advanceBy(scheduler, 0);
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(establishCalls, 0);
    dispose();
  });

  it("re-triggers establish when the initial session fetch settles (no 60s stall)", async () => {
    const scheduler = newScheduler();
    const establishes: string[] = [];
    let resolveStatus: ((status: CloudAppSessionStatus) => void) | undefined;
    const store = new CloudAuthStore({ readAuthState: oidcAuth });
    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        readAppSessionStatus: () =>
          new Promise<CloudAppSessionStatus>((resolve) => {
            resolveStatus = resolve;
          }),
        establishAppSession: async (authState) => {
          establishes.push(authState.token ?? "");
        },
      }),
    );

    // The boot tick fires while the initial GET is still in flight; the
    // loading guard skips establish.
    advanceBy(scheduler, 0);
    await drainMicrotasks();
    assert.equal(establishes.length, 0);

    // The fetch settling must itself re-trigger the driver - the next timer
    // tick is a minute away.
    resolveStatus?.({ ok: true, session: null });
    await drainMicrotasks();
    assert.deepEqual(establishes, ["oidc-token"]);

    dispose();
  });
});

describe("CloudAuthStore session diet (GET-first)", () => {
  it("mounts with a live cookie session on one status GET and zero establish POSTs", async () => {
    const scheduler = newScheduler();
    const focus$ = new Subject<void>();
    const visible$ = new Subject<boolean>();
    let getCalls = 0;
    let establishCalls = 0;
    const live = appSession({ expires_at: 100_000 });
    const store = new CloudAuthStore({ readAuthState: oidcAuth });

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        windowFocus$: focus$,
        documentVisible$: visible$,
        readAppSessionStatus: async () => {
          getCalls += 1;
          return { ok: true, session: live };
        },
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    await drainMicrotasks();
    advanceBy(scheduler, 0);
    await drainMicrotasks();

    // Cadence ticks, focus, and a visibility rise: the live session keeps
    // covering the page, so nothing re-validates upstream.
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    focus$.next();
    visible$.next(false);
    visible$.next(true);
    await drainMicrotasks();

    assert.equal(getCalls, 1);
    assert.equal(establishCalls, 0);
    assert.equal(store.appSessionSnapshot.session, live);

    dispose();
  });

  it("mounts with a fresh bootstrap session on zero session fetches of any kind", async () => {
    const scheduler = newScheduler();
    let getCalls = 0;
    let establishCalls = 0;
    const store = new CloudAuthStore({ readAuthState: oidcAuth });

    const dispose = store.activate(
      {
        authConfig: { oidc: null, localDev: null },
        initialSession: appSession({ expires_at: 100_000 }),
      },
      baseDeps({
        scheduler,
        readAppSessionStatus: async () => {
          getCalls += 1;
          return { ok: true, session: appSession({ expires_at: 100_000 }) };
        },
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    await drainMicrotasks();
    advanceBy(scheduler, 0);
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();

    assert.equal(getCalls, 0);
    assert.equal(establishCalls, 0);

    dispose();
  });

  it("renews an expiring session through the status GET, not an establish POST", async () => {
    const scheduler = newScheduler();
    let getCalls = 0;
    let establishCalls = 0;
    // Inside the 30-minute renewal window but still fresh: present, expiring.
    const expiring = appSession({ expires_at: 1_000 });
    const renewed = appSession({ expires_at: 100_000 });
    const store = new CloudAuthStore({ readAuthState: oidcAuth });

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: expiring },
      baseDeps({
        scheduler,
        readAppSessionStatus: async () => {
          getCalls += 1;
          return { ok: true, session: renewed };
        },
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    await drainMicrotasks();

    // The boot tick sees the expiring session: the GET is the renewal (the
    // server slides the cookie on GET).
    advanceBy(scheduler, 0);
    await drainMicrotasks();
    assert.equal(getCalls, 1);
    assert.equal(establishCalls, 0);
    assert.equal(store.appSessionSnapshot.session, renewed);

    // Once renewed, later ticks cost nothing.
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(getCalls, 1);
    assert.equal(establishCalls, 0);

    dispose();
  });

  it("falls back to exactly one establish POST when the GET reports no session", async () => {
    const scheduler = newScheduler();
    let getCalls = 0;
    let establishCalls = 0;
    const established = appSession({ expires_at: 100_000 });
    const store = new CloudAuthStore({ readAuthState: oidcAuth });

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        readAppSessionStatus: async () => {
          getCalls += 1;
          return { ok: true, session: getCalls === 1 ? null : established };
        },
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    // Initial GET reports no session; the settle edge fires the one fallback
    // POST, whose completion refetches status and lands the session.
    await drainMicrotasks();
    assert.equal(establishCalls, 1);
    assert.equal(getCalls, 2);
    assert.equal(store.appSessionSnapshot.session, established);

    advanceBy(scheduler, 0);
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(establishCalls, 1);
    assert.equal(getCalls, 2);

    dispose();
  });

  it("drops an establish completion that lands after dispose (stale epoch)", async () => {
    let getCalls = 0;
    let establishCalls = 0;
    let resolveEstablish: (() => void) | undefined;
    const store = new CloudAuthStore({ readAuthState: oidcAuth });

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: null },
      baseDeps({
        scheduler: newScheduler(),
        readAppSessionStatus: async () => {
          getCalls += 1;
          return { ok: true, session: null };
        },
        establishAppSession: () => {
          establishCalls += 1;
          return new Promise<void>((resolve) => {
            resolveEstablish = resolve;
          });
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(establishCalls, 1);
    const getCallsBeforeDispose = getCalls;

    dispose();
    resolveEstablish?.();
    await drainMicrotasks();
    // The stale completion must not adopt the token or refetch status.
    assert.equal(getCalls, getCallsBeforeDispose);

    // A fresh activation still treats the token as never-established, so the
    // fallback POST fires again instead of being swallowed by adopted state.
    const disposeSecond = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: null },
      baseDeps({
        scheduler: newScheduler(),
        readAppSessionStatus: async () => ({ ok: true, session: null }),
        establishAppSession: async () => {
          establishCalls += 1;
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(establishCalls, 2);

    disposeSecond();
  });
});

describe("CloudAuthStore renewal notice", () => {
  it("refreshAuthState clears a stale failure once storage no longer needs a refresh", async () => {
    const scheduler = newScheduler();
    let storedToken: string | null = JSON.stringify({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: 0,
      claims: { sub: "subject-1" },
    });
    const storage: CloudOidcStorage = {
      getItem: (key) => (key === NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY ? storedToken : null),
      setItem: () => {},
      removeItem: () => {},
    };
    const store = new CloudAuthStore({ readAuthState: oidcAuth });
    const dispose = store.activate(
      { authConfig: { oidc: oidcConfig, localDev: null }, initialSession: null },
      baseDeps({
        scheduler,
        oidcStorage: storage,
        refreshOidcToken: async () => {
          throw new Error("refresh failed");
        },
      }),
    );
    await drainMicrotasks();
    advanceBy(scheduler, 0);
    await drainMicrotasks();
    assert.equal(store.renewalSnapshot.kind, "failed");

    // Another tab signs out: the stored token is gone, no refresh is owed,
    // so the failure notice clears with the re-read.
    storedToken = null;
    store.refreshAuthState();
    assert.equal(store.renewalSnapshot.kind, "idle");

    dispose();
  });
});
