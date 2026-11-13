import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientFailure,
  isUnansweredFailure,
  observeSignedOut,
  request,
  REQUEST_TIMEOUT_MS,
  retryAfterOf,
  tool,
} from "./request.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clock() {
  const jobs = new Map();
  let id = 0;
  return {
    jobs,
    setTimeout(callback, delay) {
      jobs.set(++id, { callback, delay });
      return id;
    },
    clearTimeout(timer) {
      jobs.delete(timer);
    },
    expire() {
      for (const { callback } of jobs.values()) callback();
    },
  };
}

function watchSignal(t, signal) {
  const listeners = new Set();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  t.mock.method(signal, "addEventListener", (type, fn, options) => {
    if (type === "abort") listeners.add(fn);
    add(type, fn, options);
  });
  t.mock.method(signal, "removeEventListener", (type, fn, options) => {
    if (type === "abort") listeners.delete(fn);
    remove(type, fn, options);
  });
  return listeners;
}

test("success preserves fetch options and cleans up its deadline and caller listener", async (t) => {
  const timer = clock();
  const caller = new AbortController();
  const listeners = watchSignal(t, caller.signal);
  const options = {
    method: "POST",
    headers: { "X-Driver": "test" },
    body: "{}",
    signal: caller.signal,
  };
  let seen;
  const pending = request("/api/tools", options, {
    ...timer,
    fetch: async (url, opts) => {
      seen = { url, ...opts };
      return Response.json({ accepted: true });
    },
  });
  assert.equal([...timer.jobs.values()][0].delay, REQUEST_TIMEOUT_MS);
  assert.deepEqual(await pending, { accepted: true });
  assert.equal(seen.url, "/api/tools");
  assert.equal(seen.method, options.method);
  assert.equal(seen.headers, options.headers);
  assert.equal(seen.body, options.body);
  assert.notEqual(seen.signal, caller.signal);
  assert.equal(seen.signal.aborted, false);
  assert.equal(timer.jobs.size, 0);
  assert.equal(listeners.size, 0);
  caller.abort();
  assert.equal(seen.signal.aborted, false);
});

test("application JSON errors retain status, code, and message", async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    for (const error of ["Access changed", { message: "Access changed" }]) {
      const timer = clock();
      await assert.rejects(
        request(
          "/api/page",
          {},
          {
            ...timer,
            fetch: async () => Response.json({ error, code: "PAGE_ACCESS_CHANGED" }, { status }),
          },
        ),
        { message: "Access changed", status, code: "PAGE_ACCESS_CHANGED" },
      );
      assert.equal(timer.jobs.size, 0);
    }
  }
});

test("a failed answer's requested wait comes from its body, then Retry-After", () => {
  const headers = (value) => new Headers(value === undefined ? {} : { "Retry-After": value });
  const now = Date.parse("2026-11-05T12:00:00Z");
  assert.equal(retryAfterOf(headers("7"), { retry_after_ms: 2500 }, now), 2500);
  assert.equal(retryAfterOf(headers("7"), {}, now), 7000);
  assert.equal(retryAfterOf(headers(" 3 "), undefined, now), 3000);
  assert.equal(retryAfterOf(headers("Thu, 05 Nov 2026 12:00:09 GMT"), {}, now), 9000);
  for (const value of [undefined, "", "0", "-1", "1.5", "soon", "Thu, 05 Nov 2026 11:59:00 GMT"])
    assert.equal(retryAfterOf(headers(value), {}, now), undefined, `Retry-After: ${value}`);
  for (const wait of [0, -5, 1.5, "2000", null])
    assert.equal(retryAfterOf(headers(), { retry_after_ms: wait }, now), undefined);
});

test("JSON and proxy errors keep the wait their answer asked for", async () => {
  await assert.rejects(
    request(
      "/api/connect",
      {},
      {
        fetch: async () =>
          Response.json(
            { error: "Too many connections" },
            { status: 429, headers: { "Retry-After": "4" } },
          ),
      },
    ),
    { status: 429, retryAfterMs: 4000 },
  );
  await assert.rejects(
    request(
      "/api/connect",
      {},
      {
        fetch: async () =>
          new Response("<html>Slow down</html>", {
            status: 429,
            headers: { "Retry-After": "2" },
          }),
      },
    ),
    (error) => error.code === "INVALID_RESPONSE" && error.retryAfterMs === 2000,
  );
  await assert.rejects(
    request(
      "/api/connect",
      {},
      { fetch: async () => Response.json({ error: "Not found" }, { status: 404 }) },
    ),
    (error) => error.status === 404 && !("retryAfterMs" in error),
  );
});

