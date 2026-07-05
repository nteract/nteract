/**
 * Cloud workstations store driver contract tests.
 *
 * RxJS timers run on an injected `VirtualTimeScheduler`; the registry/pairing
 * network operations and the pairing-expiry clock are injected fakes. Promises
 * settle on the real microtask queue, drained with `drainMicrotasks`, so cadence
 * is virtual-time total while fetch resolution stays under test control.
 *
 * The load-bearing cases: the dynamic registry cadence reacts to the store's own
 * mutation kind, the after-settle poll cannot overlap and swallows failures while
 * the initial load surfaces them, the pairing poll auto-stops and drops a
 * stale-id response, the expiry clock reads `deps.now()` (never `Date.now`), the
 * attach mutation clears on a cross-channel runtime confirm, the auth-flip wipe
 * is scoped to the surface's closed-gate, an imperative mutation resolving after
 * an auth flip or dispose drops its completion, and a closed gate clears the
 * pairing and mutation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BehaviorSubject, VirtualAction, VirtualTimeScheduler } from "rxjs";
import type { NotebookRegisteredWorkstation, WorkstationAttachmentState } from "runtimed";
import {
  CloudWorkstationsStore,
  type CloudWorkstationsInputs,
  type CloudWorkstationsRegistry,
  type CloudWorkstationsStoreDeps,
} from "../viewer/cloud-workstations-store";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type {
  CloudWorkstationPairingStatusState,
  MintedCloudWorkstationPairing,
} from "../viewer/workstations-client";

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

/**
 * One stable auth object reused across pushes. The live `authState` projection
 * is reference-stable (deduped), so a fetch identity change is a new reference;
 * allocating a fresh object per push would re-fire the gate load spuriously.
 */
const STABLE_AUTH: CloudPrototypeAuthState = {
  mode: "dev",
  token: "dev-token",
  user: "owner",
  oidcClaims: null,
  requestedScope: "owner",
  problem: null,
};

function workstation(id: string, displayName: string): NotebookRegisteredWorkstation {
  return {
    id,
    displayName,
    provider: "runtime_peer",
    providerLabel: null,
    status: "online",
    statusMessage: null,
    defaultEnvironmentLabel: "Current Python",
    environmentPolicy: "current_python",
    workingDirectory: null,
    cpuCount: null,
    memoryBytes: null,
    updatedAt: null,
    environments: [],
  };
}

function attachment(workstationId: string): WorkstationAttachmentState {
  return {
    workstation_id: workstationId,
    display_name: workstationId,
    provider: "runtime_peer",
    default_environment_label: "Current Python",
    environment_policy: "current_python",
    status: "online",
  };
}

function registry(overrides: Partial<CloudWorkstationsRegistry> = {}): CloudWorkstationsRegistry {
  return { defaultWorkstationId: null, workstations: [], ...overrides };
}

function baseInputs(overrides: Partial<CloudWorkstationsInputs> = {}): CloudWorkstationsInputs {
  return {
    auth: STABLE_AUTH,
    workstationsEndpoint: "/api/workstations",
    defaultEndpoint: "/api/workstations/default",
    attachEndpoint: "/api/n/nb-1/workstation-attachments",
    canFetch: true,
    panelIsOpen: true,
    gateCadenceUntilSettled: false,
    closedGate: { status: "signed_out", wipeRegistry: false },
    ...overrides,
  };
}

function baseDeps(overrides: Partial<CloudWorkstationsStoreDeps> = {}): CloudWorkstationsStoreDeps {
  return {
    scheduler: newScheduler(),
    now: () => 0,
    origin: "https://viewer.test",
    loadWorkstations: async () => registry(),
    setDefaultWorkstation: async () => null,
    attachWorkstation: async () => undefined,
    mintPairing: async () => ({
      id: "pair-1",
      code: "AAAA-BBBB",
      expiresAt: new Date(0).toISOString(),
    }),
    fetchPairingStatus: async () => ({ status: "pending", expiresAt: null, workstationId: null }),
    ...overrides,
  };
}

