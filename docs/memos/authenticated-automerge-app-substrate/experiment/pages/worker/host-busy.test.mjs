import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOST_BUSY_TEXT,
  PAGE_BUSY,
  legibleEnv,
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
    PAGES_EDITOR: "wordgard",
  };
  const legible = legibleEnv(env);
  for (const name of ["PAGES", "CATALOGS", "PROJECTS"]) {
    const response = await legible[name].getByName("x").fetch(new Request("https://p.internal"));
    assert.equal((await response.json()).code, "page_busy", name);
  }
  assert.equal(legible.PAGE_RECORDS, env.PAGE_RECORDS);
  assert.equal(legible.DB, env.DB);
  assert.equal(legible.PAGES_EDITOR, "wordgard");
  assert.equal(legibleEnv({}).PAGES, undefined);
});