test("proxy HTML cannot signal sign-out, revoked access, or a deleted Page", async () => {
  for (const status of [200, 401, 403, 404, 503]) {
    await assert.rejects(
      request(
        "/api/page",
        {},
        {
          fetch: async () => new Response("<html>Private proxy diagnostics</html>", { status }),
        },
      ),
      (error) => {
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.equal(error.status, status >= 500 ? status : undefined);
        assert.equal(error.httpStatus, status);
        assert.doesNotMatch(error.message, /html|Private|diagnostics|JSON/);
        return true;
      },
    );
  }
});

test("malformed JSON and unexpected JSON error shapes are safe transport errors", async () => {
  for (const status of [200, 403, 404, 502]) {
    await assert.rejects(
      request(
        "/api/page",
        {},
        {
          fetch: async () =>
            new Response("truncated {", {
              status,
              headers: { "Content-Type": "application/json" },
            }),
        },
      ),
      (error) =>
        error.code === "INVALID_RESPONSE" && error.status === (status >= 500 ? status : undefined),
    );
  }
  for (const body of [
    null,
    [],
    "Gone",
    { message: "Not found" },
    { error: { details: "Not found" } },
  ]) {
    await assert.rejects(
      request("/api/page", {}, { fetch: async () => Response.json(body, { status: 404 }) }),
      (error) => error.code === "INVALID_RESPONSE" && error.status === undefined,
    );
  }
});

test("JSON-looking proxy bodies without JSON content type are not application errors", async () => {
  await assert.rejects(
    request(
      "/api/page",
      {},
      {
        fetch: async () => new Response('{"error":"Not found"}', { status: 404 }),
      },
    ),
    (error) => error.code === "INVALID_RESPONSE" && error.status === undefined,
  );
});

test("deadline settles a never-ending fetch without retrying a mutation or accepting its late result", async (t) => {
  const timer = clock();
  const caller = new AbortController();
  const listeners = watchSignal(t, caller.signal);
  const transport = deferred();
  let calls = 0,
    signal,
    bodyReads = 0;
  const pending = request(
    "/api/tools",
    { method: "POST", signal: caller.signal },
    {
      ...timer,
      timeoutMs: 5,
      fetch: (_url, options) => {
        calls++;
        signal = options.signal;
        return transport.promise;
      },
    },
  );
  const rejected = assert.rejects(pending, { name: "TimeoutError", code: "REQUEST_TIMEOUT" });
  assert.equal([...timer.jobs.values()][0].delay, 5);
  timer.expire();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(caller.signal.aborted, false);
  assert.equal(listeners.size, 0);
  assert.equal(timer.jobs.size, 0);
  transport.resolve({
    json() {
      bodyReads++;
      return {};
    },
  });
  await Promise.resolve();
  assert.equal(bodyReads, 0);
  assert.equal(calls, 1);
});

test("deadline includes a response body that ignores cancellation", async () => {
  const timer = clock();
  const body = deferred();
  const reading = deferred();
  let signal;
  const pending = request(
    "/api/page",
    {},
    {
      ...timer,
      fetch: async (_url, options) => {
        signal = options.signal;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json() {
            reading.resolve();
            return body.promise;
          },
        };
      },
    },
  );
  await reading.promise;
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  timer.expire();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(timer.jobs.size, 0);
  body.resolve({ late: true });
  await Promise.resolve();
  await assert.rejects(pending, { code: "REQUEST_TIMEOUT" });
});

