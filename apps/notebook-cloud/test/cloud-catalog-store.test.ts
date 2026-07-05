/**
 * Cloud catalog store driver contract tests.
 *
 * The store owns catalog access (scope/resolved/load-failure) and the notebook
 * title. Its one network operation - `loadCatalogAccess` - is an injected fake,
 * and `fetchLatest`'s `switchMap` replaces the effect's hand-rolled cancelled
 * flag, so the load-bearing cases run headlessly: a superseded load's signal
 * aborts (F1/F3), an SSR seed survives exactly one fetch, a load failure surfaces
 * through the title error, the title has a single writer, and a signed-out flip
 * clears catalog scope and title together.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BehaviorSubject, type Observable } from "rxjs";
import { CloudCatalogStore, type CloudCatalogInputs } from "../viewer/cloud-catalog-store";
import type { CloudNotebookCatalogAccessLoadResult } from "../viewer/cloud-notebook-catalog-access";

/** Let queued microtasks (promise `.then` chains) run to completion. */
async function drainMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** A `loadCatalogAccess` whose promises the test resolves on demand. */
function deferredLoad() {
  const calls: Array<{
    signal: AbortSignal;
    resolve: (value: CloudNotebookCatalogAccessLoadResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  const loadCatalogAccess = (signal: AbortSignal) =>
    new Promise<CloudNotebookCatalogAccessLoadResult>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    });
  return { loadCatalogAccess, calls };
}

/** Collect every emission from a synchronous projection. */
function collect<T>(observable: Observable<T>): { values: T[]; stop: () => void } {
  const values: T[] = [];
  const subscription = observable.subscribe((value) => values.push(value));
  return { values, stop: () => subscription.unsubscribe() };
}

function inputs(overrides: Partial<CloudCatalogInputs> = {}): CloudCatalogInputs {
  return {
    canUseAuthenticatedCloudApi: true,
    loadCatalogAccess: async () => ({ catalogResolved: true, catalogScope: "viewer" }),
    ...overrides,
  };
}

describe("CloudCatalogStore fetch driver", () => {
  it("resolves catalog scope and title from a successful load", async () => {
    const store = new CloudCatalogStore();
    const { loadCatalogAccess, calls } = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(inputs({ loadCatalogAccess }));
    const dispose = store.activate(inputs$);

    assert.equal(calls.length, 1);
    calls[0].resolve({ catalogResolved: true, catalogScope: "owner", catalogTitle: "Room" });
    await drainMicrotasks();

    assert.equal(store.snapshot.scope, "owner");
    assert.equal(store.snapshot.resolved, true);
    assert.equal(store.snapshot.loadFailed, false);
    assert.equal(store.snapshot.title, "Room");

    dispose();
  });

  it("aborts the prior request when the loader identity changes", async () => {
    const store = new CloudCatalogStore();
    const first = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(
      inputs({ loadCatalogAccess: first.loadCatalogAccess }),
    );
    const dispose = store.activate(inputs$);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].signal.aborted, false);

    // A new loader identity switchMaps away the in-flight load and aborts it.
    const second = deferredLoad();
    inputs$.next(inputs({ loadCatalogAccess: second.loadCatalogAccess }));
    assert.equal(first.calls[0].signal.aborted, true);
    assert.equal(second.calls.length, 1);

    dispose();
  });

  it("aborts the in-flight fetch on dispose", async () => {
    const store = new CloudCatalogStore();
    const { loadCatalogAccess, calls } = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(inputs({ loadCatalogAccess }));
    const dispose = store.activate(inputs$);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);

    dispose();
    assert.equal(calls[0].signal.aborted, true);
  });

  it("surfaces a load failure through loadFailed and the title error", async () => {
    const store = new CloudCatalogStore();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(
      inputs({
        loadCatalogAccess: async () => {
          throw new Error("catalog boom");
        },
      }),
    );
    const dispose = store.activate(inputs$);
    await drainMicrotasks();

    assert.equal(store.snapshot.loadFailed, true);
    assert.equal(store.snapshot.resolved, false);
    assert.equal(store.snapshot.scope, null);
    assert.equal(store.snapshot.title, undefined);
    assert.match(store.snapshot.titleError ?? "", /catalog boom/);

    dispose();
  });

  it("clears catalog scope and title together on a signed-out flip", async () => {
    const store = new CloudCatalogStore();
    store.seedFromSsr({ scope: "owner", title: "Room" }, true);
    const { loadCatalogAccess, calls } = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(inputs({ loadCatalogAccess }));
    const dispose = store.activate(inputs$);
    calls[0].resolve({ catalogResolved: true, catalogScope: "owner", catalogTitle: "Room" });
    await drainMicrotasks();
    assert.equal(store.snapshot.scope, "owner");

    // Losing the authenticated gate clears every catalog + title field.
    inputs$.next(inputs({ canUseAuthenticatedCloudApi: false, loadCatalogAccess }));
    await drainMicrotasks();
    assert.deepEqual(store.snapshot, {
      scope: null,
      resolved: false,
      loadFailed: false,
      title: undefined,
      titleError: null,
    });

    dispose();
  });
});

