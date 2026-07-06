/**
 * Cloud user store driver contract tests.
 *
 * Backfill promises settle on the real microtask queue, drained with
 * `drainMicrotasks`, while network operations and future clocks are injected.
 * The store has no timer today, so the virtual scheduler is present to preserve
 * the house pattern and keep the driver contract virtual-time total.
 *
 * The load-bearing cases: presence and self seed through the same precedence
 * merge, cached and in-flight principals are deduped, author-profile backfills
 * chunk and cache unresolved relationship-gate omissions, same-rank writes never
 * null out existing content, stale completions drop on dispose/re-activate or
 * endpoint changes, and sign-out clears cached identity plus in-flight writes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BehaviorSubject, VirtualAction, VirtualTimeScheduler } from "rxjs";
import { COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE } from "../viewer/comment-author-profiles";
import {
  CloudUserStore,
  type CloudResolvedProfile,
  type CloudUserStoreDeps,
  type CloudUserStoreInputs,
} from "../viewer/cloud-user-store";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { CloudViewerPresenceState } from "../viewer/presence";

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

const STABLE_AUTH: CloudPrototypeAuthState = {
  mode: "dev",
  token: "dev-token",
  user: "Owner User",
  oidcClaims: null,
  requestedScope: "owner",
  problem: null,
};

const OIDC_AUTH: CloudPrototypeAuthState = {
  mode: "oidc",
  token: "oidc-token",
  user: "Owner User",
  oidcClaims: {
    sub: "owner-sub",
    email: "owner@example.com",
    name: "Owner Claims",
    picture: "https://cdn.example.com/owner.png",
  },
  requestedScope: "owner",
  problem: null,
};

const SIGNED_OUT_AUTH: CloudPrototypeAuthState = {
  mode: "anonymous",
  token: null,
  user: null,
  oidcClaims: null,
  requestedScope: null,
  problem: null,
};

function actor(index: number): string {
  return `user:anaconda:actor-${index}`;
}

function baseInputs(overrides: Partial<CloudUserStoreInputs> = {}): CloudUserStoreInputs {
  return {
    auth: STABLE_AUTH,
    authorProfilesEndpoint: "/api/n/nb-1/author-profiles",
    ...overrides,
  };
}

function baseDeps(overrides: Partial<CloudUserStoreDeps> = {}): CloudUserStoreDeps {
  return {
    scheduler: newScheduler(),
    now: () => 0,
    fetchProfiles: async () => jsonResponse({ profiles: [] }),
    ...overrides,
  };
}

function presenceState(
  overrides: Partial<CloudViewerPresenceState> = {},
): CloudViewerPresenceState {
  return {
    connection: "connected",
    ownPeerId: null,
    actorLabel: null,
    ownPeerLabel: null,
    peers: [],
    roomPeerCount: 1,
    runtimePeerCount: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetchProfiles` whose promises the test resolves on demand. */
function deferredFetch() {
  const calls: Array<{
    url: string;
    signal?: AbortSignal;
    resolve: (value: Response) => void;
    reject: (error: unknown) => void;
  }> = [];
  const fetchProfiles = (url: string, signal?: AbortSignal) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, signal, resolve, reject });
    });
  return { fetchProfiles, calls };
}

function profile(store: CloudUserStore, principal: string): CloudResolvedProfile | undefined {
  return store.snapshot.profiles.get(principal);
}

function activateStore(
  options: {
    deps?: Partial<CloudUserStoreDeps>;
    inputs?: Partial<CloudUserStoreInputs>;
  } = {},
): {
  dispose: () => void;
  inputs$: BehaviorSubject<CloudUserStoreInputs>;
  store: CloudUserStore;
} {
  const store = new CloudUserStore();
  const inputs$ = new BehaviorSubject<CloudUserStoreInputs>(baseInputs(options.inputs));
  const dispose = store.activate(inputs$, baseDeps(options.deps));
  return { dispose, inputs$, store };
}