/** A `loadWorkstations` whose promises the test resolves on demand. */
function deferredLoad() {
  const calls: Array<{
    auth: CloudPrototypeAuthState;
    signal: AbortSignal;
    resolve: (value: CloudWorkstationsRegistry) => void;
    reject: (error: unknown) => void;
  }> = [];
  const loadWorkstations = ({
    auth,
    signal,
  }: {
    auth: CloudPrototypeAuthState;
    signal: AbortSignal;
  }) =>
    new Promise<CloudWorkstationsRegistry>((resolve, reject) => {
      calls.push({ auth, signal, resolve, reject });
    });
  return { loadWorkstations, calls };
}

/** A distinct auth reference: a fetch-identity flip is a new reference. */
const ROTATED_AUTH: CloudPrototypeAuthState = { ...STABLE_AUTH, token: "rotated-token" };

describe("CloudWorkstationsStore registry gate", () => {
  it("loads once when the gate is open and marks the registry ready", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () => {
          loadCalls += 1;
          return registry({
            defaultWorkstationId: "ws-1",
            workstations: [workstation("ws-1", "Lab")],
          });
        },
      }),
    );

    await drainMicrotasks();
    assert.equal(loadCalls, 1);
    assert.equal(store.snapshot.status, "ready");
    assert.equal(store.snapshot.registry.defaultWorkstationId, "ws-1");
    assert.equal(store.snapshot.registry.workstations.length, 1);

    dispose();
  });

  it("keeps the registry when the gate closes without a wipe, wipes on lost identity", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () =>
          registry({ defaultWorkstationId: "ws-1", workstations: [workstation("ws-1", "Lab")] }),
      }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations.length, 1);

    // Gate closes but identity is retained (rail transient loss): registry kept.
    inputs$.next(
      baseInputs({ canFetch: false, closedGate: { status: "loading", wipeRegistry: false } }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.status, "loading");
    assert.equal(store.snapshot.registry.workstations.length, 1);

    // Identity lost: the registry is wiped.
    inputs$.next(
      baseInputs({ canFetch: false, closedGate: { status: "signed_out", wipeRegistry: true } }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.status, "signed_out");
    assert.equal(store.snapshot.registry.workstations.length, 0);

    dispose();
  });

  it("surfaces an initial-load failure as an error", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () => {
          throw new Error("registry down");
        },
      }),
    );

    await drainMicrotasks();
    assert.equal(store.snapshot.status, "error");
    assert.match(store.snapshot.error ?? "", /registry down/);

    dispose();
  });

  it("swallows a background poll failure and keeps the last-good registry", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let call = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations: async () => {
          call += 1;
          if (call === 1) {
            return registry({ workstations: [workstation("ws-1", "Lab")] });
          }
          throw new Error("transient");
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.status, "ready");

    // The 10s background poll fails; the ready registry survives untouched.
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(call, 2);
    assert.equal(store.snapshot.status, "ready");
    assert.equal(store.snapshot.error, null);
    assert.equal(store.snapshot.registry.workstations.length, 1);

    dispose();
  });

  it("drops a background poll response when auth flips mid-flight", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ scheduler, loadWorkstations }));

    // Settle the initial gate load under the first identity.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, STABLE_AUTH);
    calls[0].resolve(registry({ workstations: [workstation("ws-1", "Lab")] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-1");

    // A background poll tick fires and stays in flight under the first identity.
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].auth, STABLE_AUTH);

    // Auth flips: the gate driver reloads under the new identity, but the poll
    // loop keeps its in-flight fetch (its cadence does not key on auth).
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].auth, ROTATED_AUTH);

    // The stale poll response (first identity) resolves after the flip: dropped.
    calls[1].resolve(registry({ workstations: [workstation("ws-stale", "Stale")] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-1");

    // The new-identity gate load applies normally.
    calls[2].resolve(registry({ workstations: [workstation("ws-2", "Fresh")] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-2");

    dispose();
  });
});

describe("CloudWorkstationsStore registry cadence", () => {
  it("polls at 10s while the panel is open, and not at all once workstations exist and it closes", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(
      baseInputs({ panelIsOpen: false }),
    );
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations: async () => {
          loadCalls += 1;
          return registry({ workstations: [workstation("ws-1", "Lab")] });
        },
      }),
    );
    await drainMicrotasks();
    assert.equal(loadCalls, 1);

    // Panel closed + workstations present: cadence is null, so no poll fires.
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(loadCalls, 1);

    // Opening the panel resumes the 10s cadence.
    inputs$.next(baseInputs({ panelIsOpen: true }));
    await drainMicrotasks();
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(loadCalls, 2);

    dispose();
  });

  it("speeds the poll to 2.5s while an attach mutation is in flight", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations: async () => {
          loadCalls += 1;
          return registry({ workstations: [workstation("ws-1", "Lab")] });
        },
        // Hangs so the attach mutation stays in flight and never refetches.
        attachWorkstation: () => new Promise<void>(() => {}),
      }),
    );
    await drainMicrotasks();
    assert.equal(loadCalls, 1);

    void store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "attach");

    // The attach cadence (2.5s) fires a poll the 10s cadence would not have.
    advanceBy(scheduler, 2_500);
    await drainMicrotasks();
    assert.equal(loadCalls, 2);

    dispose();
  });

  it("does not overlap after-settle poll ticks", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ scheduler, loadWorkstations }));

    // Settle the initial gate load so only the poll drives further fetches.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].resolve(registry({ workstations: [workstation("ws-1", "Lab")] }));
    await drainMicrotasks();

    // First poll tick fires but does not settle.
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(calls.length, 2);

    // A second interval elapses while the tick is in flight: no overlapping fetch.
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(calls.length, 2);

    // Settling the tick re-arms the loop.
    calls[1].resolve(registry({ workstations: [workstation("ws-1", "Lab")] }));
    await drainMicrotasks();
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(calls.length, 3);

    dispose();
  });

  it("aborts the in-flight registry fetch on dispose", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ loadWorkstations }));
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);

    dispose();
    assert.equal(calls[0].signal.aborted, true);
  });

  it("holds the page background cadence until the initial load settles", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(
      baseInputs({ gateCadenceUntilSettled: true }),
    );
    const { loadWorkstations, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ scheduler, loadWorkstations }));

    // Initial gate load in flight (status "loading"), zero registered workstations.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    assert.equal(store.snapshot.status, "loading");

    // While the status is unsettled the cadence is null: no background tick fires
    // no matter how far the clock advances.
    advanceBy(scheduler, 60_000);
    await drainMicrotasks();
    assert.equal(calls.length, 1);

    // Settling the load flips to "ready": the 10s cadence starts from there.
    calls[0].resolve(registry());
    await drainMicrotasks();
    assert.equal(store.snapshot.status, "ready");
    advanceBy(scheduler, 10_000);
    await drainMicrotasks();
    assert.equal(calls.length, 2);

    dispose();
  });
});