test("a request past its deadline went unanswered; a caller's abort and a 500 did not", async () => {
  const timer = clock();
  const pending = request(
    "/api/auth/session",
    {},
    { ...timer, fetch: () => new Promise(() => {}) },
  );
  const settled = pending.catch((error) => error);
  timer.expire();
  const timedOut = await settled;
  assert.equal(timedOut.code, "REQUEST_TIMEOUT");
  assert.equal(isTransientFailure(timedOut), false);
  assert.equal(isUnansweredFailure(timedOut), true);
  assert.equal(isUnansweredFailure(new TypeError("Failed to fetch")), true);
  assert.equal(isUnansweredFailure({ code: "NETWORK_ERROR" }), true);
  assert.equal(isUnansweredFailure({ status: 503 }), true);

  const caller = new AbortController();
  const aborted = request(
    "/api/auth/session",
    { signal: caller.signal },
    { ...clock(), fetch: () => new Promise(() => {}) },
  ).catch((error) => error);
  caller.abort();
  assert.equal(isUnansweredFailure(await aborted), false);
  assert.equal(isUnansweredFailure({ status: 500 }), false);
  for (const status of [401, 403]) assert.equal(isUnansweredFailure({ status }), false);
  assert.equal(isUnansweredFailure(undefined), false);
});

test("already-aborted callers do not start fetches or timers", async () => {
  const caller = new AbortController();
  const reason = Error("Page closed");
  caller.abort(reason);
  const timer = clock();
  await assert.rejects(
    request(
      "/api/page",
      { signal: caller.signal },
      {
        ...timer,
        fetch() {
          assert.fail("fetch must not start");
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(timer.jobs.size, 0);
});

test("caller cancellation settles ignored aborts during fetch or body reads and removes listeners", async (t) => {
  for (const stage of ["fetch", "body"]) {
    const timer = clock();
    const caller = new AbortController();
    const listeners = watchSignal(t, caller.signal);
    const transport = deferred();
    const reading = deferred();
    let signal;
    const pending = request(
      "/api/page",
      { signal: caller.signal },
      {
        ...timer,
        fetch: async (_url, options) => {
          signal = options.signal;
          if (stage === "fetch") return transport.promise;
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "Content-Type": "application/json" }),
            json() {
              reading.resolve();
              return transport.promise;
            },
          };
        },
      },
    );
    if (stage === "body") await reading.promise;
    const reason = Error(`Page closed during ${stage}`);
    const rejected = assert.rejects(pending, (error) => error === reason);
    caller.abort(reason);
    await rejected;
    assert.equal(signal.reason, reason);
    assert.equal(listeners.size, 0);
    assert.equal(timer.jobs.size, 0);
    transport.reject(Error("Late transport failure"));
    await Promise.resolve();
  }
});

test("network failures are preserved and release the timer and abort listener", async (t) => {
  const timer = clock();
  const caller = new AbortController();
  const listeners = watchSignal(t, caller.signal);
  const failure = TypeError("Failed to fetch");
  await assert.rejects(
    request(
      "/api/page",
      { signal: caller.signal },
      {
        ...timer,
        fetch: async () => {
          throw failure;
        },
      },
    ),
    (error) => error === failure,
  );
  assert.equal(failure.code, "NETWORK_ERROR");
  assert.equal(listeners.size, 0);
  assert.equal(timer.jobs.size, 0);
});

/** The error request() rejects with for one response or transport failure. */
async function failureOf(fetch) {
  try {
    await request("/api/saved", {}, { fetch });
  } catch (error) {
    return error;
  }
  throw Error("the request succeeded");
}
const cloudflarePage = (status) =>
  new Response(`<!DOCTYPE html><title>${status}: origin unreachable | Cloudflare</title>`, {
    status,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });

test("a gateway answer, a retryable error or a lost connection is transient", async () => {
  for (const status of [502, 503, 504]) {
    for (const [label, fetch] of [
      ["Cloudflare HTML", async () => cloudflarePage(status)],
      ["an empty body", async () => new Response(null, { status })],
      ["JSON", async () => Response.json({ error: "Pages request failed" }, { status })],
    ]) {
      const error = await failureOf(fetch);
      assert.equal(error.status, status, `${status} ${label}`);
      assert.equal(isTransientFailure(error), true, `${status} ${label}`);
    }
  }
  const retryable = await failureOf(async () =>
    Response.json(
      { error: "The Page host is busy", code: "host_busy", retryable: true },
      { status: 500 },
    ),
  );
  assert.equal(retryable.retryable, true);
  assert.equal(isTransientFailure(retryable), true);
  const lost = await failureOf(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(isTransientFailure(lost), true);
  // Failures from fetch calls that bypass request().
  for (const message of [
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Load failed",
    "fetch failed",
  ])
    assert.equal(isTransientFailure(new TypeError(message)), true, message);
});

test("errors the person can act on, timeouts and other failures are not transient", async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    const json = await failureOf(async () =>
      Response.json({ error: "Specific", code: "specific" }, { status }),
    );
    assert.equal(isTransientFailure(json), false, `JSON ${status}`);
    const html = await failureOf(async () => cloudflarePage(status));
    assert.equal(isTransientFailure(html), false, `HTML ${status}`);
  }
  const timer = clock();
  const pending = request("/api/saved", {}, { ...timer, fetch: () => new Promise(() => {}) });
  timer.expire();
  await assert.rejects(pending, (error) => !isTransientFailure(error));
  for (const error of [
    undefined,
    null,
    "Failed to fetch",
    Error("Failed to fetch"),
    new TypeError("Cannot read properties of undefined"),
    new TypeError("Failed to fetch dynamically imported module: /chunks/AAAAAAAA.js"),
    Object.assign(Error("Specific"), { status: 500, retryable: false }),
  ])
    assert.equal(isTransientFailure(error), false, String(error));
});

