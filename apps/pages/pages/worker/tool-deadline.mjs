import { HttpError } from "./auth.mjs";

/** Bound on one tool request to a Catalog or Page host, from the first fetch
 * through the last body byte and any gateway post-processing. A host keeps
 * running work it accepted. A read, or a write with a retry_token, is safe to
 * repeat: the same idempotency_key and retry_token return that work's
 * receipt. A tokenless write is deduplicated only while its receipt is
 * retained, so its timeout says to read back and reconcile instead. */
export const TOOL_REQUEST_TIMEOUT_MS = 60_000;

/** How a timed-out request may be followed up: `repeat` (a read, or a write
 * whose receipt replays), `reconcile` (a tokenless write), or `lease` (a
 * progress creation: a repeat would mint a second session). */
const TIMEOUT_ADVICE = {
  repeat:
    "Pages did not answer this request in time. It may still complete: retry the same request, with the same idempotency_key and retry_token, to get its result.",
  reconcile:
    "Pages did not answer this request in time. It may still have completed. Read back and reconcile before retrying: a write without retry_token is deduplicated only while its receipt is retained.",
  lease:
    "Pages did not answer this request in time. The document was not edited. If you have its progress_id and lease_token, retry that session. A lost creation response may leave a temporary indicator that expires within 60 seconds; do not loop creating sessions.",
};

const requestTimeout = (safe) =>
  Object.assign(
    new HttpError(
      504,
      TIMEOUT_ADVICE[safe === true ? "repeat" : safe || "reconcile"],
      "request_timeout",
    ),
    { retryable: safe === true },
  );

/**
 * Run `work(signal)` under one deadline. At the deadline the signal aborts,
 * which cancels the stub fetches and body readers that `work` started with
 * it, and the call rejects with a 504 that is retryable only when `safe` is
 * true; `false` says to reconcile, and `"lease"` gives a progress session's
 * lease advice. Nothing `work` produces after that is returned, so a partly
 * processed result never escapes.
 */
export async function withinToolDeadline(work, { ms = TOOL_REQUEST_TIMEOUT_MS, safe = true } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = requestTimeout(safe);
      reject(error);
      controller.abort(error);
    }, ms);
  });
  const running = Promise.resolve().then(() => work(controller.signal));
  running.catch(() => {});
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Settle with `promise`, or reject with the signal's reason when it aborts.
 * celld honors a stub fetch's AbortSignal; this also bounds stubs that don't. */
export function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let abort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener("abort", abort));
}

/** Read a whole body through a reader that `signal` cancels. An abort after
 * the headers does not interrupt `response.json()`, so bodies are never read
 * that way under a deadline. */
export async function readBody(response, signal) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => reader.cancel(signal.reason).catch(() => {});
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks = [];
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function readResponseJson(response, signal) {
  return JSON.parse(new TextDecoder().decode(await readBody(response, signal)));
}

/** The same response with its body fully read under `signal`. */
export async function bufferedResponse(response, signal) {
  const body = await readBody(response, signal);
  return new Response(body.byteLength ? body : null, {
    status: response.status,
    headers: response.headers,
  });
}
