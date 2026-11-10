import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOST_BUSY_TEXT,
  HOST_REFUSAL_CODES,
  PAGE_BUSY,
  PAGE_TRANSIENT_FAILURE,
  legibleEnv,
  legibleHostError,
  overloadRetryAfterMs,
  pageTransientFailureResponse,
  withRepeatSafety,
  legibleHostRefusal,
  legibleNamespace,
} from "./host-busy.mjs";

const hostRefusal = () =>
  new Response(HOST_BUSY_TEXT, { status: 503, headers: { "content-type": "text/plain" } });

test("celld's plain-text refusal becomes a JSON page_busy refusal with Retry-After", async () => {
  const response = await legibleHostRefusal(hostRefusal());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("retry-after"), "1");
  const body = await response.json();
  assert.equal(body.code, PAGE_BUSY.code);
  assert.equal(body.retryable, true);
  assert.equal(body.retry_after_ms, PAGE_BUSY.retryAfterMs);
  assert.match(body.error, /same idempotency_key and retry_token/);
});

test("every other response passes through with its body untouched", async () => {
  const ours = Response.json({ error: "Record persistence failed", code: "x" }, { status: 503 });
  assert.equal(await legibleHostRefusal(ours), ours);
  const ok = new Response("fine", { status: 200 });
  assert.equal(await legibleHostRefusal(ok), ok);
  const empty = new Response(null, { status: 503 });
  assert.equal(await legibleHostRefusal(empty), empty);
  // Another short plain 503 keeps its bytes, read once and rewrapped.
  const other = new Response("Record persistence failed", {
    status: 503,
    headers: { "content-type": "text/plain", "x-custom": "kept" },
  });
  const passed = await legibleHostRefusal(other);
  assert.equal(passed.status, 503);
  assert.equal(passed.headers.get("x-custom"), "kept");
  assert.equal(await passed.text(), "Record persistence failed");
  // A long plain body is never celld's refusal and is not read.
  const long = new Response("x".repeat(4096), {
    status: 503,
    headers: { "content-type": "text/plain", "content-length": "4096" },
  });
  assert.equal(await legibleHostRefusal(long), long);
});

test("a wrapped namespace answers legibly through getByName and get, and keeps other members", async () => {
  const seen = [];
  const namespace = {
    jurisdiction: "local",
    idFromName: (name) => `id:${name}`,
    getByName(name) {
      return {
        name,
        async fetch(request) {
          seen.push([name, request.url]);
          return name === "busy" ? hostRefusal() : Response.json({ page_id: name });
        },
      };
    },
    get(id) {
      return this.getByName(id.slice(3));
    },
  };
  const legible = legibleNamespace(namespace);
  assert.equal(legible.jurisdiction, "local");
  assert.equal(legible.idFromName("p"), "id:p");
  const busy = await legible.getByName("busy").fetch(new Request("https://pages.internal/x"));
  assert.equal((await busy.json()).code, "page_busy");
  const fine = await legible.get("id:fine").fetch(new Request("https://pages.internal/y"));
  assert.deepEqual(await fine.json(), { page_id: "fine" });
  assert.equal(legible.getByName("fine").name, "fine");
  assert.deepEqual(seen, [
    ["busy", "https://pages.internal/x"],
    ["fine", "https://pages.internal/y"],
  ]);
});

test("legibleEnv wraps the object namespaces the gateway forwards to and nothing else", async () => {
  const stub = { fetch: async () => hostRefusal() };
  const env = {
    PAGES: { getByName: () => stub },
    CATALOGS: { getByName: () => stub },
    PROJECTS: { getByName: () => stub },
    PAGE_RECORDS: { getByName: () => stub },
    DB: { prepare() {} },
    PAGES_CATALOG_INDEX: "1",
  };
  const legible = legibleEnv(env);
  for (const name of ["PAGES", "CATALOGS", "PROJECTS"]) {
    const response = await legible[name].getByName("x").fetch(new Request("https://p.internal"));
    assert.equal((await response.json()).code, "page_busy", name);
  }
  assert.equal(legible.PAGE_RECORDS, env.PAGE_RECORDS);
  assert.equal(legible.DB, env.DB);
  assert.equal(legible.PAGES_CATALOG_INDEX, "1");
  assert.equal(legibleEnv({}).PAGES, undefined);
});