describe("CloudWorkstationsStore mutations", () => {
  it("optimistically sets the default, refetches, and clears the mutation", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let defaultCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () =>
          registry({ defaultWorkstationId: "ws-2", workstations: [workstation("ws-2", "Lab")] }),
        setDefaultWorkstation: async () => {
          defaultCalls += 1;
          return "ws-2";
        },
      }),
    );
    await drainMicrotasks();

    await store.setDefault("ws-2");
    assert.equal(defaultCalls, 1);
    assert.equal(store.snapshot.registry.defaultWorkstationId, "ws-2");
    assert.equal(store.snapshot.mutation.kind, "idle");

    dispose();
  });

  it("keeps the attach mutation after success until the runtime confirms it", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const workstation$ = new BehaviorSubject<WorkstationAttachmentState | null>(null);
    const dispose = store.activate(
      inputs$,
      baseDeps({
        workstation$,
        loadWorkstations: async () => registry({ workstations: [workstation("ws-1", "Lab")] }),
        attachWorkstation: async () => undefined,
      }),
    );
    await drainMicrotasks();

    const started = await store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(started, true);
    // Success leaves the mutation in "attach" until the cross-channel confirm.
    assert.equal(store.snapshot.mutation.kind, "attach");

    workstation$.next(attachment("ws-1"));
    assert.equal(store.snapshot.mutation.kind, "idle");

    dispose();
  });

  it("clears the attach mutation immediately on failure and refetches", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () => {
          loadCalls += 1;
          return registry({ workstations: [workstation("ws-1", "Lab")] });
        },
        attachWorkstation: async () => {
          throw new Error("attach rejected");
        },
      }),
    );
    await drainMicrotasks();
    const loadsBefore = loadCalls;

    const started = await store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(started, false);
    assert.equal(store.snapshot.mutation.kind, "idle");
    // Attach refetches on failure too; a successful refetch clears the error.
    assert.ok(loadCalls > loadsBefore);
    assert.equal(store.snapshot.error, null);

    dispose();
  });

  it("surfaces the error when the post-attach-failure refetch also fails", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let loadCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () => {
          loadCalls += 1;
          if (loadCalls === 1) {
            return registry({ workstations: [workstation("ws-1", "Lab")] });
          }
          throw new Error("registry down");
        },
        attachWorkstation: async () => {
          throw new Error("attach rejected");
        },
      }),
    );
    await drainMicrotasks();

    await store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "idle");
    assert.match(store.snapshot.error ?? "", /registry down/);

    dispose();
  });
});