test("a tool call the server refuses as signed out tells the observers once", async (t) => {
  const answers = [
    () => Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 }),
    () => Response.json({ error: "Forbidden", code: "access_denied" }, { status: 403 }),
    () => new Response("<html>proxy</html>", { status: 401 }),
    () => Response.json({ pages: [] }),
  ];
  t.mock.method(globalThis, "fetch", async () => answers.shift()());
  const seen = [];
  const stop = observeSignedOut((error) => seen.push(error.code));
  // An observer that throws never reaches the call or the other observers.
  const stopThrowing = observeSignedOut(() => {
    throw new Error("observer failed");
  });
  await assert.rejects(tool("list_pages"), { status: 401, code: "unauthenticated" });
  await assert.rejects(tool("list_pages"), { status: 403 });
  await assert.rejects(tool("list_pages"), { code: "INVALID_RESPONSE", httpStatus: 401 });
  assert.deepEqual(await tool("list_pages"), { pages: [] });
  assert.deepEqual(seen, ["unauthenticated"], "only a JSON 401 means signed out");
  stop();
  stopThrowing();
});

test("a tool call its caller cancelled never counts as signed out", async (t) => {
  const answered = [];
  t.mock.method(globalThis, "fetch", () => {
    // The server refuses the call, but only after the caller cancelled it.
    const reply = new Promise((resolve) => answered.push(resolve));
    return reply.then(() =>
      Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 }),
    );
  });
  const seen = [];
  const stop = observeSignedOut((error) => seen.push(error.code));
  t.after(stop);
  const controller = new AbortController();
  const call = tool("list_pages", { limit: 100 }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.fetch.mock.calls[0].arguments[1].signal.aborted, false);
  controller.abort(new DOMException("Closed", "AbortError"));
  assert.equal(
    globalThis.fetch.mock.calls[0].arguments[1].signal.aborted,
    true,
    "the request in flight is aborted",
  );
  answered[0]();
  await assert.rejects(call, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [], "no recovery starts");
  // A call cancelled before it starts never reaches the server.
  await assert.rejects(tool("list_pages", {}, { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(globalThis.fetch.mock.calls.length, 1);
  // Without a signal, the same refusal still counts.
  const plain = tool("list_pages");
  await new Promise((resolve) => setImmediate(resolve));
  answered[1]();
  await assert.rejects(plain, { status: 401 });
  assert.deepEqual(seen, ["unauthenticated"]);
});

test("a 401 whose call an observer cancelled first tells the observers only once", async (t) => {
  // Two calls are refused at once: the library's, and a walk's under its own
  // signal. The first refusal's observer cancels the walk, as the shell's
  // Browse picker does, after the walk's 401 already arrived. That 401 must
  // not reach the observers a second time.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 }),
  );
  const walk = new AbortController();
  const seen = [];
  const stop = observeSignedOut((error) => {
    seen.push(error.code);
    walk.abort(new DOMException("Closed", "AbortError"));
  });
  t.after(stop);
  const library = tool("list_pages");
  const walking = tool("list_pages", { limit: 100 }, { signal: walk.signal });
  await assert.rejects(library, { status: 401 });
  // The walk's answer arrived before the cancel, so it still rejects with it.
  await assert.rejects(walking, { status: 401 });
  assert.equal(walk.signal.aborted, true);
  assert.deepEqual(seen, ["unauthenticated"], "one refusal reached the observers");
});