/** Cloudflare's infrastructure errors: an Error with flags, thrown by fetch. */
const cloudflareError = (message, flags) => Object.assign(new Error(message), flags);

test("a thrown overload or transient error answers as a JSON refusal; other errors are unchanged", async (t) => {
  const logged = [];
  t.mock.method(console, "warn", (line) => logged.push(JSON.parse(line)));
  let next;
  const legible = legibleNamespace(
    {
      getByName: () => ({
        fetch() {
          const error = next();
          if (error.sync) throw error;
          return Promise.reject(error);
        },
      }),
    },
    "PAGES",
  );
  const send = (error) => {
    next = () => error;
    return legible.getByName("p").fetch(new Request("https://pages.internal/x"));
  };

  for (const sync of [false, true]) {
    const overloaded = cloudflareError("Durable Object is overloaded. Too many requests queued.", {
      overloaded: true,
      sync,
    });
    const busy = await send(overloaded);
    assert.equal(busy.status, 503);
    const body = await busy.json();
    assert.equal(body.code, PAGE_BUSY.code);
    assert.equal(body.retryable, true);
    // An overload asks for a longer, jittered wait, the same in both places.
    assert.ok([2000, 3000, 4000, 5000].includes(body.retry_after_ms), body.retry_after_ms);
    assert.equal(busy.headers.get("retry-after"), String(body.retry_after_ms / 1000));
    assert.match(body.error, /^This Page /);
    assert.match(body.error, /back off exponentially/);

    const lost = await send(cloudflareError("Network connection lost.", { retryable: true, sync }));
    assert.equal(lost.status, 503);
    assert.equal(lost.headers.get("retry-after"), "1");
    assert.equal(lost.headers.get("content-type"), "application/json");
    const transient = await lost.json();
    assert.equal(transient.code, PAGE_TRANSIENT_FAILURE.code);
    assert.equal(transient.retryable, true);
    assert.match(transient.error, /read back and reconcile/);
  }

  // An overload that is also marked retryable did not run: page_busy.
  const both = await send(cloudflareError("overloaded", { overloaded: true, retryable: true }));
  assert.equal((await both.json()).code, PAGE_BUSY.code);

  // Anything else reaches the caller as it was thrown, the same object.
  for (const error of [
    new Error("example error"),
    cloudflareError("remote", { remote: true }),
    cloudflareError("not retryable", { retryable: false, overloaded: false }),
    Object.assign(new DOMException("aborted", "AbortError"), {}),
  ]) {
    await assert.rejects(send(error), (thrown) => thrown === error);
    await assert.rejects(send(Object.assign(error, { sync: true })), (thrown) => thrown === error);
  }

  // Each refusal logs one content-free line naming the binding.
  assert.deepEqual(
    logged.map(({ event, binding }) => [event, binding]),
    [
      ["host.overloaded", "PAGES"],
      ["host.transient_failure", "PAGES"],
      ["host.overloaded", "PAGES"],
      ["host.transient_failure", "PAGES"],
      ["host.overloaded", "PAGES"],
    ],
  );
  assert.ok(logged.every((line) => !JSON.stringify(line).includes("Network")));
});

test("legibleHostError is the mapping the stub wrapper uses", async (t) => {
  t.mock.method(console, "warn", () => {});
  assert.equal(
    (await legibleHostError(cloudflareError("x", { overloaded: true })).json()).code,
    "page_busy",
  );
  assert.equal(
    (await legibleHostError(cloudflareError("x", { retryable: true })).json()).code,
    "page_transient_failure",
  );
  const plain = new Error("plain");
  assert.throws(
    () => legibleHostError(plain),
    (thrown) => thrown === plain,
  );
  assert.throws(
    () => legibleHostError(undefined),
    (thrown) => thrown === undefined,
  );
  assert.deepEqual(HOST_REFUSAL_CODES, ["page_busy", "page_transient_failure"]);
});