describe("CloudWorkstationsStore pairing", () => {
  it("mints a pending pairing with connect command and setup commands", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const dispose = store.activate(
      inputs$,
      baseDeps({
        mintPairing: async () => ({
          id: "pair-1",
          code: "ABCD-EFGH",
          expiresAt: new Date(600_000).toISOString(),
        }),
      }),
    );
    await drainMicrotasks();

    await store.startPairing();
    const pairing = store.snapshot.pairing;
    assert.equal(pairing?.status, "pending");
    assert.equal(pairing?.code, "ABCD-EFGH");
    assert.equal(
      pairing?.connectCommand,
      "runt workstation connect https://viewer.test --code ABCD-EFGH",
    );
    assert.ok((pairing?.commands.length ?? 0) > 0);

    dispose();
  });

  it("shows a mint failure as an expired pairing that never polls", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let statusCalls = 0;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        mintPairing: async () => {
          throw new Error("sign in to add a workstation");
        },
        fetchPairingStatus: async () => {
          statusCalls += 1;
          return { status: "pending", expiresAt: null, workstationId: null };
        },
      }),
    );
    await drainMicrotasks();

    await store.startPairing();
    assert.equal(store.snapshot.pairing?.status, "expired");
    assert.match(store.snapshot.pairing?.error ?? "", /sign in to add a workstation/);

    advanceBy(scheduler, 6_000);
    await drainMicrotasks();
    assert.equal(statusCalls, 0);

    dispose();
  });

  it("polls through redeemed to registered, refetches, then stops", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let statusCalls = 0;
    let loadCalls = 0;
    const statuses = ["redeemed", "registered"] as const;
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        mintPairing: async () => ({
          id: "pair-1",
          code: "ABCD-EFGH",
          expiresAt: new Date(600_000).toISOString(),
        }),
        loadWorkstations: async () => {
          loadCalls += 1;
          return registry();
        },
        fetchPairingStatus: async () => {
          const status = statuses[Math.min(statusCalls, statuses.length - 1)];
          statusCalls += 1;
          return {
            status,
            expiresAt: null,
            workstationId: status === "registered" ? "ws-hub" : null,
          };
        },
      }),
    );
    await drainMicrotasks();
    const loadsBeforePairing = loadCalls;

    await store.startPairing();
    await drainMicrotasks();

    advanceBy(scheduler, 2_000);
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.status, "redeemed");

    advanceBy(scheduler, 2_000);
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.status, "registered");
    assert.equal(store.snapshot.pairing?.workstationId, "ws-hub");
    // Registration triggers a registry refetch.
    assert.ok(loadCalls > loadsBeforePairing);

    // Terminal status: no further pairing-status polls.
    const statusesSoFar = statusCalls;
    advanceBy(scheduler, 6_000);
    await drainMicrotasks();
    assert.equal(statusCalls, statusesSoFar);

    dispose();
  });

  it("drops a stale-id pairing response after a restart", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    let mintCount = 0;
    const statusCalls: Array<{
      pairingId: string;
      resolve: (value: { status: "pending"; expiresAt: null; workstationId: null }) => void;
    }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        mintPairing: async () => {
          mintCount += 1;
          return {
            id: `pair-${mintCount}`,
            code: "ABCD-EFGH",
            expiresAt: new Date(600_000).toISOString(),
          };
        },
        fetchPairingStatus: ({ pairingId }) =>
          new Promise((resolve) => statusCalls.push({ pairingId, resolve })),
      }),
    );
    await drainMicrotasks();

    await store.startPairing();
    await drainMicrotasks();
    advanceBy(scheduler, 2_000);
    await drainMicrotasks();
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].pairingId, "pair-1");

    // Restart the pairing while the first status poll is in flight.
    store.cancelPairing();
    await store.startPairing();
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.id, "pair-2");

    // The stale pair-1 response resolves as registered but must not apply.
    statusCalls[0].resolve({ status: "pending", expiresAt: null, workstationId: null });
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.id, "pair-2");
    assert.equal(store.snapshot.pairing?.status, "pending");

    dispose();
  });

  it("flips a pending pairing to expired using the injected clock, not Date.now", async () => {
    const scheduler = newScheduler();
    const base = 1_700_000_000_000;
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        // A clock far from wall time: an expiry driven by Date.now would misfire.
        now: () => base,
        mintPairing: async () => ({
          id: "pair-1",
          code: "ABCD-EFGH",
          expiresAt: new Date(base + 5_000).toISOString(),
        }),
        // Hang the status poll so the pairing only changes via the expiry clock.
        fetchPairingStatus: () => new Promise(() => {}),
      }),
    );
    await drainMicrotasks();

    await store.startPairing();
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.status, "pending");

    advanceBy(scheduler, 5_000);
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.status, "expired");

    dispose();
  });

  it("drops a pairing status response when auth flips mid-flight", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const statusCalls: Array<{
      pairingId: string;
      auth: CloudPrototypeAuthState;
      resolve: (value: CloudWorkstationPairingStatusState) => void;
    }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        mintPairing: async () => ({
          id: "pair-1",
          code: "ABCD-EFGH",
          expiresAt: new Date(600_000).toISOString(),
        }),
        fetchPairingStatus: ({ pairingId, auth }) =>
          new Promise((resolve) => statusCalls.push({ pairingId, auth, resolve })),
      }),
    );
    await drainMicrotasks();

    await store.startPairing();
    await drainMicrotasks();
    advanceBy(scheduler, 2_000);
    await drainMicrotasks();
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].pairingId, "pair-1");
    assert.equal(statusCalls[0].auth, STABLE_AUTH);

    // Auth flips while the pairing status fetch is in flight; the poll loop does
    // not resubscribe on an auth change, so the fetch stays in flight.
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();

    // The stale response (first identity) resolves as registered: it must not
    // apply, so the pairing stays pending and no registration refetch runs.
    statusCalls[0].resolve({ status: "registered", expiresAt: null, workstationId: "ws-hub" });
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.status, "pending");
    assert.equal(store.snapshot.pairing?.workstationId, null);

    dispose();
  });
});

