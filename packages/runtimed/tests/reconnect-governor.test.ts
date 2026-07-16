/**
 * ReconnectGovernor contract tests.
 *
 * Timers run on an injected `VirtualTimeScheduler`; reconnect promises settle
 * on the real microtask queue, drained explicitly with `drainMicrotasks`. The
 * two load-bearing behaviors are the backoff schedule (a rejecting daemon can
 * never be dialed at multiple connects per second) and the terminal latch
 * (a Failed initial load stops automatic reconnection until Retry).
 */

import { ReconnectGovernor } from "runtimed";
import { VirtualAction, VirtualTimeScheduler } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

/** Advance the virtual clock by `ms`, stopping at the target frame. */
function advanceBy(scheduler: VirtualTimeScheduler, ms: number): void {
  const target = scheduler.frame + ms;
  scheduler.maxFrames = target;
  scheduler.schedule(() => {}, ms);
  scheduler.flush();
}

/** Let queued microtasks (promise `.then` chains) run to completion. */
async function drainMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function newScheduler(): VirtualTimeScheduler {
  return new VirtualTimeScheduler(VirtualAction, Infinity);
}

interface Harness {
  scheduler: VirtualTimeScheduler;
  governor: ReconnectGovernor;
  /** Virtual-time frames at which `reconnect` was called. */
  dialFrames: number[];
  /** Settle controls for each reconnect call, in call order. */
  dials: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
}

function createHarness(
  options: Partial<ConstructorParameters<typeof ReconnectGovernor>[0]> = {},
): Harness {
  const scheduler = newScheduler();
  const dialFrames: number[] = [];
  const dials: Harness["dials"] = [];
  const governor = new ReconnectGovernor({
    reconnect: () =>
      new Promise<void>((resolve, reject) => {
        dialFrames.push(scheduler.frame);
        dials.push({ resolve: () => resolve(), reject });
      }),
    // random 0.5 makes the jitter factor exactly 1.0, so delays are deterministic.
    random: () => 0.5,
    scheduler,
    ...options,
  });
  return { scheduler, governor, dialFrames, dials };
}

/** Drive one full "dial resolves, daemon closes the session again" cycle. */
async function dialResolvesThenDrops(h: Harness): Promise<void> {
  h.dials.at(-1)?.resolve();
  await drainMicrotasks();
  h.governor.connectionLost();
}

describe("ReconnectGovernor backoff", () => {
  it("retries immediately on the first loss, then grows the delay exponentially to the cap", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    expect(h.dialFrames).toEqual([0]);
    expect(h.governor.getState()).toEqual({ kind: "reconnecting", attempt: 1 });

    // attempt 2..N: delays 500, 1000, 2000, ..., capped at 30_000.
    const expectedDelays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [i, delay] of expectedDelays.entries()) {
      await dialResolvesThenDrops(h);
      expect(h.governor.getState()).toEqual({
        kind: "waiting",
        attempt: i + 2,
        delayMs: delay,
      });
      const before = h.dialFrames.length;
      advanceBy(h.scheduler, delay - 1);
      expect(h.dialFrames).toHaveLength(before);
      advanceBy(h.scheduler, 1);
      expect(h.dialFrames).toHaveLength(before + 1);
    }

    h.governor.dispose();
  });

  it("keeps jittered delays within the ±25% band and under the cap", () => {
    const low = createHarness({ random: () => 0 });
    low.governor.connectionLost();
    low.dials[0]?.resolve();
    // Second attempt with random()=0: 500 * 0.75 = 375.
    low.governor.connectionLost();
    expect(low.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 375 });
    low.governor.dispose();

    const high = createHarness({
      random: () => 0.999999,
      baseDelayMs: 2_000,
      maxDelayMs: 1_000,
    });
    high.governor.connectionLost();
    high.dials[0]?.resolve();
    // Raw delay already at the cap; upward jitter clamps back to the cap.
    high.governor.connectionLost();
    expect(high.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 1_000 });
    high.governor.dispose();
  });

  it("schedules the next attempt on its own when the dial itself rejects", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    expect(h.dialFrames).toEqual([0]);
    h.dials[0]?.reject(new Error("daemon not listening"));
    await drainMicrotasks();

    expect(h.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 500 });
    advanceBy(h.scheduler, 500);
    expect(h.dialFrames).toHaveLength(2);

    h.governor.dispose();
  });

  it("ignores duplicate connectionLost while a retry is already pending", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    await dialResolvesThenDrops(h);
    expect(h.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 500 });

    h.governor.connectionLost();
    h.governor.connectionLost();
    expect(h.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 500 });

    advanceBy(h.scheduler, 500);
    expect(h.dialFrames).toHaveLength(2);

    h.governor.dispose();
  });

  it("resets to the immediate fast path only after the link stays up for the stability window", async () => {
    const h = createHarness({ stabilityWindowMs: 10_000 });

    // Two consecutive losses reach attempt 2.
    h.governor.connectionLost();
    await dialResolvesThenDrops(h);
    advanceBy(h.scheduler, 500);
    expect(h.dialFrames).toHaveLength(2);

    // Ready arrives but the link drops before the stability window elapses:
    // backoff keeps growing (attempt 3), no immediate redial flap.
    h.dials.at(-1)?.resolve();
    await drainMicrotasks();
    h.governor.connectionEstablished();
    advanceBy(h.scheduler, 9_999);
    h.governor.connectionLost();
    expect(h.governor.getState()).toEqual({ kind: "waiting", attempt: 3, delayMs: 1_000 });
    advanceBy(h.scheduler, 1_000);
    expect(h.dialFrames).toHaveLength(3);

    // This time the link survives the window; the next loss is immediate.
    h.dials.at(-1)?.resolve();
    await drainMicrotasks();
    h.governor.connectionEstablished();
    advanceBy(h.scheduler, 10_000);
    const before = h.dialFrames.length;
    h.governor.connectionLost();
    expect(h.dialFrames).toHaveLength(before + 1);
    expect(h.governor.getState()).toEqual({ kind: "reconnecting", attempt: 1 });

    h.governor.dispose();
  });

  it("connectionEstablished cancels a pending retry", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    await dialResolvesThenDrops(h);
    expect(h.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 500 });

    h.governor.connectionEstablished();
    expect(h.governor.getState()).toEqual({ kind: "idle" });
    advanceBy(h.scheduler, 60_000);
    expect(h.dialFrames).toHaveLength(1);

    h.governor.dispose();
  });
});

