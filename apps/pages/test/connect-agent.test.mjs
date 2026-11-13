import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import worker from "../worker/index.mjs";
import { agentConnectionSetup } from "../connect-agent.mjs";
import {
  checkAccountCommand,
  claudeCodeAddCommand,
  claudeCodeHeaderHelper,
  codexConfig,
  kiloApiKeyConfig,
  kiloConfig,
  pagesAgentEnvrc,
  setupPrompt,
} from "../agent-client-setup.mjs";
const origin = "https://page10.runtimed.run";
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
  assert.equal(dom.title, "Connect an agent · Pages");
  assert.equal(dom.querySelector(".app-header .brand").textContent, "Pages");
  const theme = dom.head.querySelector('script[src="/theme.js"]');
  assert.ok(theme);
  assert.equal(
    theme.hasAttribute("defer") || theme.hasAttribute("async") || theme.hasAttribute("type"),
    false,
  );
  assert.ok(html.indexOf("/theme.js") < html.indexOf("/app.css"));
  assert.match(response.headers.get("content-security-policy"), /script-src 'self';/);
  assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-inline|unsafe-eval/);
  assert.equal(dom.getElementById("mcp-endpoint").textContent, origin + "/mcp");
  assert.equal(dom.getElementById("mcp-headers").textContent, agentConnectionSetup(env).headers);
  assert.equal(
    dom.querySelector(".setup-action").href,
    "https://anaconda.com/app/profile/api-keys",
  );
  assert.equal(dom.querySelectorAll("input, textarea, form").length, 0);
  assert.equal(dom.querySelectorAll("[data-copy][hidden]").length, 14);
  assert.equal(dom.getElementById("oauth-endpoint").textContent, origin + "/mcp");
  assert.equal(dom.getElementById("kilo-config").textContent, kiloConfig(origin));
  assert.equal(dom.getElementById("kilo-api-key-config").textContent, kiloApiKeyConfig(origin));
  assert.equal(dom.getElementById("codex-config").textContent, codexConfig(origin));
  assert.equal(dom.getElementById("claude-code-helper").textContent, claudeCodeHeaderHelper);
  assert.equal(dom.getElementById("claude-code-add").textContent, claudeCodeAddCommand(origin));
  assert.equal(dom.getElementById("setup-prompt").textContent, setupPrompt(origin));
  assert.equal(dom.getElementById("pages-agent-envrc").textContent, pagesAgentEnvrc);
});

test("setup leads with API keys and keeps OAuth for interactive clients", async () => {
  const response = await worker.fetch(new Request(origin + "/connect"), env);
  const dom = new JSDOM(await response.text()).window.document;
  const order = [...dom.querySelectorAll("main h2")].map((heading) => heading.id);
  assert.ok(order.indexOf("setup-api-key-clients") < order.indexOf("setup-key"));
  assert.ok(order.indexOf("setup-try") < order.indexOf("setup-oauth"));
  assert.equal(order[0], "setup-api-key-clients");
  // Kilo's primary recipe is the API key; its OAuth recipe sits under OAuth.
  const kilo = dom.getElementById("kilo");
  assert.ok(kilo.contains(dom.getElementById("kilo-api-key-config")));
  const oauth = dom.querySelector('section[aria-labelledby="setup-oauth"]');
  assert.ok(oauth.contains(dom.getElementById("kilo-oauth")));
  assert.ok(oauth.contains(dom.getElementById("kilo-config")));
  const oauthText = oauth.textContent.replace(/\s+/g, " ");
  for (const fact of [
    "Access tokens last 10 minutes",
    "Each refresh token is replaced on use",
    "Several processes can share one OAuth connection",
    "nothing has to run in the background",
    "30 days after you approve it",
    "revokes the whole connection",
    "use an API key",
  ])
    assert.ok(oauthText.includes(fact), fact);
  const labels = dom.getElementById("session-labels").textContent.replace(/\s+/g, " ");
  for (const fact of ["X-Pages-Driver", "X-Pages-Agent", "at most 80 characters", "Mcp-Session-Id"])
    assert.ok(labels.includes(fact), fact);
  assert.ok(labels.includes('"X-Pages-Agent": "{env:PAGES_AGENT}"'));
  const usage = dom.getElementById("client-model").textContent.replace(/\s+/g, " ");
  for (const fact of ["X-Pages-Client", "X-Pages-Model", "never affect access", "120 characters"])
    assert.ok(usage.includes(fact), fact);
});

