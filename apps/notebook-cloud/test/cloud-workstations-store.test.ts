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
 * attach mutation clears on a cross-channel runtime confirm, and the auth-flip
 * wipe is scoped to the surface's closed-gate.
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
    signal: AbortSignal;
    resolve: (value: CloudWorkstationsRegistry) => void;
    reject: (error: unknown) => void;
  }> = [];
  const loadWorkstations = ({ signal }: { signal: AbortSignal }) =>
    new Promise<CloudWorkstationsRegistry>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    });
  return { loadWorkstations, calls };
}

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
});