describe("CloudUserStore seeding", () => {
  it("seeds presence peers and self, including the self avatar from auth claims", () => {
    const store = new CloudUserStore();

    store.seedFromPresence(
      presenceState({
        actorLabel: "user:oidc:owner-sub",
        ownPeerLabel: "Owner Room",
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Peer One",
            connectionScope: null,
            kind: "peer",
            status: "active",
          },
        ],
      }),
      OIDC_AUTH,
    );

    assert.deepEqual(profile(store, actor(1)), {
      principal: actor(1),
      displayName: "Peer One",
      avatarUrl: null,
      source: "presence",
    });
    assert.deepEqual(profile(store, "user:oidc:owner-sub"), {
      principal: "user:oidc:owner-sub",
      displayName: "Owner Room",
      avatarUrl: "https://cdn.example.com/owner.png",
      source: "self",
    });
  });

  it("keeps a fetched profile when a presence snapshot later carries the same principal", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    store.requestResolve([actor(1)]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [
          {
            principal: actor(1),
            label: "Fetched Peer",
            image_url: "https://cdn.example.com/p.png",
            resolved: true,
          },
        ],
      }),
    );
    await drainMicrotasks();

    store.seedFromPresence(
      presenceState({
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Presence Peer",
            connectionScope: null,
            kind: "peer",
            status: "active",
          },
        ],
      }),
      STABLE_AUTH,
    );

    assert.deepEqual(profile(store, actor(1)), {
      principal: actor(1),
      displayName: "Fetched Peer",
      avatarUrl: "https://cdn.example.com/p.png",
      source: "profile",
    });
    dispose();
  });

  it("dedupes repeated snapshots without state churn", () => {
    const store = new CloudUserStore();
    let emissions = 0;
    const sub = store.profiles$.subscribe(() => {
      emissions += 1;
    });
    const state = presenceState({
      peers: [
        {
          id: "peer-1",
          participantKey: actor(1),
          label: "Peer One",
          connectionScope: null,
          kind: "peer",
          status: "active",
        },
      ],
    });

    store.seedFromPresence(state, STABLE_AUTH);
    store.seedFromPresence(state, STABLE_AUTH);

    assert.equal(emissions, 2);
    sub.unsubscribe();
  });
});

describe("CloudUserStore backfill", () => {
  it("dedupes cached and in-flight principals", async () => {
    const scheduler = newScheduler();
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({
      deps: { fetchProfiles: fetch.fetchProfiles, scheduler },
    });

    store.requestResolve([actor(1), actor(1)]);
    store.requestResolve([actor(1)]);
    advanceBy(scheduler, 1_000);

    assert.equal(fetch.calls.length, 1);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: null, image_url: null, resolved: false }],
      }),
    );
    await drainMicrotasks();
    assert.equal(profile(store, actor(1))?.source, "unresolved");

    store.requestResolve([actor(1)]);
    assert.equal(fetch.calls.length, 1);
    dispose();
  });

  it("chunks sequentially by the shared author-profile batch constant", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    const labels = Array.from({ length: COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE + 1 }, (_, i) =>
      actor(i),
    );

    store.requestResolve(labels);
    assert.equal(fetch.calls.length, 1);
    assert.equal(
      new URL(`http://unit.test${fetch.calls[0]?.url}`).searchParams.getAll("actor_label").length,
      COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE,
    );

    fetch.calls[0]?.resolve(jsonResponse({ profiles: [] }));
    await drainMicrotasks();
    assert.equal(fetch.calls.length, 2);
    assert.equal(
      new URL(`http://unit.test${fetch.calls[1]?.url}`).searchParams.getAll("actor_label").length,
      1,
    );

    fetch.calls[1]?.resolve(jsonResponse({ profiles: [] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.profiles.size, COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE + 1);
    dispose();
  });

  it("caches resolved false and absent principals as unresolved and does not refetch them", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });

    store.requestResolve([actor(1), actor(2)]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: null, image_url: null, resolved: false }],
      }),
    );
    await drainMicrotasks();

    assert.equal(profile(store, actor(1))?.source, "unresolved");
    assert.equal(profile(store, actor(2))?.source, "unresolved");

    store.requestResolve([actor(1), actor(2)]);
    assert.equal(fetch.calls.length, 1);
    dispose();
  });

  it("upgrades a presence entry when a resolved profile arrives", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    store.seedFromPresence(
      presenceState({
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Presence Peer",
            connectionScope: null,
            kind: "peer",
            status: "active",
          },
        ],
      }),
      STABLE_AUTH,
    );

    store.requestResolve([actor(2)]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [
          {
            principal: actor(2),
            label: "Profile Peer",
            image_url: "https://cdn.example.com/p.png",
            resolved: true,
          },
        ],
      }),
    );
    await drainMicrotasks();

    assert.equal(profile(store, actor(1))?.source, "presence");
    assert.deepEqual(profile(store, actor(2)), {
      principal: actor(2),
      displayName: "Profile Peer",
      avatarUrl: "https://cdn.example.com/p.png",
      source: "profile",
    });
    dispose();
  });
});