test("Claude Code has its own recipe, and the generic block no longer names it", async () => {
  const response = await worker.fetch(new Request(origin + "/connect"), env);
  const dom = new JSDOM(await response.text()).window.document;
  const recipe = dom.getElementById("claude-code");
  assert.equal(recipe.tagName, "DETAILS");
  assert.equal(recipe.querySelector("summary").textContent, "Claude Code");
  assert.ok(dom.querySelector('section[aria-labelledby="setup-client"]').contains(recipe));
  for (const id of ["claude-code-helper", "claude-code-add"]) {
    assert.ok(recipe.contains(dom.getElementById(id)), id);
    const copy = recipe.querySelector(`[data-copy="${id}"]`);
    assert.equal(copy.hidden, true, id);
    assert.ok(copy.dataset.copyMessage, id);
  }
  const add = dom.getElementById("claude-code-add").textContent;
  assert.ok(add.startsWith("claude mcp add-json --scope user pages '{"));
  assert.deepEqual(JSON.parse(add.slice(add.indexOf("'{") + 1, -1)), {
    type: "http",
    url: origin + "/mcp",
    headersHelper: "<ABSOLUTE_PATH_TO_PYTHON3> <ABSOLUTE_PATH_TO_CLAUDE_CODE_HEADERS_PY>",
  });
  const helper = dom.getElementById("claude-code-helper").textContent;
  assert.ok(helper.includes('"X-Pages-Driver": "Claude Code"'));
  assert.ok(helper.includes('os.environ.get("PAGES_AGENT"'));
  assert.ok(helper.includes(".config/pages/anaconda-api-key"));
  const prose = recipe.textContent.replace(/\s+/g, " ");
  for (const fact of [
    "contains no secret",
    "on every connection and gives it 10 seconds",
    "doesn't fall back to OAuth",
    "folder-trust prompt",
    "It writes your key into ~/.claude.json",
    'reports "Needs authentication"',
    "Configuration alone doesn't verify access",
  ])
    assert.ok(prose.includes(fact), fact);
  assert.ok(!dom.getElementById("save-key-command").textContent.includes("claude"));
  // The generic block is for clients without a header helper.
  const other = dom.getElementById("other-client");
  assert.equal(other.querySelector("summary").textContent, "Other MCP clients");
  assert.equal(other.textContent.includes("Claude Code"), false);
  assert.ok(other.contains(dom.getElementById("mcp-headers")));
});

test("setup supports HEAD and refuses mutation methods", async () => {
  const response = await worker.fetch(new Request(origin + "/connect", { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  const post = await worker.fetch(new Request(origin + "/connect", { method: "POST" }), env);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("setup exposes account-safe saving and reload-before-verification outside collapsed recipes", async () => {
  const response = await worker.fetch(new Request(origin + "/connect"), env);
  const dom = new JSDOM(await response.text()).window.document;
  const save = dom.querySelector('section[aria-labelledby="setup-save"]');
  for (const fact of [
    "~/.config/pages/anaconda-api-key-rgbkrk",
    "Inspect filenames, not secrets",
    "ask before reusing or replacing an existing key",
    "separate helper filename per account",
    "Codex and Claude Code helpers",
    "refuses to overwrite an existing file",
  ])
    assert.ok(save.textContent.includes(fact), fact);
  const check = dom.querySelector('section[aria-labelledby="setup-try"]');
  assert.equal(check.closest("details"), null);
  assert.equal(
    check.querySelector("strong").textContent,
    "Reload MCP or start a new session, then call list_pages from that session.",
  );
  for (const fact of [
    "A config file or a client status label alone doesn't verify access",
    "quota.count counts active owned Pages, excluding shared Pages",
    "quota.trash_count counts your trashed Pages separately",
    "no content edit time is recorded, including for new Pages and legacy Pages",
    "don't invent an edit timestamp",
  ])
    assert.ok(check.textContent.includes(fact), fact);
  assert.ok(
    dom.body.textContent.includes("Anaconda User Resources permissions, not just Pages access"),
  );
  assert.equal(
    dom.getElementById("check-account-command").textContent,
    checkAccountCommand(origin),
  );
  const copyCheck = dom.querySelector('[data-copy="check-account-command"]');
  assert.equal(copyCheck.textContent, "Copy account check");
  assert.equal(dom.getElementById(copyCheck.dataset.copy).textContent, checkAccountCommand(origin));
  for (const fact of [
    "GET /whoami",
    "email only when the provider supplies a verified email",
    "not expiry",
    "does not replace MCP reload and list_pages verification",
    "pending creations and lifecycle reservations in owned catalog slots",
  ])
    assert.ok(check.textContent.includes(fact), fact);
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
