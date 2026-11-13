// Include authentication and the response body in one deadline. The server's
// authentication lookup can take 10 seconds; a normal rollout takes longer.
export const REQUEST_TIMEOUT_MS = 30_000;

const responseObservers = new Set();
/** Observe the headers of every response this module receives, before its
 * body is read. An observer's exception never reaches the request. */
export function observeResponses(fn) {
  responseObservers.add(fn);
  return () => responseObservers.delete(fn);
}

// A gateway answers with these while the origin restarts or is unreachable,
// for example Cloudflare's HTML error pages during a deploy.
const GATEWAY_STATUSES = new Set([502, 503, 504]);
// The messages fetch rejects with for a transport failure: Chromium, Firefox,
// Safari and Node. Anchored so "Failed to fetch dynamically imported module"
// (a retired chunk, which needs a reload) stays out.
const FETCH_FAILURE =
  /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed|fetch failed)$/;

/**
 * Whether a request failed in a way the server fixes by itself, such as a
 * restart: a 502, 503 or 504 (JSON or a proxy's HTML), a JSON error marked
 * `retryable`, or a transport failure. The person can't act on one, so the
 * viewer shows Offline and retries instead of a banner. A 4xx, a 500 and a
 * timeout are not transient.
 */
export function isTransientFailure(error) {
  if (error === null || typeof error !== "object") return false;
  if (error.retryable === true || error.code === "NETWORK_ERROR") return true;
  if (GATEWAY_STATUSES.has(error.status) || GATEWAY_STATUSES.has(error.httpStatus)) return true;
  return error instanceof TypeError && FETCH_FAILURE.test(error.message);
}

/**
 * Whether a request went unanswered: a transient failure (isTransientFailure)
 * or this module's own deadline (REQUEST_TIMEOUT). Neither says anything
 * about the session or the Page, so a check that runs on its own schedule
 * asks again instead of reporting it. A caller's own abort is not one.
 */
export function isUnansweredFailure(error) {
  return isTransientFailure(error) || error?.code === "REQUEST_TIMEOUT";
}

/**
 * How long a failed response asks the caller to wait, in ms, or undefined:
 * the body's `retry_after_ms` when it is a positive integer, else the
 * Retry-After header as whole seconds or an HTTP date still in the future.
 * `now` is the wall clock in ms, for an HTTP date.
 */
export function retryAfterOf(headers, body, now = Date.now()) {
  const fromBody = body && typeof body === "object" ? body.retry_after_ms : undefined;
  if (Number.isSafeInteger(fromBody) && fromBody > 0) return fromBody;
  const header = headers?.get?.("retry-after")?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1000;
    return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
  }
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? Math.ceil(at - now) : undefined;
}

function invalidResponse(response) {
  const retryAfterMs = retryAfterOf(response.headers);
  return Object.assign(Error(`The server returned an unexpected response (${response.status})`), {
    code: "INVALID_RESPONSE",
    httpStatus: response.status,
    // A proxy's HTML 404 is not evidence that a Page was deleted. Only the
    // application's structured JSON errors can change authentication/access.
    ...(response.status >= 500 ? { status: response.status } : {}),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });
}

export async function request(
  url,
  options = {},
  {
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetch: fetchRequest = globalThis.fetch,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("A request needs a positive, finite timeout");
  const callerSignal = options.signal;
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  const interrupt = (reason) => {
    controller.abort(reason);
    rejectInterrupted(reason);
  };
  const onAbort = () => interrupt(callerSignal.reason);
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = schedule(
    () =>
      interrupt(
        Object.assign(Error("The request timed out. Please try again."), {
          name: "TimeoutError",
          code: "REQUEST_TIMEOUT",
        }),
      ),
    timeoutMs,
  );

  try {
    // The explicit race also settles when a transport or body reader ignores
    // AbortSignal. Checks after each await prevent late responses being used.
    const work = (async () => {
      controller.signal.throwIfAborted();
      let response;
      try {
        response = await fetchRequest(url, { ...options, signal: controller.signal });
      } catch (error) {
        controller.signal.throwIfAborted();
        // Fetch uses TypeError for transport failures. Mark only this boundary,
        // so callers need not retry arbitrary TypeErrors from their own code.
        if (error instanceof TypeError) error.code = "NETWORK_ERROR";
        throw error;
      }
      controller.signal.throwIfAborted();
      for (const observe of responseObservers) {
        try {
          observe(response.headers);
        } catch {}
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
        void response.body?.cancel().catch(() => {});
        throw invalidResponse(response);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        controller.signal.throwIfAborted();
        throw invalidResponse(response);
      }
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const message =
          body && !Array.isArray(body) && typeof body === "object"
            ? typeof body.error === "string"
              ? body.error
              : body.error?.message
            : undefined;
        if (typeof message !== "string") throw invalidResponse(response);
        const retryAfterMs = retryAfterOf(response.headers, body);
        throw Object.assign(Error(message), {
          status: response.status,
          code: body.code,
          ...(body.retryable === true && { retryable: true }),
          ...(retryAfterMs !== undefined && { retryAfterMs }),
        });
      }
      return body;
    })();
    return await Promise.race([work, interrupted]);
  } finally {
    cancel(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

const signedOutObservers = new Set();
/** Observe every tool call the server refused as signed out: a structured
 * JSON 401. A proxy's HTML 401 is not evidence (see invalidResponse). The
 * shell forgets what it remembers for the account and asks for the session
 * again. An observer's exception never reaches the call. */
export function observeSignedOut(fn) {
  signedOutObservers.add(fn);
  return () => signedOutObservers.delete(fn);
}

/** Tell the signed-out observers about a structured 401, unless its caller
 * had already cancelled the request. */
function reportSignedOut(error, signal) {
  if (error?.status !== 401 || signal?.aborted) return;
  for (const observe of signedOutObservers) {
    try {
      observe(error);
    } catch {}
  }
}

/** Call one Pages tool through /api/tools. Once `signal` aborts, the call
 * rejects with its reason and its answer is never read; a call its caller
 * cancelled never counts as signed out, whatever the server answered. */
export async function tool(operation, args = {}, { signal } = {}) {
  try {
    return await request("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, arguments: args }),
      ...(signal && { signal }),
    });
  } catch (error) {
    reportSignedOut(error, signal);
    throw error;
  }
}

/** How long a JSON read (getJson) waits: a preview nobody waits on for long. */
export const READ_TIMEOUT_MS = 10_000;

/** GET one of this origin's JSON routes with this tab's session, as `tool`
 * calls do: a structured 401 counts as signed out. The link-preview routes
 * answer `private, no-store`, so nothing is kept in the browser's cache. */
export async function getJson(path, { signal, timeoutMs = READ_TIMEOUT_MS } = {}) {
  try {
    return await request(
      path,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        ...(signal && { signal }),
      },
      { timeoutMs },
    );
  } catch (error) {
    reportSignedOut(error, signal);
    throw error;
  }
}
