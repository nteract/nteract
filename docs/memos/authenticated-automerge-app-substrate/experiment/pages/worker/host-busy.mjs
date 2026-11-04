/**
 * celld's per-cell request limit, made legible.
 *
 * celld 0.6.3 admits at most `CELLD_MAX_CELL_REQUESTS` (default 64) requests
 * to one Durable Object at a time. A request counts from admission until its
 * context is quiet: the response has been sent, every `waitUntil` promise has
 * settled, and every timer it (or a callback of one of its timers) created
 * has fired or been cleared. At the limit celld answers the stub fetch itself,
 * before the Worker runs, with a plain-text `503 cell request limit reached`
 * and logs `cell_overload_refused` with `in_flight` and `limit`. The caller's
 * code never sees the request, so nothing inside the Page can shape that
 * answer; the gateway that forwarded the request can.
 *
 * `legibleHostRefusal` turns that body into the JSON refusal shape every other
 * Pages error uses, with a stable code and a retry hint. A refused request did
 * no work, so a retry with the same idempotency_key and retry_token is safe.
 *
 * Cloudflare reports the same conditions differently: the stub fetch throws.
 * An overloaded object throws an Error with `overloaded: true`, and a
 * transient failure (a lost connection, a reset or code update) throws one
 * with `retryable: true`
 * (developers.cloudflare.com/durable-objects/best-practices/error-handling/).
 * `legibleHostError` answers those two with JSON refusals too, so a thrown
 * overload is `page_busy` rather than the gateway's generic 500. Every other
 * thrown error is rethrown unchanged.
 */

export const HOST_BUSY_TEXT = "cell request limit reached";
export const PAGE_BUSY = Object.freeze({
  code: "page_busy",
  status: 503,
  retryAfterMs: 1000,
  message:
    "This Page is answering as many requests as it can right now; it did not run this one. Retry in a second with the same idempotency_key and retry_token.",
});

/** A transient failure between the gateway and an object. Unlike an
 * overload, the object may have started the request, so only a retry that
 * replays its receipt is blind. */
export const PAGE_TRANSIENT_FAILURE = Object.freeze({
  code: "page_transient_failure",
  status: 503,
  retryAfterMs: 1000,
  message:
    "This Page's host failed before it answered, for example while it restarted. Retry with the same idempotency_key and retry_token. A write without a retry_token may have completed: read back and reconcile before retrying.",
});

/** Every code the gateway answers a saturated or failed object with. */
export const HOST_REFUSAL_CODES = Object.freeze([PAGE_BUSY.code, PAGE_TRANSIENT_FAILURE.code]);

/** Only a short plain-text 503 can be celld's refusal; a JSON body is ours. */
function mayBeHostRefusal(response) {
  if (response.status !== PAGE_BUSY.status || response.body === null) return false;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json")) return false;
  const length = response.headers.get("content-length");
  return length === null || Number(length) <= 128;
}

function refusalResponse(refusal, retryAfterMs) {
  return new Response(
    JSON.stringify({
      error: refusal.message,
      code: refusal.code,
      retryable: true,
      retry_after_ms: retryAfterMs,
    }),
    {
      status: refusal.status,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        "cache-control": "no-store",
      },
    },
  );
}

/** The JSON refusal for a Page or Catalog at its request limit. */
export function pageBusyResponse({ retryAfterMs = PAGE_BUSY.retryAfterMs } = {}) {
  return refusalResponse(PAGE_BUSY, retryAfterMs);
}

/** The JSON refusal for a transient failure between the gateway and an
 * object. */
export function pageTransientFailureResponse({
  retryAfterMs = PAGE_TRANSIENT_FAILURE.retryAfterMs,
} = {}) {
  return refusalResponse(PAGE_TRANSIENT_FAILURE, retryAfterMs);
}

/** The refusal for an error a stub fetch threw, or the error rethrown.
 * `overloaded` wins over `retryable`: an overloaded object did not run the
 * request, and Cloudflare says not to retry one at once, which page_busy's
 * Retry-After covers. `binding` names the namespace in the log line; nothing
 * from the error's message is logged. */
export function legibleHostError(error, binding) {
  const overloaded = error?.overloaded === true;
  if (!overloaded && error?.retryable !== true) throw error;
  console.warn(
    JSON.stringify({
      service: "nteract-pages-native",
      event: overloaded ? "host.overloaded" : "host.transient_failure",
      ...(typeof binding === "string" && { binding }),
      timestamp: new Date().toISOString(),
    }),
  );
  return overloaded ? pageBusyResponse() : pageTransientFailureResponse();
}

/**
 * The response as the caller should see it. Anything but celld's refusal is
 * returned untouched, body unread. The refusal body is tiny, so reading it
 * costs nothing; a 503 with another short text body passes through with its
 * bytes intact.
 */
export async function legibleHostRefusal(response) {
  if (!mayBeHostRefusal(response)) return response;
  const text = await response.text();
  if (text.trim() !== HOST_BUSY_TEXT) return new Response(text, response);
  return pageBusyResponse();
}

/** Wrap a Durable Object namespace so every stub fetch through it answers
 * celld's refusal, and Cloudflare's thrown overload and transient errors,
 * legibly. Other methods and properties pass through. */
export function legibleNamespace(namespace, binding) {
  if (!namespace || typeof namespace !== "object") return namespace;
  return new Proxy(namespace, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "getByName" || property === "get")
        return (...args) => legibleStub(value.apply(target, args), binding);
      return value.bind(target);
    },
  });
}

function legibleStub(stub, binding) {
  if (!stub || typeof stub !== "object") return stub;
  const legible = (response) =>
    mayBeHostRefusal(response) ? legibleHostRefusal(response) : response;
  const thrown = (error) => legibleHostError(error, binding);
  return new Proxy(stub, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "fetch") return value.bind(target);
      // No extra turn for an answer that isn't the refusal: the caller's
      // deadline and body reader see the response as soon as the stub has it.
      return (...args) => {
        let result;
        try {
          result = value.apply(target, args);
        } catch (error) {
          return Promise.resolve().then(() => thrown(error));
        }
        return typeof result?.then === "function" ? result.then(legible, thrown) : legible(result);
      };
    },
  });
}

const LEGIBLE_NAMESPACES = new Set(["PAGES", "CATALOGS", "PROJECTS"]);

/** The gateway's bindings, with every object namespace made legible. Other
 * bindings are read from `env` only when the gateway asks for them. */
export function legibleEnv(env) {
  if (!env || typeof env !== "object") return env;
  const wrapped = new Map();
  return new Proxy(env, {
    get(target, property, receiver) {
      if (!LEGIBLE_NAMESPACES.has(property)) return Reflect.get(target, property, receiver);
      if (!wrapped.has(property))
        wrapped.set(property, legibleNamespace(target[property], property));
      return wrapped.get(property);
    },
  });
}
