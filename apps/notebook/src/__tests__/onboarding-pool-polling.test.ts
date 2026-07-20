import type { PoolState, RuntimePoolState } from "runtimed";
import { VirtualAction, VirtualTimeScheduler } from "rxjs";
import { describe, expect, it } from "vitest";
import { observeOnboardingPool, type OnboardingPoolGate } from "../../onboarding/pool-polling";

const DEFAULT_RUNTIME_POOL: RuntimePoolState = {
  available: 0,
  warming: 0,
  pool_size: 1,
  consecutive_failures: 0,
  retry_in_secs: 0,
};

function poolState(overrides: Partial<RuntimePoolState>): PoolState {
  return {
    uv: { ...DEFAULT_RUNTIME_POOL },
    conda: { ...DEFAULT_RUNTIME_POOL, ...overrides },
    pixi: { ...DEFAULT_RUNTIME_POOL },
  };
}

function newScheduler(): VirtualTimeScheduler {
  return new VirtualTimeScheduler(VirtualAction, Infinity);
}

function advanceBy(scheduler: VirtualTimeScheduler, milliseconds: number): void {
  const target = scheduler.frame + milliseconds;
  scheduler.maxFrames = target;
  scheduler.schedule(() => {}, milliseconds);
  scheduler.flush();
}

async function drainMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("observeOnboardingPool", () => {
  it("keeps observing from failure through retry to ready", async () => {
    const scheduler = newScheduler();
    const states = [
      poolState({
        consecutive_failures: 1,
        error_kind: "timeout",
        error: "warm-env timed out after 900s",
      }),
      poolState({
        warming: 1,
        consecutive_failures: 1,
        error_kind: "timeout",
        error: "warm-env timed out after 900s",
      }),
      poolState({ available: 1 }),
    ];
    const gates: OnboardingPoolGate[] = [];
    let completed = false;

    observeOnboardingPool({
      pythonEnv: "conda",
      envLabel: "Conda",
      pollIntervalMs: 1_000,
      scheduler,
      fetchPoolState: async () => states.shift() ?? poolState({ available: 1 }),
    }).subscribe({
      next: (gate) => gates.push(gate),
      complete: () => {
        completed = true;
      },
    });

    await drainMicrotasks();
    expect(gates.map(({ kind }) => kind)).toEqual(["checking", "failed"]);
    expect(gates.at(-1)?.canContinue).toBe(true);

    advanceBy(scheduler, 1_000);
    await drainMicrotasks();
    expect(gates.at(-1)).toMatchObject({
      kind: "retrying",
      canContinue: true,
      errorMessage: null,
    });

    advanceBy(scheduler, 1_000);
    await drainMicrotasks();
    expect(gates.at(-1)).toMatchObject({ kind: "ready", canContinue: true });
    expect(completed).toBe(true);
  });

  it("keeps polling after the warming threshold unlocks continue", async () => {
    const scheduler = newScheduler();
    const states = [
      poolState({ warming: 1 }),
      poolState({ warming: 1 }),
      poolState({ available: 1 }),
    ];
    const gates: OnboardingPoolGate[] = [];

    observeOnboardingPool({
      pythonEnv: "conda",
      envLabel: "Conda",
      pollIntervalMs: 1_000,
      warmingPollAttempts: 2,
      scheduler,
      fetchPoolState: async () => states.shift() ?? poolState({ available: 1 }),
    }).subscribe((gate) => gates.push(gate));

    await drainMicrotasks();
    expect(gates.at(-1)?.kind).toBe("warming");

    advanceBy(scheduler, 1_000);
    await drainMicrotasks();
    expect(gates.at(-1)).toMatchObject({ kind: "slow", canContinue: true });

    advanceBy(scheduler, 1_000);
    await drainMicrotasks();
    expect(gates.at(-1)?.kind).toBe("ready");
  });

  it("drops an in-flight result after the selection unsubscribes", async () => {
    const scheduler = newScheduler();
    let resolveFetch: ((state: PoolState) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    const gates: OnboardingPoolGate[] = [];

    const subscription = observeOnboardingPool({
      pythonEnv: "conda",
      envLabel: "Conda",
      pollIntervalMs: 1_000,
      scheduler,
      fetchPoolState: (signal) => {
        capturedSignal = signal;
        return new Promise<PoolState>((resolve) => {
          resolveFetch = resolve;
        });
      },
    }).subscribe((gate) => gates.push(gate));

    expect(gates.map(({ kind }) => kind)).toEqual(["checking"]);
    subscription.unsubscribe();
    expect(capturedSignal?.aborted).toBe(true);

    resolveFetch?.(poolState({ available: 1 }));
    await drainMicrotasks();
    expect(gates.map(({ kind }) => kind)).toEqual(["checking"]);
  });
});
