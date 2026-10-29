import assert from "node:assert/strict";
import test from "node:test";
import { request, REQUEST_TIMEOUT_MS } from "./request.mjs";

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
