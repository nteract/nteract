import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.mjs";
import { agentGuide } from "../agent-guide.mjs";
import { tools } from "../mcp.mjs";

const origin = "https://pages-next.runtimed.run";
const env = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
  get DB() {
    throw Error("Public instructions must not look up a session");
  },
  get ASSETS() {
    throw Error("Public instructions must not fall back to the editor shell");
  },
};

test("GET llms.txt is readable without authentication and explains the supported tools", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("Public instructions must not verify a credential");
  });
  const response = await worker.fetch(new Request(origin + "/llms.txt"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("set-cookie"), null);
  const guide = await response.text();
  assert.ok(guide.startsWith("# Pages\n"));
  for (const { name } of tools) assert.ok(guide.includes(name), name);
  for (const value of [
    "Authorization: Bearer",
    "X-Pages-Driver",
    "cloud:read",
    "cloud:write",
    "base_heads",
    "idempotency_key",
    "result.isError",
    "sharing permissions are not yet",
    `${origin}/mcp`,
    `${origin}/api/tools`,
    `${origin}/p/<page_id>`,
  ])
    assert.ok(guide.includes(value), value);
  for (const [, example] of guide.matchAll(/```json\n([\s\S]*?)\n```/g))
    assert.doesNotThrow(() => JSON.parse(example));
});

test("guide URLs use deployment configuration instead of request headers or credentials", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("Public instructions must not verify a credential");
  });
  const response = await worker.fetch(
    new Request("https://attacker.invalid/llms.txt?token=private-query", {
      headers: {
        host: "attacker.invalid",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
        authorization: "Bearer private-key",
        cookie: "private-cookie",
        "x-pages-driver": "Private driver",
      },
    }),
    Object.assign(Object.create(env), {
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://different-pages.example/",
    }),
  );
  assert.equal(response.status, 200);
  const guide = await response.text();
  assert.ok(guide.includes("https://different-pages.example/mcp"));
  for (const value of [
    "attacker.invalid",
    "private-query",
    "private-key",
    "private-cookie",
    "Private driver",
    origin,
  ])
    assert.equal(guide.includes(value), false, value);
});

test("HEAD returns guide headers without a body; unsupported methods cannot mutate anything", async () => {
  const head = await worker.fetch(new Request(origin + "/llms.txt", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await head.text(), "");
  const post = await worker.fetch(
    new Request(origin + "/llms.txt", { method: "POST", body: "ignored" }),
    env,
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal(await post.text(), "");
});

test("guide permits loopback development but refuses missing or unsafe public-origin configuration", () => {
  assert.ok(
    agentGuide({ NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://localhost:9894" }).includes(
      "http://localhost:9894/mcp",
    ),
  );
  for (const configured of [
    undefined,
    "not-a-url",
    "http://public.example",
    "https://secret@pages.example",
    "javascript:alert(1)",
  ])
    assert.throws(() => agentGuide({ NOTEBOOK_CLOUD_PUBLIC_ORIGIN: configured }));
});