describe("CloudCatalogStore SSR seed", () => {
  it("preserves a seeded catalog through exactly one fetch, then resets to loading", async () => {
    const store = new CloudCatalogStore();
    store.seedFromSsr({ scope: "owner", title: "Seeded" }, true);
    assert.equal(store.snapshot.scope, "owner");
    assert.equal(store.snapshot.resolved, true);
    assert.equal(store.snapshot.title, "Seeded");

    const first = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(
      inputs({ loadCatalogAccess: first.loadCatalogAccess }),
    );
    const dispose = store.activate(inputs$);

    // The first fetch is in flight: the seed is preserved, not reset to loading.
    assert.equal(first.calls.length, 1);
    assert.equal(store.snapshot.scope, "owner");
    assert.equal(store.snapshot.resolved, true);
    assert.equal(store.snapshot.title, "Seeded");
    first.calls[0].resolve({
      catalogResolved: true,
      catalogScope: "editor",
      catalogTitle: "Editor",
    });
    await drainMicrotasks();
    assert.equal(store.snapshot.scope, "editor");

    // A later loader identity change resets to loading (the seed was consumed).
    const second = deferredLoad();
    inputs$.next(inputs({ loadCatalogAccess: second.loadCatalogAccess }));
    assert.equal(store.snapshot.scope, null);
    assert.equal(store.snapshot.resolved, false);
    assert.equal(store.snapshot.title, undefined);

    dispose();
  });
});

describe("CloudCatalogStore title writer", () => {
  it("writes the title only through applyLoaded and applyTitleSaved", async () => {
    const store = new CloudCatalogStore();
    const { loadCatalogAccess, calls } = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(inputs({ loadCatalogAccess }));
    const dispose = store.activate(inputs$);

    // A list-based load (no catalogTitle key) leaves the title untouched.
    calls[0].resolve({ catalogResolved: true, catalogScope: "viewer" });
    await drainMicrotasks();
    assert.equal(store.snapshot.title, undefined);

    // A successful rename is the other title writer; it clears the title error.
    store.applyTitleSaveFailure("stale error");
    store.applyTitleSaved("Renamed");
    assert.equal(store.snapshot.title, "Renamed");
    assert.equal(store.snapshot.titleError, null);

    dispose();
  });

  it("records a rename failure without touching the title", () => {
    const store = new CloudCatalogStore();
    store.applyTitleSaved("Kept");
    store.applyTitleSaveFailure("rename rejected");
    assert.equal(store.snapshot.title, "Kept");
    assert.match(store.snapshot.titleError ?? "", /rename rejected/);

    store.clearTitleError();
    assert.equal(store.snapshot.titleError, null);
    assert.equal(store.snapshot.title, "Kept");
  });
});

describe("CloudCatalogStore projections", () => {
  it("projects idle, loading, ready, and error facts keyed on the authenticated gate", async () => {
    const store = new CloudCatalogStore();
    const { loadCatalogAccess, calls } = deferredLoad();
    const facts = collect(store.catalogAccessFacts$);
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(
      inputs({ canUseAuthenticatedCloudApi: false, loadCatalogAccess }),
    );
    const dispose = store.activate(inputs$);

    // Not authenticated: idle, no scope.
    assert.deepEqual(facts.values.at(-1), { status: "idle", scope: null });

    // Authenticated but unresolved: loading.
    inputs$.next(inputs({ canUseAuthenticatedCloudApi: true, loadCatalogAccess }));
    assert.deepEqual(facts.values.at(-1), { status: "loading", scope: null });

    // Resolved with a scope: ready.
    calls[0].resolve({ catalogResolved: true, catalogScope: "editor" });
    await drainMicrotasks();
    assert.deepEqual(facts.values.at(-1), { status: "ready", scope: "editor" });
    assert.deepEqual(store.catalogAccessFactsSnapshot, { status: "ready", scope: "editor" });

    facts.stop();
    dispose();
  });

  it("projects the live-room policy from the catalog facts", async () => {
    const store = new CloudCatalogStore();
    const policy = collect(store.catalogLiveRoomPolicy$);
    const { loadCatalogAccess, calls } = deferredLoad();
    const inputs$ = new BehaviorSubject<CloudCatalogInputs>(inputs({ loadCatalogAccess }));
    const dispose = store.activate(inputs$);

    // Authenticated + unresolved holds the live room with a loading status.
    assert.equal(policy.values.at(-1)?.shouldConnectLiveRoom, false);
    assert.equal(policy.values.at(-1)?.disabledStatus?.kind, "loading");

    // A granted scope releases the live room.
    calls[0].resolve({ catalogResolved: true, catalogScope: "owner" });
    await drainMicrotasks();
    assert.deepEqual(policy.values.at(-1), { shouldConnectLiveRoom: true, disabledStatus: null });

    policy.stop();
    dispose();
  });
});
