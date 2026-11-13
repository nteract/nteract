import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../worker/index.mjs";
import { agentGuide, guideUploadCommand } from "../agent-guide.mjs";
import { issueAssetUpload } from "../worker/asset-uploads.mjs";
import { MCP_ERROR_CODES, tools } from "../mcp.mjs";
import { CLIENT_ERROR_CODES, RETRYABLE_SERVER_CODES } from "../worker/auth.mjs";
import { MOVE_STATUS } from "../worker/move-page.mjs";
import { HOST_REFUSAL_CODES } from "../worker/host-busy.mjs";
import { STATUS_FALLBACK_CODES } from "../worker/project-api.mjs";
import { READ_ERROR_CODES } from "../worker/tool-reads.mjs";
import { CHANGE_ERROR_CODES } from "../worker/tool-changes.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";
import {
  checkAccountCommand,
  claudeCodeAddCommand,
  claudeCodeHeaderHelper,
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

const origin = "https://page10.runtimed.run";
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
    ...HOST_REFUSAL_CODES,
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
  assert.ok(guide.includes(claudeCodeHeaderHelper));
  assert.ok(guide.includes(claudeCodeAddCommand(origin)));
  assert.ok(
    guide.indexOf("### Codex Desktop / CLI") <
      guide.indexOf("### Claude Code (local HTTP connection)"),
  );
  assert.ok(
    guide.indexOf("### Claude Code (local HTTP connection)") <
      guide.indexOf("### Other MCP clients (API key)"),
  );
  // API keys lead; OAuth follows for interactive clients, with its lifecycle
  // and how processes share one connection.
  assert.ok(
    guide.indexOf("### Kilo Desktop / CLI (API key, recommended)") <
      guide.indexOf("### ChatGPT / cloud connection (OAuth)"),
  );
  assert.ok(
    guide.indexOf("### ChatGPT / cloud connection (OAuth)") <
      guide.indexOf("### Kilo Desktop / CLI (OAuth)"),
  );
  const prose = guide.replace(/\s+/g, " ");
  for (const fact of [
    "access tokens expire after 10 minutes",
    "each one is replaced on use",
    "can be used again for 30 seconds after its first use",
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
    "save command, Kilo file reference, and the Codex and Claude Code helpers",
    "separate helper filename per account",
    "This refuses to overwrite an existing file",
    "Reload MCP or start a new session, then call list_pages from that session",
    "configuration alone is not verification",
    "Do not use claude mcp add --header",
    "writes the key into ~/.claude.json",
    'claude mcp get pages reports "Needs authentication"',
    "does not fall back to OAuth for this server",
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

test("guide teaches project_id content addressing and document_id with no home concept", () => {
  const guide = agentGuide(env);
  const prose = guide.replace(/\s+/g, " ");
  assert.match(prose, /A Project has editable content and a hierarchy of Pages/);
  assert.match(
    prose,
    /call read_page with project_id instead of page_id, and edit it with edit_page or patch_page the same way/,
  );
  assert.match(prose, /page_id is the content document's ID \(document_id on get_project\)/);
  assert.match(
    prose,
    /Returns project_id, title, description, revision, role \(owner, editor, commenter or viewer\), owner, url and document_id/,
  );
  assert.match(prose, /takes project_id in its place to address a Project's content/);
  assert.match(prose, /give one, never both \(invalid_arguments\)/);
  assert.match(prose, /kind "project", project_id and the content's page_id/);
  assert.match(prose, /it has project_id and parent_id null/);
  assert.match(prose, /content document is not a Page and is never listed/);
  assert.match(prose, /direct access never reveals the Project/);
  assert.match(
    prose,
    /update_project changes catalog metadata, not the content document's title or body/,
  );
  assert.match(
    prose,
    /move_page, delete_page and purge_page refuse it with project_content_protected/,
  );
  assert.match(prose, /A direct Page grant applies only to that Page, never its descendants/);
  // The quick start shows the project_id form of read_page as valid JSON.
  assert.ok(guide.includes('{"operation":"read_page","arguments":{"project_id":"<project_id'));
  // No home field, flag, URL, code or wording survives; only the user's home
  // directory in client setup snippets.
  const unrelated = /XDG_CONFIG_HOME|CODEX_HOME|Path\.home\(\)/g;
  assert.doesNotMatch(guide.replace(unrelated, ""), /home/i);
  assert.doesNotMatch(prose, /backing|Project is a container/);
});

test("guide distinguishes whole Project sharing from direct Page grants and editing consent", () => {
  const prose = agentGuide(env).replace(/\s+/g, " ");
  assert.match(prose, /All four access tools require separately approved pages:share for OAuth/);
  assert.match(prose, /Editing consent alone never authorizes sharing/);
  assert.match(
    prose,
    /Project membership covers the Project's content and its Pages at every depth/,
  );
  assert.match(prose, /removing Project membership does not remove a direct Page grant/);
  assert.match(prose, /email is the sharing entry point/);
  assert.match(prose, /No outbound email is sent or required/);
  assert.match(prose, /Do not search an email directory or look up a principal ID/);
  assert.match(prose, /claim requires the recipient's verified email/);
  assert.match(prose, /Claim occurs on an authenticated get_project or list_projects call/);
  assert.match(prose, /not asynchronously on sign-in/);
  assert.match(
    prose,
    /A \/p\/\.\.\. link to the content document does not claim a Project invitation/,
  );
  assert.match(
    prose,
    /Without project_id, list_pages is not a complete inventory of inherited access/,
  );
  assert.match(prose, /removed members and internal signing generations are omitted/);
  assert.match(prose, /Invites contain id, email, role and expiresAt \(epoch milliseconds\)/);
  assert.match(prose, /an old receipt is not a fresh roster/);
  assert.match(prose, /Project company-domain sharing is not supported/);
  assert.match(prose, /up to 15 seconds after revocation/);
  assert.match(prose, /Sharing tools do not issue retry_token authority/);
  assert.doesNotMatch(
    prose,
    /Projects are owner-only|Only a Project's owner can open it|move changes no one's access/,
  );
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
    agentGuide({
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://localhost:9894",
    }).includes("http://localhost:9894/mcp"),
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

/** The guide's Images section, up to the next top-level section. */
function imagesSection() {
  const guide = agentGuide(env);
  const start = guide.indexOf("\n## Images\n");
  assert.notEqual(start, -1);
  return guide.slice(start, guide.indexOf("\n## ", start + 1));
}

test("the Images section teaches which path to use and the end-to-end workflow", () => {
  const images = imagesSection();
  const paths = images.slice(
    images.indexOf("### Which path to use"),
    images.indexOf("### Add images"),
  );
  for (const fact of [
    /^- ChatGPT, with an attached or generated file: import_page_image\.$/m,
    /^- Any agent with a shell or HTTP client, signed in with an API key or OAuth$/m,
    /call create_page_asset_upload,\s+then send the file to the upload_url it returns with curl/,
    /^- An API-key script may also POST the file directly to$/m,
    /^- No shell and no file parameters .*: ask the person to$/m,
    /use Insert image in the browser/,
  ])
    assert.match(paths, fact);
  for (const fact of [
    /Authorization: Pages-Upload <token>/,
    /pages:write for OAuth, cloud:write for an API key/,
    /about 960\s+CSS pixels on a desktop and about 350 on a phone/,
    /a 2x screenshot shows at twice its design size/,
    /if your access is removed before you\s+upload, the upload is refused/,
    /Revoking an API key doesn't end the URLs\s+it already issued; they stop at expires_at/,
    /dark_asset_id; that marks the Page with the\s+image-theme-variants schema feature/,
    /replace_block_markdown on the Page's only block \(a new Page from\s+create_page has one\), or its last block/,
    /give every operation\s+that block's ID as after_block_id and list them in reverse order/,
    /summary\.images/,
    /pass outline\.next_offset\s+as outline_offset, with that read's heads as expected_heads/,
    /"block_id": "<last block's id>"/,
  ])
    assert.match(images, fact);
  assert.doesNotMatch(images, /first block's id/);
});

test("the guide's curl line and create_page_asset_upload's example send the same headers", async () => {
  const pageId = crypto.randomUUID();
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => void values.set(key, value),
    sync: async () => {},
  };
  const issued = await issueAssetUpload(storage, {
    pageId,
    identity: { principal: "user:anaconda:guide", credentialKind: "api-key" },
    args: { page_id: pageId, content_type: "image/png" },
    origin,
  });
  const token = issued.headers.Authorization.replace(/^Pages-Upload /, "");
  // The tool's example, with the guide's placeholders put back.
  const example = issued.example
    .replace(token, "<token>")
    .replace(pageId, "<page_id>")
    .replace("@path/to/file.png", "@mockup.png");
  assert.equal(example, guideUploadCommand(origin));
  assert.ok(agentGuide(env).includes(guideUploadCommand(origin)));
  // Every -H value is a whole header: curl drops one without a colon.
  for (const [, value] of example.matchAll(/-H '([^']*)'/g)) assert.match(value, /^[A-Za-z-]+: \S/);
  assert.match(example, /-H 'Authorization: Pages-Upload <token>'/);
});
