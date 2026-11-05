import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../worker/index.mjs";
import { agentGuide } from "../agent-guide.mjs";
import { MCP_ERROR_CODES, tools } from "../mcp.mjs";
import { CLIENT_ERROR_CODES, RETRYABLE_SERVER_CODES } from "../worker/auth.mjs";
import { MOVE_STATUS } from "../worker/move-page.mjs";
import { STATUS_FALLBACK_CODES } from "../worker/project-api.mjs";
import { READ_ERROR_CODES } from "../worker/tool-reads.mjs";
import { CHANGE_ERROR_CODES } from "../worker/tool-changes.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";
import {
  checkAccountCommand,
  codexConfig,
  kiloApiKeyConfig,
  kiloConfig,
  pagesAgentEnvrc,
  saveKeyCommand,
} from "../agent-client-setup.mjs";

/** The `code: "..."` literals in a source file, relative to this test. */
const codeLiterals = (path) =>
  [...readFileSync(new URL(path, import.meta.url), "utf8").matchAll(/\bcode: "([a-z_]+)"/g)].map(
    ([, code]) => code,
  );

test("MCP_ERROR_CODES lists every code the MCP endpoint writes itself", () => {
  // A new code literal in mcp.mjs fails here until it is listed, and the
  // guide test below fails until the guide documents it.
  assert.deepEqual(new Set(codeLiterals("../mcp.mjs")), new Set(MCP_ERROR_CODES));
});

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
  assert.ok(guide.startsWith(`# ${PRODUCT_NAME}\n`));
  assert.ok(guide.startsWith("# Pages\n"));
  // A fetch that truncates the guide still gets the quick start and the codes.
  for (const marker of ["## Quick start", "## Error codes", "auth_required", "invalid_retry_token"])
    assert.ok(guide.indexOf(marker) < 12_000, marker);
  // Every code a client can receive is in the error list, ahead of setup.
  const codeList = guide.slice(
    guide.indexOf("## Error codes"),
    guide.indexOf("## Connect your agent"),
  );
  for (const code of new Set([
    ...CLIENT_ERROR_CODES,
    ...RETRYABLE_SERVER_CODES,
    ...Object.keys(MOVE_STATUS),
    ...MCP_ERROR_CODES,
    ...STATUS_FALLBACK_CODES,
    ...READ_ERROR_CODES,
    ...CHANGE_ERROR_CODES,
    ...codeLiterals("../worker/tool-reads.mjs"),
    ...codeLiterals("../worker/tool-changes.mjs"),
  ]))
    assert.match(codeList, new RegExp(`\\b${code}\\b`), code);
  assert.equal(guide.match(/^### One (document )?title/gm).length, 1, "one title section");
  for (const stale of [
    "prototype",
    "in this pass",
    "In this build",
    "Dot's",
    "checked with",
    "rotating refresh without",
    "Sign In",
  ])
    assert.equal(guide.includes(stale), false, stale);
  for (const { name } of tools) assert.ok(guide.includes(name), name);
  assert.ok(
    guide.indexOf("Ask the human for their step early") < guide.indexOf("### Kilo Desktop"),
  );
  assert.ok(guide.includes(kiloConfig(origin)));
  assert.ok(guide.includes(kiloApiKeyConfig(origin)));
  assert.ok(guide.includes(codexConfig(origin)));
  // API keys lead; OAuth follows for interactive clients, with its lifecycle
  // and the shared-token warning.
  assert.ok(
    guide.indexOf("### Kilo Desktop / CLI (API key, recommended)") <
      guide.indexOf("### ChatGPT / cloud connection (OAuth)"),
  );
  assert.ok(
    guide.indexOf("### ChatGPT / cloud connection (OAuth)") <
      guide.indexOf("### Kilo Desktop / CLI (OAuth, one process at a time)"),
  );
  const prose = guide.replace(/\s+/g, " ");
  for (const fact of [
    "access tokens expire after 10 minutes",
    "each one works once and is replaced on use",
    "The grant expires 30 days after authorization",
    "Nothing needs to run in the background",
    "revokes the whole grant",
    "X-Pages-Agent: a short session label",
    "at most 80 characters",
    '"X-Pages-Agent": "{env:PAGES_AGENT}"',
    "Mcp-Session-Id",
    "self-declared",
    "X-Pages-Client: <harness>/<version>",
    "X-Pages-Model: the model id",
    "they never affect access",
  ])
    assert.ok(prose.includes(fact), fact);
  assert.ok(guide.includes(pagesAgentEnvrc));
  assert.ok(guide.includes(saveKeyCommand));
  for (const value of [
    "Authorization: Bearer",
    "X-Pages-Driver",
    "cloud:read",
    "cloud:write",
    "base_heads",
    "idempotency_key",
    "result.isError",
    "structuredContent",
    "Branch on code, not on the error message",
    "stale_heads",
    "invalid_edit_selector",
    "replace_match",
    "context_before/context_after",
    "format_match",
    "replace_block_markdown",
    "never streams keystrokes",
    "only the owner can manage access",
    "expected_revision",
    "No anonymous link access",
    "import_page_image",
    "openai/fileParams",
    "do not invent a download URL from its file ID",
    "only HTTPS files.oaiusercontent.com downloads",
    "insert_image",
    "result.inserted_images",
    "original receipt without another block",
    "asset must already exist in",
    "MCP structured",
    "asset_url (also url for existing",
    "It does not insert content",
    "thread_ids",
    "not_found_thread_ids",
    "already_resolved",
    "No additional API key or public hosting",
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

test("guide documents account-safe onboarding and truthful listing metadata", () => {
  const prose = agentGuide(env).replace(/\s+/g, " ");
  for (const fact of [
    "Inspect filenames, not secrets, in ~/.config/pages",
    "Ask before reusing or replacing an existing key",
    "~/.config/pages/anaconda-api-key as the default",
    "~/.config/pages/anaconda-api-key-rgbkrk",
    "save command, Kilo file reference, and Codex helper",
    "separate Codex helper filename per account",
    "This refuses to overwrite an existing file",
    "Reload MCP or start a new session, then call list_pages from that session",
    "configuration alone is not verification",
    "quota.count counts active owned Pages, excluding shared Pages",
    "quota.trash_count counts your trashed Pages separately",
    "account-wide counts, not the number of results shown",
    "A null content_updated_at means no content edit time is recorded, including for new Pages and legacy Pages",
    "do not invent an edit timestamp from updated_at or created_at",
    "User Resources is an Anaconda account scope",
  ])
    assert.ok(prose.includes(fact), fact);
  assert.ok(agentGuide(env).includes(checkAccountCommand(origin)));
  for (const fact of [
    "GET " + origin + "/whoami",
    "email is included only when the provider supplies a verified email",
    "No credential expiry is reported",
    "A successful HTTP check is not MCP verification",
    "list_pages includes the same account object as /whoami",
    "Counts include pending creations and lifecycle reservations in the owned catalog slots",
  ])
    assert.ok(prose.includes(fact), fact);
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