describe("CloudUserStore never demote", () => {
  it("leaves cached profiles intact on rejected and non-ok batches", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    store.seedFromPresence(
      presenceState({
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Peer One",
            connectionScope: null,
            kind: "peer",
            status: "active",
          },
        ],
      }),
      STABLE_AUTH,
    );

    store.requestResolve([actor(2)]);
    fetch.calls[0]?.reject(new Error("network down"));
    await drainMicrotasks();

    store.requestResolve([actor(2)]);
    fetch.calls[1]?.resolve(jsonResponse({ profiles: [] }, 503));
    await drainMicrotasks();

    assert.deepEqual(profile(store, actor(1)), {
      principal: actor(1),
      displayName: "Peer One",
      avatarUrl: null,
      source: "presence",
    });
    assert.equal(profile(store, actor(2)), undefined);
    dispose();
  });

  it("does not clear unrelated cached profiles when a batch response is empty", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    store.seedFromPresence(
      presenceState({
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Peer One",
            connectionScope: null,
            kind: "peer",
            status: "active",
          },
        ],
      }),
      STABLE_AUTH,
    );

    store.requestResolve([actor(2)]);
    fetch.calls[0]?.resolve(jsonResponse({ profiles: [] }));
    await drainMicrotasks();

    assert.equal(profile(store, actor(1))?.displayName, "Peer One");
    assert.equal(profile(store, actor(2))?.source, "unresolved");
    dispose();
  });

  it("does not null out an existing avatar at the same profile rank", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });

    store.requestResolve([actor(1)]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [
          {
            principal: actor(1),
            label: "Profile Peer",
            image_url: "https://cdn.example.com/p.png",
            resolved: true,
          },
          { principal: actor(1), label: "Profile Peer", image_url: null, resolved: true },
        ],
      }),
    );
    await drainMicrotasks();

    assert.equal(profile(store, actor(1))?.avatarUrl, "https://cdn.example.com/p.png");
    dispose();
  });
});

describe("CloudUserStore stale-completion guards", () => {
  it("drops a fetch that resolves after dispose", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });

    store.requestResolve([actor(1)]);
    dispose();
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: "Too Late", image_url: null, resolved: true }],
      }),
    );
    await drainMicrotasks();

    assert.equal(store.snapshot.profiles.size, 0);
  });

  it("drops an old fetch that resolves after re-activation", async () => {
    const fetch = deferredFetch();
    const { dispose, inputs$, store } = activateStore({
      deps: { fetchProfiles: fetch.fetchProfiles },
    });
    store.requestResolve([actor(1)]);
    dispose();

    const disposeAgain = store.activate(inputs$, baseDeps({ fetchProfiles: fetch.fetchProfiles }));
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: "Old Peer", image_url: null, resolved: true }],
      }),
    );
    await drainMicrotasks();

    assert.equal(profile(store, actor(1)), undefined);
    store.requestResolve([actor(1)]);
    assert.equal(fetch.calls.length, 2);
    fetch.calls[1]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: "Current Peer", image_url: null, resolved: true }],
      }),
    );
    await drainMicrotasks();
    assert.equal(profile(store, actor(1))?.displayName, "Current Peer");
    disposeAgain();
  });

  it("drops a fetch whose endpoint changed before completion", async () => {
    const fetch = deferredFetch();
    const { dispose, inputs$, store } = activateStore({
      deps: { fetchProfiles: fetch.fetchProfiles },
    });

    store.requestResolve([actor(1)]);
    inputs$.next(baseInputs({ authorProfilesEndpoint: "/api/n/nb-2/author-profiles" }));
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [
          { principal: actor(1), label: "Wrong Notebook", image_url: null, resolved: true },
        ],
      }),
    );
    await drainMicrotasks();

    assert.equal(profile(store, actor(1)), undefined);
    store.requestResolve([actor(1)]);
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1]?.url ?? "", /^\/api\/n\/nb-2\/author-profiles/);
    dispose();
  });
});

describe("CloudUserStore signed-out gate", () => {
  it("resets the map, bumps the epoch, and drops in-flight completions", async () => {
    const fetch = deferredFetch();
    const { dispose, inputs$, store } = activateStore({
      deps: { fetchProfiles: fetch.fetchProfiles },
    });
    store.seedFromPresence(
      presenceState({
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Peer One",
            connectionScope: null,
            kind: "peer",
            status: "active",
          },
        ],
      }),
      STABLE_AUTH,
    );
    store.requestResolve([actor(2)]);

    inputs$.next(baseInputs({ auth: SIGNED_OUT_AUTH }));
    assert.equal(store.snapshot.profiles.size, 0);

    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(2), label: "Too Late", image_url: null, resolved: true }],
      }),
    );
    await drainMicrotasks();

    assert.equal(store.snapshot.profiles.size, 0);
    dispose();
  });
});