test("legibleEnv maps thrown errors for every namespace it wraps and leaves PAGE_RECORDS raw", async (t) => {
  t.mock.method(console, "warn", () => {});
  const overloaded = cloudflareError("overloaded", { overloaded: true });
  const stub = { fetch: async () => Promise.reject(overloaded) };
  const env = {
    PAGES: { getByName: () => stub },
    CATALOGS: { getByName: () => stub },
    PROJECTS: { getByName: () => stub },
    PAGE_RECORDS: { getByName: () => stub },
  };
  const legible = legibleEnv(env);
  for (const name of ["PAGES", "CATALOGS", "PROJECTS"]) {
    const response = await legible[name].getByName("x").fetch(new Request("https://p.internal"));
    assert.equal((await response.json()).code, "page_busy", name);
  }
  await assert.rejects(
    legible.PAGE_RECORDS.getByName("x").fetch(new Request("https://p.internal")),
    (thrown) => thrown === overloaded,
  );
});

test("an overload's wait is 2 to 5 whole seconds, at random", () => {
  assert.equal(
    overloadRetryAfterMs(() => 0),
    2000,
  );
  assert.equal(
    overloadRetryAfterMs(() => 0.3),
    3000,
  );
  assert.equal(
    overloadRetryAfterMs(() => 0.6),
    4000,
  );
  assert.equal(
    overloadRetryAfterMs(() => 0.999999),
    5000,
  );
  assert.equal(
    overloadRetryAfterMs(() => 1),
    5000,
  );
  for (let n = 0; n < 200; n++) {
    const ms = overloadRetryAfterMs();
    assert.ok(ms >= 2000 && ms <= 5000 && ms % 1000 === 0, ms);
  }
});

test("refusals name the object the gateway called", async (t) => {
  t.mock.method(console, "warn", () => {});
  const subjects = {
    PAGES: /^This Page /,
    CATALOGS: /^Your account's Catalog /,
    PROJECTS: /^This Project /,
    OTHER: /^This Pages object /,
  };
  for (const [binding, subject] of Object.entries(subjects)) {
    const namespace = legibleNamespace(
      { getByName: () => ({ fetch: async () => next() }) },
      binding,
    );
    let next = () => hostRefusal();
    const celld = await (
      await namespace.getByName("x").fetch(new Request("https://p.internal"))
    ).json();
    assert.match(celld.error, subject, binding);
    assert.equal(
      celld.retry_after_ms,
      PAGE_BUSY.retryAfterMs,
      "celld's refusal keeps its 1 s wait",
    );
    for (const flags of [{ overloaded: true }, { retryable: true }]) {
      next = () => Promise.reject(cloudflareError("x", flags));
      const body = await (
        await namespace.getByName("x").fetch(new Request("https://p.internal"))
      ).json();
      assert.match(body.error, subject, `${binding} ${JSON.stringify(flags)}`);
    }
  }
});

test("a transient refusal restated for a tool request follows its repeat safety", async (t) => {
  t.mock.method(console, "warn", () => {});
  const transient = pageTransientFailureResponse({ binding: "CATALOGS" });
  const cases = [
    [true, true, /receipt replays/],
    [false, false, /Read back and reconcile/],
    ["lease", false, /do not loop creating sessions/],
    [undefined, true, /read back and reconcile before retrying/],
  ];
  for (const [safe, retryable, advice] of cases) {
    const response = await withRepeatSafety(transient, safe);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "page_transient_failure");
    assert.equal(body.retryable, retryable, String(safe));
    assert.match(body.error, advice, String(safe));
    assert.match(body.error, /^Your account's Catalog /);
    assert.equal(response.headers.get("retry-after"), "1");
  }
  // Other refusals keep their payload; successful responses stay unread.
  const busy = legibleHostError(cloudflareError("x", { overloaded: true }));
  const expected = await busy.clone().json();
  const passed = await withRepeatSafety(busy, false, new AbortController().signal);
  assert.equal(passed.status, busy.status);
  assert.deepEqual(await passed.json(), expected);
  const ok = new Response("ok");
  assert.equal(await withRepeatSafety(ok, false), ok);
});

test("repeat-safety leaves other JSON, malformed and empty response bodies unread", async () => {
  for (const text of [
    '{ "code": "request_timeout", "retryable": true }',
    '{ "code": "page_busy", "retryable": true }',
    '{"unfinished":',
    "null",
    "",
  ]) {
    const response = new Response(text || null, {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "2" },
    });
    const actual = await withRepeatSafety(response, false, new AbortController().signal);
    assert.equal(actual.status, 503);
    assert.equal(actual.headers.get("retry-after"), "2");
    assert.equal(await actual.text(), text);
  }
});
