import type { TestContext } from "node:test";

/**
 * Mock `setTimeout` and `Date` together, so deadlines and timers agree. Starts
 * at the real time so signed fixture tokens are still valid.
 */
export function virtualTime(t: TestContext, now = Date.now()): void {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
}

/** Real I/O turns. `setImmediate` is not mocked, so these still advance. */
export async function turns(count = 50): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function track(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/**
 * Advance virtual time in `step` slices, letting real I/O run between them,
 * until `promise` settles or `limitMs` passes. Use it where the code under test
 * does real async work (WebCrypto, Response parsing) between timers.
 */
export async function tickUntilSettled(
  t: TestContext,
  promise: Promise<unknown>,
  limitMs: number,
  step = 5,
): Promise<number> {
  const state = track(promise);
  let elapsed = 0;
  await turns();
  while (!state.settled && elapsed < limitMs) {
    t.mock.timers.tick(step);
    elapsed += step;
    await turns(5);
  }
  return elapsed;
}
