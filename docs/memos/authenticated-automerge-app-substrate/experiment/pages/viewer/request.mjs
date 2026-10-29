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

function invalidResponse(response) {
  return Object.assign(Error(`The server returned an unexpected response (${response.status})`), {
    code: "INVALID_RESPONSE",
    httpStatus: response.status,
    // A proxy's HTML 404 is not evidence that a Page was deleted. Only the
    // application's structured JSON errors can change authentication/access.
    ...(response.status >= 500 ? { status: response.status } : {}),
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
        throw Object.assign(Error(message), { status: response.status, code: body.code });
      }
      return body;
    })();
    return await Promise.race([work, interrupted]);
  } finally {
    cancel(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}
