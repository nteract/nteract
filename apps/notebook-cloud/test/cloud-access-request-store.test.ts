/**
 * Cloud access-request store driver contract tests.
 *
 * RxJS timers run on an injected `VirtualTimeScheduler`; the store's network
 * operations and the visibility gate are injected fakes. Promises settle on the
 * real microtask queue, drained explicitly with `drainMicrotasks`, so cadence is
 * virtual-time total while fetch resolution stays under test control.
 *
 * The load-bearing cases: the fixed-rate poll shares one in-flight guard across
 * the interval and the visibility rise (F4), and a `pending -> granted`
 * transition settles the poll with no infinite re-arm (the reactive-cycle
 * convergence guard).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BehaviorSubject, VirtualAction, VirtualTimeScheduler } from "rxjs";
import {
  CloudAccessRequestStore,
  type CloudAccessRequestInputs,
  type CloudAccessRequestPostResult,
  type CloudAccessRequestStoreDeps,
} from "../viewer/cloud-access-request-store";
import { projectCloudAccessFacts, type CloudAccessSourceFacts } from "../viewer/cloud-access-facts";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { CloudNotebookAccessRequest } from "../viewer/sharing-client";

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

function browserAuth(): CloudPrototypeAuthState {
  return {
    mode: "dev",
    token: "dev-token",
    user: "browser-editor",
    oidcClaims: null,
    requestedScope: "editor",
    problem: null,
  };
}

function accessRequest(
  overrides: Partial<CloudNotebookAccessRequest> = {},
): CloudNotebookAccessRequest {
  return {
    id: "request-1",
    notebook_id: "notebook-1",
    requester_principal: "user:anaconda:quill",
    scope: "editor",
    status: "pending",
    requested_by_actor_label: "user:anaconda:quill/browser:preview",
    resolved_by_actor_label: null,
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}

function baseSource(overrides: Partial<CloudAccessSourceFacts> = {}): CloudAccessSourceFacts {
  return {
    canUseAuthenticatedCloudApi: true,
    catalog: { status: "ready", scope: null },
    connection: { error: null, peerId: "peer-viewer", scope: "viewer", statusKind: "ready" },
    hasBrowserAppIdentity: true,
    request: { error: null, latest: null, requestedByUser: false },
    selectedMode: "edit",
    ...overrides,
  };
}

/** A source whose facts gate the poll on: pending request, load-eligible. */
function pendingSource(): CloudAccessSourceFacts {
  return baseSource({
    request: { error: null, latest: accessRequest({ status: "pending" }), requestedByUser: true },
  });
}

function inputsFrom(
  source: CloudAccessSourceFacts,
  overrides: Partial<CloudAccessRequestInputs> = {},
): CloudAccessRequestInputs {
  return {
    facts: projectCloudAccessFacts(source),
    browserAuth: browserAuth(),
    endpoint: "https://viewer.test/api/access-requests",
    authState: { mode: "dev", requestedScope: "editor" },
    connectionScope: source.connection.scope,
    catalogAccessScope: source.catalog.scope,
    hasAppSession: false,
    ...overrides,
  };
}

/** A `loadOwnAccessRequest` whose promises the test resolves on demand. */
function deferredLoad() {
  const calls: Array<{
    signal: AbortSignal;
    resolve: (value: CloudNotebookAccessRequest | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  const loadOwnAccessRequest = ({ signal }: { signal: AbortSignal }) =>
    new Promise<CloudNotebookAccessRequest | null>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    });
  return { loadOwnAccessRequest, calls };
}

function baseDeps(
  overrides: Partial<CloudAccessRequestStoreDeps> = {},
): CloudAccessRequestStoreDeps {
  return {
    scheduler: newScheduler(),
    now: () => 0,
    documentVisible$: new BehaviorSubject(true),
    notebookId: "notebook-1",
    onRetryLiveConnection: () => {},
    onRefreshAuth: () => {},
    storeRequestedScope: () => {},
    loadOwnAccessRequest: async () => null,
    postEditAccessRequest: async () => ({}),
    ...overrides,
  };
}