describe("CloudUserStore resolve", () => {
  it("uses a cached profile as the ActorDisplay peer directory", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    store.requestResolve([actor(1)]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [
          {
            principal: actor(1),
            label: "Profile Peer",
            image_url: "https://cdn.example.com/p.png",
            resolved: true,
          },
        ],
      }),
    );
    await drainMicrotasks();

    const display = store.resolve(actor(1));
    assert.equal(display.displayName, "Profile Peer");
    assert.equal(display.imageUrl, "https://cdn.example.com/p.png");
    dispose();
  });

  it("falls back through resolveActorDisplay without returning a raw Anaconda principal", () => {
    const store = new CloudUserStore();
    const actorLabel = "user:anaconda:550e8400-e29b-41d4-a716-446655440000";

    const display = store.resolve(actorLabel);

    assert.notEqual(display.displayName, actorLabel);
    assert.notEqual(display.displayName, "550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("CloudUserStore cross-rank merges, renewal, and route swaps", () => {
  it("keeps the self avatar when a resolved profile arrives without one", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });
    const selfLabel = "user:anaconda:actor-self/browser:tab";

    store.seedFromPresence(
      presenceState({ actorLabel: selfLabel, ownPeerLabel: "Owner Claims" }),
      OIDC_AUTH,
    );
    assert.equal(
      profile(store, "user:anaconda:actor-self")?.avatarUrl,
      OIDC_AUTH.oidcClaims?.picture,
    );

    // A profile row outranks the self seed, but its null avatar must not erase
    // the avatar the auth claims already supplied.
    store.requestResolve([selfLabel]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [
          {
            principal: "user:anaconda:actor-self",
            label: "Owner Profile",
            image_url: null,
            resolved: true,
          },
        ],
      }),
    );
    await drainMicrotasks();

    const merged = profile(store, "user:anaconda:actor-self");
    assert.equal(merged?.source, "profile");
    assert.equal(merged?.displayName, "Owner Profile");
    assert.equal(merged?.avatarUrl, OIDC_AUTH.oidcClaims?.picture);
    dispose();
  });

  it("keeps cached identities across an oidc_expired renewal window", async () => {
    const fetch = deferredFetch();
    const { dispose, inputs$, store } = activateStore({
      inputs: { auth: OIDC_AUTH },
      deps: { fetchProfiles: fetch.fetchProfiles },
    });

    store.requestResolve([actor(1)]);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: "Mara Osei", image_url: null, resolved: true }],
      }),
    );
    await drainMicrotasks();
    assert.equal(profile(store, actor(1))?.displayName, "Mara Osei");

    // Token renewal is the same principal mid-refresh, not a sign-out.
    inputs$.next(baseInputs({ auth: { ...OIDC_AUTH, mode: "oidc_expired" } }));

    assert.equal(profile(store, actor(1))?.displayName, "Mara Osei");
    dispose();
  });

  it("keeps a presence name the endpoint declined to upgrade and stops refetching it", async () => {
    const fetch = deferredFetch();
    const { dispose, store } = activateStore({ deps: { fetchProfiles: fetch.fetchProfiles } });

    store.seedFromPresence(
      presenceState({
        peers: [
          {
            id: "peer-1",
            participantKey: actor(1),
            label: "Roster Name",
            connectionScope: "editor",
            kind: "peer",
            status: "active",
          },
        ],
      }),
      STABLE_AUTH,
    );

    // Presence seeds stay backfill-eligible, so the first request fetches.
    store.requestResolve([actor(1)]);
    assert.equal(fetch.calls.length, 1);
    fetch.calls[0]?.resolve(
      jsonResponse({
        profiles: [{ principal: actor(1), label: null, image_url: null, resolved: false }],
      }),
    );
    await drainMicrotasks();

    // The unresolved answer neither demotes the roster name nor re-arms a fetch.
    assert.equal(profile(store, actor(1))?.displayName, "Roster Name");
    assert.equal(profile(store, actor(1))?.source, "presence");
    store.requestResolve([actor(1)]);
    assert.equal(fetch.calls.length, 1);
    dispose();
  });

  it("re-checks unresolved principals against a new notebook endpoint", async () => {
    const fetch = deferredFetch();
    const { dispose, inputs$, store } = activateStore({
      deps: { fetchProfiles: fetch.fetchProfiles },
    });

    store.requestResolve([actor(1)]);
    fetch.calls[0]?.resolve(jsonResponse({ profiles: [] }));
    await drainMicrotasks();
    assert.equal(profile(store, actor(1))?.source, "unresolved");

    // Unresolved is a per-relationship fact; the next notebook may resolve it.
    inputs$.next(baseInputs({ authorProfilesEndpoint: "/api/n/nb-2/author-profiles" }));

    assert.equal(profile(store, actor(1)), undefined);
    store.requestResolve([actor(1)]);
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1]?.url ?? "", /nb-2/);
    dispose();
  });
});
