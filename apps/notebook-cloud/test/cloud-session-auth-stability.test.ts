import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Subject, VirtualAction, VirtualTimeScheduler } from "rxjs";
import { CloudAuthStore, type CloudAuthStoreDeps } from "../viewer/cloud-auth-store";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { CloudAppSession } from "../viewer/app-session";

function authState(overrides: Partial<CloudPrototypeAuthState> = {}): CloudPrototypeAuthState {
  return {
    mode: "oidc",
    token: "token-a",
    user: "user@example.test",
    oidcClaims: null,
    requestedScope: "owner",
    problem: null,
    ...overrides,
  };
}

/** Advance a flushed scheduler's virtual clock by `ms`, stopping at the target frame. */
function advance(scheduler: VirtualTimeScheduler, ms: number): void {
  scheduler.maxFrames = scheduler.frame + ms;
  scheduler.schedule(() => {}, ms);
  scheduler.flush();
}

/** Deps whose timers never fire (the scheduler is never flushed) and whose
 *  network operations are inert, so activate() only seeds synchronous state. */
function inertDeps(session: CloudAppSession | null): CloudAuthStoreDeps {
  return {
    scheduler: new VirtualTimeScheduler(VirtualAction, Infinity),
    now: () => 0,
    windowFocus$: new Subject<void>(),
    documentVisible$: new Subject<boolean>(),
    cloudAuthStorage$: new Subject<StorageEvent>(),
    readAppSessionStatus: async () => ({ ok: true, session }),
    establishAppSession: async () => {},
  };
}

// The browser API fetch identity and the live-room connection key drive the
// resolveSyncAuth -> live-room effect dependency. The store's projections must
// hold both stable across OIDC token refreshes that do not change the effective
// socket credentials, or the live room tears down and reconnects gratuitously.
describe("cloud session auth stability (store projections)", () => {
  it("holds one cookie-backed browser API fetch auth object across OIDC token churn", () => {
    let current = authState({ token: "token-a" });
    const store = new CloudAuthStore({ readAuthState: () => current });
    const values: CloudPrototypeAuthState[] = [];
    const sub = store.browserApiAuthState$.subscribe((value) => values.push(value));

    current = authState({ token: "token-b" });
    store.refreshAuthState();

    // Non-dev modes collapse to one frozen cookie object, so OIDC token churn
    // does not re-emit and the fetch identity stays reference-stable.
    assert.equal(values.length, 1);
    assert.deepEqual(values[0], {
      mode: "anonymous",
      token: null,
      user: null,
      oidcClaims: null,
      requestedScope: null,
      problem: null,
    });
    sub.unsubscribe();
  });

  it("keys dev-token browser API fetch auth by the dev headers", () => {
    let current = authState({ mode: "dev", token: "dev-a", requestedScope: "owner" });
    const store = new CloudAuthStore({ readAuthState: () => current });
    const values: CloudPrototypeAuthState[] = [];
    const sub = store.browserApiAuthState$.subscribe((value) => values.push(value));

    current = authState({ mode: "dev", token: "dev-b", requestedScope: "owner" });
    store.refreshAuthState();

    assert.equal(values.length, 2);
    assert.equal(values[0].mode, "dev");
    assert.equal(values[0].token, "dev-a");
    assert.equal(values[1].token, "dev-b");
    sub.unsubscribe();
  });

  it("keys the live-room connection to the session transport when an app session exists", () => {
    const session: CloudAppSession = { provider: "oidc", expires_at: 10_000, cache_key: "cache-a" };
    const store = new CloudAuthStore({ readAuthState: () => authState({ token: "token-a" }) });
    const keys: string[] = [];
    const sub = store.syncAuthConnectionKey$.subscribe((key) => keys.push(key));

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: session },
      inertDeps(session),
    );

    assert.equal(keys.at(-1), "app-session");
    sub.unsubscribe();
    dispose();
  });

  it("adopts a live cookie session across OIDC token churn without an establish POST", () => {
    let current = authState({ token: "token-a" });
    let establishCalls = 0;
    const session: CloudAppSession = {
      provider: "oidc",
      expires_at: 100_000,
      cache_key: "cache-a",
    };
    const store = new CloudAuthStore({ readAuthState: () => current });
    const scheduler = new VirtualTimeScheduler(VirtualAction, Infinity);

    const dispose = store.activate(
      { authConfig: { oidc: null, localDev: null }, initialSession: session },
      {
        ...inertDeps(session),
        scheduler,
        establishAppSession: async () => {
          establishCalls += 1;
        },
      },
    );

    // Boot tick adopts the live session; a token rotation alone must not
    // re-validate upstream while the cookie still covers the page.
    advance(scheduler, 0);
    current = authState({ token: "token-b" });
    store.refreshAuthState();
    advance(scheduler, 60_000);

    assert.equal(establishCalls, 0);
    dispose();
  });

  it("keys the live-room connection by effective socket credentials without an app session", () => {
    let current = authState({ token: "token-a" });
    const store = new CloudAuthStore({ readAuthState: () => current });
    const keys: string[] = [];
    const sub = store.syncAuthConnectionKey$.subscribe((key) => keys.push(key));

    current = authState({ token: "token-b" });
    store.refreshAuthState();

    assert.equal(keys[0], "oidc:token-a:user@example.test:owner");
    assert.equal(keys.at(-1), "oidc:token-b:user@example.test:owner");
    sub.unsubscribe();
  });
});