describe("CloudAccessRequestStore initial load", () => {
  it("loads once when the gate rises and clears latest (not error) when it falls", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(baseSource()));
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadOwnAccessRequest: async () => {
          loadCalls += 1;
          return accessRequest({ status: "pending" });
        },
      }),
    );

    // baseSource is not load-eligible (no requestedByUser): no fetch.
    await drainMicrotasks();
    assert.equal(loadCalls, 0);

    // The gate rises: one load resolves into `latest`.
    inputs$.next(inputsFrom(pendingSource()));
    await drainMicrotasks();
    assert.equal(loadCalls, 1);
    assert.equal(store.snapshot.latest?.status, "pending");

    // The gate falls: `latest` clears, but a prior error would survive.
    inputs$.next(inputsFrom(baseSource({ selectedMode: "view" })));
    await drainMicrotasks();
    assert.equal(store.snapshot.latest, null);

    dispose();
  });

  it("clearLatest drops the request but leaves a user-facing error", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadOwnAccessRequest: async () => accessRequest({ status: "pending" }),
        postEditAccessRequest: async () => {
          throw new Error("post failed");
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.latest?.status, "pending");

    // A failed edit request records an error without dropping `latest`.
    store.requestEditAccess();
    await drainMicrotasks();
    assert.match(store.snapshot.error ?? "", /post failed/);
    assert.equal(store.snapshot.latest?.status, "pending");

    // Gate falls: `latest` clears, error survives.
    inputs$.next(inputsFrom(baseSource({ selectedMode: "view" })));
    await drainMicrotasks();
    assert.equal(store.snapshot.latest, null);
    assert.match(store.snapshot.error ?? "", /post failed/);

    dispose();
  });
});

describe("CloudAccessRequestStore poll", () => {
  it("polls at the fixed cadence and applies each loaded request", async () => {
    const scheduler = newScheduler();
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    const { loadOwnAccessRequest, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ scheduler, loadOwnAccessRequest }));

    // The initial-load driver fires immediately on the eligible gate.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].resolve(accessRequest({ status: "pending" }));
    await drainMicrotasks();

    // The 30s cadence drives the next poll.
    advanceBy(scheduler, 30_000);
    assert.equal(calls.length, 2);
    calls[1].resolve(accessRequest({ status: "pending" }));
    await drainMicrotasks();

    advanceBy(scheduler, 30_000);
    assert.equal(calls.length, 3);

    dispose();
  });

  it("drops a tick while hidden and fires an immediate poll on becoming visible (F4)", async () => {
    const scheduler = newScheduler();
    const visible$ = new BehaviorSubject(true);
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    const { loadOwnAccessRequest, calls } = deferredLoad();
    const dispose = store.activate(
      inputs$,
      baseDeps({ scheduler, documentVisible$: visible$, loadOwnAccessRequest }),
    );

    // Initial load in flight; settle it.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].resolve(accessRequest({ status: "pending" }));
    await drainMicrotasks();

    // Hidden: the cadence tick is dropped.
    visible$.next(false);
    advanceBy(scheduler, 30_000);
    assert.equal(calls.length, 1);

    // Visible again: the false->true rise fires one immediate poll.
    visible$.next(true);
    assert.equal(calls.length, 2);

    dispose();
  });

  it("does not double-fetch when the visibility rise lands mid-poll (F4)", async () => {
    const scheduler = newScheduler();
    const visible$ = new BehaviorSubject(true);
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    const { loadOwnAccessRequest, calls } = deferredLoad();
    const dispose = store.activate(
      inputs$,
      baseDeps({ scheduler, documentVisible$: visible$, loadOwnAccessRequest }),
    );

    // Settle the separate initial load so only the poll is in flight.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].resolve(accessRequest({ status: "pending" }));
    await drainMicrotasks();

    // A poll fetch is now in flight (unresolved).
    advanceBy(scheduler, 30_000);
    assert.equal(calls.length, 2);

    // A visibility rise while the poll fetch is in flight shares the poll's one
    // in-flight guard: exhaustMap drops it rather than starting a second request.
    visible$.next(false);
    visible$.next(true);
    assert.equal(calls.length, 2);

    dispose();
  });

  it("stops polling once access is granted, with no infinite re-arm", async () => {
    const scheduler = newScheduler();
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadOwnAccessRequest: async () => {
          loadCalls += 1;
          return accessRequest({ status: "pending" });
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(loadCalls, 1);
    advanceBy(scheduler, 30_000);
    await drainMicrotasks();
    assert.equal(loadCalls, 2);

    // The catalog now grants edit: the effective request goes null, so the poll
    // gate closes. Further time drives no more fetches (no infinite re-arm).
    inputs$.next(inputsFrom(baseSource({ catalog: { status: "ready", scope: "owner" } })));
    advanceBy(scheduler, 120_000);
    await drainMicrotasks();
    assert.equal(loadCalls, 2);

    dispose();
  });

  it("swallows a failed poll and keeps polling", async () => {
    const scheduler = newScheduler();
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    let call = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadOwnAccessRequest: async () => {
          call += 1;
          if (call === 1) {
            throw new Error("boom");
          }
          return accessRequest({ status: "pending" });
        },
      }),
    );
    // Initial load rejects: no latest, no error, stream survives.
    await drainMicrotasks();
    const afterReject = store.snapshot;
    assert.equal(afterReject.latest, null);
    assert.equal(afterReject.error, null);

    advanceBy(scheduler, 30_000);
    await drainMicrotasks();
    assert.equal(call, 2);
    const afterPoll = store.snapshot;
    assert.equal(afterPoll.latest?.status, "pending");

    dispose();
  });

  it("aborts the in-flight fetch on dispose", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    const { loadOwnAccessRequest, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ loadOwnAccessRequest }));
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);

    dispose();
    assert.equal(calls[0].signal.aborted, true);
  });
});

