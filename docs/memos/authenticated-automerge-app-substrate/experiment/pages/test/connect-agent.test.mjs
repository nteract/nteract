import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import worker from "../worker/index.mjs";
import { agentConnectionSetup } from "../connect-agent.mjs";
import { codexConfig, kiloConfig, setupPrompt } from "../agent-client-setup.mjs";
const origin = "https://page5.runtimed.run";
const env = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://anaconda.com/api/auth/sessions/whoami",
  get DB() {
    throw Error("Public setup must not read an account");
  },
  get ASSETS() {
    throw Error("Public setup must not load the editor shell");
  },
};

test("setup is public, uses configured destinations, and never reflects credentials or request URLs", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("No credential verification on the setup page");
  });
  const response = await worker.fetch(
    new Request("https://attacker.invalid/connect?token=secret-query", {
      headers: {
        authorization: "Bearer secret-key",
        cookie: "secret-cookie",
        "x-forwarded-host": "attacker.invalid",
      },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);
  const html = await response.text();
  for (const forbidden of [
    "secret-query",
    "secret-key",
    "secret-cookie",
    "attacker.invalid",
    "/app.js",
  ])
    assert.equal(html.includes(forbidden), false, forbidden);
  const dom = new JSDOM(html).window.document;
  assert.equal(dom.getElementById("mcp-endpoint").textContent, origin + "/mcp");
  assert.equal(dom.getElementById("mcp-headers").textContent, agentConnectionSetup(env).headers);
  assert.equal(
    dom.querySelector(".setup-action").href,
    "https://anaconda.com/app/profile/api-keys",
  );
  assert.equal(dom.querySelectorAll("input, textarea, form").length, 0);
  assert.equal(dom.querySelectorAll("[data-copy][hidden]").length, 8);
  assert.equal(dom.getElementById("oauth-endpoint").textContent, origin + "/mcp");
  assert.equal(dom.getElementById("kilo-config").textContent, kiloConfig(origin));
  assert.equal(dom.getElementById("codex-config").textContent, codexConfig(origin));
  assert.equal(dom.getElementById("setup-prompt").textContent, setupPrompt(origin));
});

test("setup supports HEAD and refuses mutation methods", async () => {
  const response = await worker.fetch(new Request(origin + "/connect", { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  const post = await worker.fetch(new Request(origin + "/connect", { method: "POST" }), env);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("staging or unknown identity providers cannot direct people to create a production key", async () => {
  for (const provider of [
    undefined,
    "https://auth.stage.anaconda.com/api/auth/sessions/whoami",
    "https://attacker.invalid/whoami",
  ]) {
    const response = await worker.fetch(
      new Request(origin + "/connect"),
      Object.assign(Object.create(env), {
        NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: provider,
      }),
    );
    const html = await response.text();
    assert.equal(html.includes("https://anaconda.com/app/profile/api-keys"), false);
    assert.ok(html.includes("Ask the deployment owner"));
    assert.equal(html.includes("attacker.invalid"), false);
  }
});
