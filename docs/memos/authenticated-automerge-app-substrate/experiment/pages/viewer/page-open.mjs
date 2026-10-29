const RETRY_DELAYS = [1000, 2000, 4000, 8000, 10000];
const CLEANUP_TIMEOUT_MS = 15_000;

function transient(error) {
  // A permanent native refusal (for example a refused signing key) cannot be
  // fixed by reopening with the same tab identity.
  if (error.admission?.retry === "stop") return false;
  if (error.status != null) return error.status >= 500;
  return ["NETWORK_ERROR", "REQUEST_TIMEOUT", "INVALID_RESPONSE"].includes(error.code);
}

function wait(delay, signal, schedule, cancel) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      cancel(timer);
      reject(signal.reason);
    };
    const timer = schedule(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCleanup(cleanup, signal, timeoutMs, schedule, cancel) {
  signal.throwIfAborted();
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = schedule(
      () =>
        reject(
          Object.assign(
            Error(
              "The previous Page connection is still closing. Please reload before trying again.",
            ),
            { code: "PAGE_CLEANUP_PENDING" },
          ),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      Promise.resolve(cleanup).catch((cause) => {
        throw Object.assign(
          Error(
            "The previous Page connection could not close. Please reload before trying again.",
            { cause },
          ),
          { code: "PAGE_CLEANUP_FAILED" },
        );
      }),
      interrupted,
    ]);
  } finally {
    cancel(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

// Opening an existing Page is safe to repeat after a temporary connection
// failure. Creation and tool mutations do not use this retry loop.
export async function openPageWithRetry(
  openPage,
  {
    signal,
    delays = RETRY_DELAYS,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
  },
) {
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0)
    throw new TypeError("Page cleanup needs a positive, finite timeout");
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const session = await openPage();
      // The underlying open may finish after navigation or an account change.
      // It still owns resources, but must never become the visible editor.
      if (signal.aborted) {
        await session.close();
        signal.throwIfAborted();
      }
      return session;
    } catch (error) {
      signal.throwIfAborted();
      if (!transient(error) || attempt >= delays.length) throw error;
      // Failure is already visible to direct PageSession callers. This bounded
      // retry gate neither frees a live native backend nor opens a new signer
      // while the previous one still owns the same Page's replica.
      if (error.cleanupPromise)
        await waitForCleanup(error.cleanupPromise, signal, cleanupTimeoutMs, schedule, cancel);
    }
    await wait(delays[attempt], signal, schedule, cancel);
  }
}