describe("ReconnectGovernor terminal latch", () => {
  it("latchFailure cancels the pending retry and stops the loop", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    await dialResolvesThenDrops(h);
    expect(h.governor.getState()).toEqual({ kind: "waiting", attempt: 2, delayMs: 500 });

    h.governor.latchFailure("source_degraded: recovery contains peer changes");
    expect(h.governor.getState()).toEqual({
      kind: "latched",
      reason: "source_degraded: recovery contains peer changes",
    });

    advanceBy(h.scheduler, 120_000);
    h.governor.connectionLost();
    advanceBy(h.scheduler, 120_000);
    expect(h.dialFrames).toHaveLength(1);

    h.governor.dispose();
  });

  it("reset clears the latch and re-arms immediate retry", () => {
    const h = createHarness();

    h.governor.latchFailure("load failed");
    h.governor.reset();
    expect(h.governor.getState()).toEqual({ kind: "idle" });

    h.governor.connectionLost();
    expect(h.dialFrames).toHaveLength(1);
    expect(h.governor.getState()).toEqual({ kind: "reconnecting", attempt: 1 });

    h.governor.dispose();
  });

  it("clearLatch drops only a latched state", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    await dialResolvesThenDrops(h);
    const waiting = h.governor.getState();
    h.governor.clearLatch();
    expect(h.governor.getState()).toEqual(waiting);
    advanceBy(h.scheduler, 500);
    expect(h.dialFrames).toHaveLength(2);

    h.governor.latchFailure("load failed");
    h.governor.clearLatch();
    expect(h.governor.getState()).toEqual({ kind: "idle" });

    h.governor.dispose();
  });

  it("connectionEstablished does not clear a latch", () => {
    const h = createHarness();

    h.governor.latchFailure("load failed");
    h.governor.connectionEstablished();
    expect(h.governor.getState()).toEqual({ kind: "latched", reason: "load failed" });

    h.governor.dispose();
  });

  it("emits state transitions on the readonly observable", async () => {
    const h = createHarness();
    const seen: string[] = [];
    const sub = h.governor.state$.subscribe((state) => seen.push(state.kind));

    h.governor.connectionLost();
    await dialResolvesThenDrops(h);
    h.governor.latchFailure("load failed");
    h.governor.reset();

    expect(seen).toEqual(["idle", "reconnecting", "waiting", "latched", "idle"]);
    sub.unsubscribe();
    h.governor.dispose();
  });
});

describe("ReconnectGovernor stale-completion invalidation", () => {
  it("ignores a dial rejection that settles after reset", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    expect(h.dialFrames).toHaveLength(1);

    h.governor.reset();
    h.dials[0]?.reject(new Error("late failure"));
    await drainMicrotasks();

    expect(h.governor.getState()).toEqual({ kind: "idle" });
    advanceBy(h.scheduler, 120_000);
    expect(h.dialFrames).toHaveLength(1);

    h.governor.dispose();
  });

  it("ignores a dial rejection that settles after latchFailure", async () => {
    const h = createHarness();

    h.governor.connectionLost();
    h.governor.latchFailure("load failed");
    h.dials[0]?.reject(new Error("late failure"));
    await drainMicrotasks();

    expect(h.governor.getState()).toEqual({ kind: "latched", reason: "load failed" });
    advanceBy(h.scheduler, 120_000);
    expect(h.dialFrames).toHaveLength(1);

    h.governor.dispose();
  });

  it("does nothing after dispose", () => {
    const h = createHarness();
    const spy = vi.fn();
    const sub = h.governor.state$.subscribe({ complete: spy });

    h.governor.dispose();
    expect(spy).toHaveBeenCalledTimes(1);

    h.governor.connectionLost();
    h.governor.latchFailure("load failed");
    advanceBy(h.scheduler, 120_000);
    expect(h.dialFrames).toHaveLength(0);
    sub.unsubscribe();
  });
});