describe("CloudWorkstationsStore stale-completion guards", () => {
  it("drops an attach completion when auth flips mid-flight (no refetch, registry kept)", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const attachCalls: Array<{ resolve: () => void }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations,
        attachWorkstation: () =>
          new Promise<void>((resolve) => {
            attachCalls.push({ resolve: () => resolve() });
          }),
      }),
    );

    // Settle the initial gate load under the first identity.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].resolve(registry({ workstations: [workstation("ws-1", "Lab")] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-1");

    // Start an attach; it hangs in flight under the first identity.
    void store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "attach");

    // Auth flips: the gate driver reloads under the new identity (calls[1]), but
    // the attach fetch keeps its first-identity request in flight.
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].auth, ROTATED_AUTH);

    // The stale attach resolves after the flip: no clearError, no refetch dispatch
    // (the refetch would push a third load), and the registry stays untouched.
    attachCalls[0].resolve();
    await drainMicrotasks();
    assert.equal(calls.length, 2);
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-1");
    // The superseded action's own indicator cannot stay stuck under the new
    // identity: dropping the completion also clears the mutation it wrote.
    assert.equal(store.snapshot.mutation.kind, "idle");

    dispose();
  });

  it("leaves a newer identity's mutation intact when a stale completion clears its own", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations } = deferredLoad();
    const attachCalls: Array<{ resolve: () => void }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations,
        attachWorkstation: () =>
          new Promise<void>((resolve) => {
            attachCalls.push({ resolve: () => resolve() });
          }),
      }),
    );
    await drainMicrotasks();

    // First identity starts an attach that hangs.
    void store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.workstationId, "ws-1");

    // Auth flips and the new identity starts its own attach.
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();
    void store.attach("ws-2");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.workstationId, "ws-2");

    // The stale first attach resolves: it may clear only the mutation object it
    // wrote, and that object was already replaced by the new identity's attach.
    attachCalls[0].resolve();
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "attach");
    assert.equal(store.snapshot.mutation.workstationId, "ws-2");

    dispose();
  });

  it("drops a startPairing mint completion after dispose (pairing stays null)", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const mintCalls: Array<{ resolve: (value: MintedCloudWorkstationPairing) => void }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        mintPairing: () =>
          new Promise<MintedCloudWorkstationPairing>((resolve) => {
            mintCalls.push({ resolve });
          }),
      }),
    );
    await drainMicrotasks();

    // The mint is in flight when the store is disposed.
    void store.startPairing();
    await drainMicrotasks();
    dispose();

    // The mint resolves after dispose: the pairing card must not be written.
    mintCalls[0].resolve({
      id: "pair-1",
      code: "AAAA-BBBB",
      expiresAt: new Date(600_000).toISOString(),
    });
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing, null);
  });

  it("drops a setDefault completion when auth flips mid-flight (no optimistic patch)", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const defaultCalls: Array<{ resolve: (value: string | null) => void }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations,
        setDefaultWorkstation: () =>
          new Promise<string | null>((resolve) => {
            defaultCalls.push({ resolve });
          }),
      }),
    );

    // Settle the initial gate load with a known default.
    await drainMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].resolve(
      registry({
        defaultWorkstationId: "ws-1",
        workstations: [workstation("ws-1", "Lab"), workstation("ws-2", "Hub")],
      }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.defaultWorkstationId, "ws-1");

    // Start a set-default; it hangs in flight under the first identity.
    void store.setDefault("ws-2");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "default");

    // Auth flips: the gate driver reloads under the new identity (calls[1]).
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();
    assert.equal(calls.length, 2);

    // The stale set-default resolves after the flip: no optimistic default patch
    // and no reconciling refetch (which would push a third load).
    defaultCalls[0].resolve("ws-2");
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.defaultWorkstationId, "ws-1");
    assert.equal(calls.length, 2);
    // The dropped completion clears the indicator it owns rather than leaving a
    // stuck "default" mutation under the new identity.
    assert.equal(store.snapshot.mutation.kind, "idle");

    dispose();
  });

  it("clears the mutation when identity flips during the post-success refetch", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const dispose = store.activate(
      inputs$,
      baseDeps({
        scheduler,
        loadWorkstations,
        setDefaultWorkstation: async () => "ws-2",
      }),
    );

    // Settle the initial gate load under the first identity.
    await drainMicrotasks();
    calls[0].resolve(
      registry({
        defaultWorkstationId: "ws-1",
        workstations: [workstation("ws-1", "Lab"), workstation("ws-2", "Hub")],
      }),
    );
    await drainMicrotasks();

    // The PATCH resolves while still current, so the reconciling refetch
    // (calls[1]) is issued - and hangs while auth flips.
    void store.setDefault("ws-2");
    await drainMicrotasks();
    assert.equal(calls.length, 2);
    assert.equal(store.snapshot.mutation.kind, "default");
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();

    // The superseded refetch settles: the finally may not write idle over the
    // new identity, but the "default" indicator this action owns cannot stay
    // stuck either.
    calls[1].resolve(registry({ defaultWorkstationId: "ws-2" }));
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "idle");

    dispose();
  });

  it("keeps the pairing and mutation through a transient loading gate", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const mintCalls: Array<{ resolve: (value: MintedCloudWorkstationPairing) => void }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () => registry({ workstations: [workstation("ws-1", "Lab")] }),
        mintPairing: () =>
          new Promise<MintedCloudWorkstationPairing>((resolve) => {
            mintCalls.push({ resolve });
          }),
        attachWorkstation: () => new Promise<void>(() => {}),
      }),
    );
    await drainMicrotasks();

    void store.startPairing();
    void store.attach("ws-1");
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "attach");

    // A recoverable eligibility dip (user still signed in) is not the unmount
    // analog: the pairing card, the mutation, and in-flight issues survive it.
    inputs$.next(
      baseInputs({ canFetch: false, closedGate: { status: "loading", wipeRegistry: false } }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.mutation.kind, "attach");

    // The in-flight mint also completes normally across the dip.
    mintCalls[0].resolve({
      id: "pair-1",
      code: "AAAA-BBBB",
      expiresAt: new Date(600_000).toISOString(),
    });
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing?.status, "pending");

    dispose();
  });

  it("drops a mint completion that resolves after the gate closes", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const mintCalls: Array<{ resolve: (value: MintedCloudWorkstationPairing) => void }> = [];
    const dispose = store.activate(
      inputs$,
      baseDeps({
        mintPairing: () =>
          new Promise<MintedCloudWorkstationPairing>((resolve) => {
            mintCalls.push({ resolve });
          }),
      }),
    );
    await drainMicrotasks();

    // The mint hangs while the gate closes under the SAME auth reference and
    // endpoint - only the closed gate itself invalidates the captured issue.
    void store.startPairing();
    await drainMicrotasks();
    inputs$.next(
      baseInputs({ canFetch: false, closedGate: { status: "signed_out", wipeRegistry: true } }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing, null);

    // The mint resolves after the close: the pairing card must not come back.
    mintCalls[0].resolve({
      id: "pair-1",
      code: "AAAA-BBBB",
      expiresAt: new Date(600_000).toISOString(),
    });
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing, null);

    dispose();
  });

  it("drops a stale refetch response that lands after an auth flip", async () => {
    const scheduler = newScheduler();
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const { loadWorkstations, calls } = deferredLoad();
    const dispose = store.activate(inputs$, baseDeps({ scheduler, loadWorkstations }));

    // Settle the initial gate load under the first identity.
    await drainMicrotasks();
    calls[0].resolve(registry({ workstations: [workstation("ws-a", "Old")] }));
    await drainMicrotasks();

    // A manual refresh issues a refetch under the first identity and hangs.
    void store.refreshNow();
    await drainMicrotasks();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].auth, STABLE_AUTH);

    // Auth flips; the gate driver loads and lands the new identity's registry.
    inputs$.next(baseInputs({ auth: ROTATED_AUTH }));
    await drainMicrotasks();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].auth, ROTATED_AUTH);
    calls[2].resolve(registry({ workstations: [workstation("ws-b", "New")] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-b");

    // The first identity's refetch resolves last: its response is dropped, so
    // the superseded registry cannot overwrite the current one.
    calls[1].resolve(registry({ workstations: [workstation("ws-a", "Old")] }));
    await drainMicrotasks();
    assert.equal(store.snapshot.registry.workstations[0]?.id, "ws-b");

    dispose();
  });

  it("clears the pairing and mutation when the gate closes", async () => {
    const store = new CloudWorkstationsStore();
    const inputs$ = new BehaviorSubject<CloudWorkstationsInputs>(baseInputs());
    const dispose = store.activate(
      inputs$,
      baseDeps({
        loadWorkstations: async () => registry({ workstations: [workstation("ws-1", "Lab")] }),
        mintPairing: async () => ({
          id: "pair-1",
          code: "ABCD-EFGH",
          expiresAt: new Date(600_000).toISOString(),
        }),
        // Hangs so the attach mutation stays in flight across the gate close.
        attachWorkstation: () => new Promise<void>(() => {}),
      }),
    );
    await drainMicrotasks();

    await store.startPairing();
    void store.attach("ws-1");
    await drainMicrotasks();
    assert.notEqual(store.snapshot.pairing, null);
    assert.equal(store.snapshot.mutation.kind, "attach");

    // The gate closes on a lost identity: the singleton clears the pairing card
    // and the in-flight mutation the way the unmounted manager hook used to.
    inputs$.next(
      baseInputs({ canFetch: false, closedGate: { status: "signed_out", wipeRegistry: true } }),
    );
    await drainMicrotasks();
    assert.equal(store.snapshot.pairing, null);
    assert.equal(store.snapshot.mutation.kind, "idle");

    dispose();
  });
});