describe("CloudAccessRequestStore transitions", () => {
  it("retries the live room when a loaded request is approved", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(pendingSource()));
    let retries = 0;
    const scopes: string[] = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        onRetryLiveConnection: () => (retries += 1),
        storeRequestedScope: (scope) => scopes.push(scope),
        loadOwnAccessRequest: async () => accessRequest({ status: "approved" }),
      }),
    );
    await drainMicrotasks();

    assert.equal(store.snapshot.latest?.status, "approved");
    assert.equal(retries, 1);
    assert.deepEqual(scopes, ["editor"]);

    dispose();
  });

  it("refreshes token-backed auth when a pending edit request changes scope", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(
      inputsFrom(pendingSource(), {
        authState: { mode: "oidc", requestedScope: "viewer" },
        hasAppSession: false,
      }),
    );
    let refreshes = 0;
    const scopes: string[] = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        onRefreshAuth: () => (refreshes += 1),
        storeRequestedScope: (scope) => scopes.push(scope),
        loadOwnAccessRequest: async () => accessRequest({ status: "pending" }),
      }),
    );
    await drainMicrotasks();

    assert.equal(refreshes, 1);
    assert.deepEqual(scopes, ["editor"]);

    dispose();
  });
});

describe("CloudAccessRequestStore edit-access request", () => {
  it("records intent, applies a granted response as approved, and retries the room", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(baseSource()));
    let retries = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        now: () => 1_700_000_000_000,
        onRetryLiveConnection: () => (retries += 1),
        postEditAccessRequest: async (): Promise<CloudAccessRequestPostResult> => ({
          accessStatus: "granted",
        }),
      }),
    );

    store.requestEditAccess();
    assert.equal(store.snapshot.requestedByUser, true);
    await drainMicrotasks();

    assert.equal(store.snapshot.latest?.id, "already-granted");
    assert.equal(store.snapshot.latest?.status, "approved");
    assert.equal(retries, 1);

    dispose();
  });

  it("surfaces a failed edit request as an error and holds the intent flag", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(baseSource()));
    const dispose = store.activate(
      inputs$,
      baseDeps({
        postEditAccessRequest: async () => {
          throw new Error("request rejected");
        },
      }),
    );

    store.requestEditAccess();
    await drainMicrotasks();

    assert.equal(store.snapshot.requestedByUser, true);
    assert.match(store.snapshot.error ?? "", /request rejected/);

    dispose();
  });
});

describe("CloudAccessRequestStore selected mode", () => {
  it("resets the edit-intent flag only when the mode leaves edit", async () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(baseSource()));
    const dispose = store.activate(
      inputs$,
      baseDeps({
        postEditAccessRequest: async () => ({
          accessRequest: accessRequest({ status: "pending" }),
        }),
      }),
    );

    // A pending response keeps the viewer in edit mode, holding the intent flag.
    store.requestEditAccess();
    await drainMicrotasks();
    assert.equal(store.snapshot.selectedMode, "edit");
    assert.equal(store.snapshot.requestedByUser, true);

    // Staying in edit keeps the intent.
    store.setSelectedMode("edit");
    assert.equal(store.snapshot.requestedByUser, true);

    // Leaving edit drops it.
    store.setSelectedMode("view");
    assert.equal(store.snapshot.selectedMode, "view");
    assert.equal(store.snapshot.requestedByUser, false);

    dispose();
  });

  it("applies access-derived mode corrections pushed through the facts gate", () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    // A copied edit link denied by fresh catalog facts falls back to view.
    const denied = baseSource({
      catalog: { status: "ready", scope: null },
      connection: { error: null, peerId: "peer-viewer", scope: "viewer", statusKind: "ready" },
      request: { error: null, latest: null, requestedByUser: false },
    });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(denied));
    const dispose = store.activate(inputs$, baseDeps());

    assert.equal(store.snapshot.selectedMode, "view");

    dispose();
  });

  it("reset returns to view mode and drops the request and error", () => {
    const store = new CloudAccessRequestStore({ readSelectedMode: () => "edit" });
    const inputs$ = new BehaviorSubject<CloudAccessRequestInputs>(inputsFrom(baseSource()));
    const dispose = store.activate(inputs$, baseDeps());

    store.reset();
    assert.equal(store.snapshot.selectedMode, "view");
    assert.equal(store.snapshot.latest, null);
    assert.equal(store.snapshot.error, null);
    assert.equal(store.snapshot.requestedByUser, false);

    dispose();
  });
});
