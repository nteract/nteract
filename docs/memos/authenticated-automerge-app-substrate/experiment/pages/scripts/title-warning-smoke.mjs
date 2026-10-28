// One disposable Page through real HTTP and MCP. The default uses local OIDC.
// Live use is limited to Page8 and requires --allow-page8 plus an existing
// authorized PAGES_API_KEY_FILE. This script never starts servers or deploys.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parseEnv } from "node:util";

const origin = process.env.PAGES_ORIGIN ?? "http://localhost:9896";
const target = new URL(origin);
assert.equal(target.origin, origin, "PAGES_ORIGIN must be an origin without a trailing slash");
const local = target.hostname === "localhost" && target.protocol === "http:";
const page8 = origin === "https://page8.runtimed.run" && process.argv.includes("--allow-page8");
assert.ok(local || page8, "Only local OIDC or explicitly opted-in Page8 is supported");
const secrets = new Set();
const report = { origin, completed: [], cleanedUp: false };
const started = performance.now();
let requestCount = 0;
const fixtureTitle = "Title warning QA " + crypto.randomUUID();
const openingMarkdown = `# ${fixtureTitle}\n\nThis body must survive the advisory unchanged.`;
const introduction =
  "A short introduction for this QA run.\n\n## Details\n\nKeep this text unchanged.";
let headers,
  pageId,
  createArgs,
  stage = "authentication";
function protect(value) {
  if (!value || typeof value !== "object") return value;
  for (const [key, entry] of Object.entries(value)) {
    if (/token|key_prefix|idempotency_key/i.test(key) && typeof entry === "string")
      secrets.add(entry);
    else if (entry && typeof entry === "object") protect(entry);
  }
  return value;
}
const redact = (value) =>
  [...secrets].reduce(
    (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
    String(value),
  );
function complete(name) {
  report.completed.push(name);
  console.log("PASS " + name);
}
function request(path, options = {}) {
  const remaining = Math.floor(240000 - (performance.now() - started));
  assert.ok(remaining > 0, "Smoke run exceeded its four-minute budget");
  assert.ok(requestCount < 60, "Smoke run exceeded its 60-request budget");
  requestCount++;
  return fetch(origin + path, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(Math.min(15000, remaining)),
  });
}
async function existingApiKey(path) {
  const before = await lstat(path);
  assert.ok(
    before.isFile() && !before.isSymbolicLink(),
    "API key file must be a regular nonsymlink file",
  );
  assert.equal(before.uid, process.getuid(), "API key file must belong to the current user");
  assert.equal(before.mode & 0o077, 0, "API key file must be readable only by its owner");
  assert.ok(before.size <= 65536, "API key file exceeds the bounded fixture size");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const after = await file.stat();
    assert.ok(
      after.isFile() &&
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.uid === before.uid &&
        (after.mode & 0o077) === 0 &&
        after.size <= 65536,
      "API key file changed while it was being opened",
    );
    source = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  const key = /^\s*(?:export\s+)?ANACONDA_API_KEY\s*=/m.test(source)
    ? parseEnv(source).ANACONDA_API_KEY?.trim()
    : source.trim();
  assert.ok(
    key && !/[\r\n]/.test(key),
    "API key file must contain a raw key or ANACONDA_API_KEY dotenv entry",
  );
  return key;
}
async function login() {
  const cookies = new Map();
  let next = new URL("/api/auth/login", origin);
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal(next.origin, origin, "Local OIDC must stay on this origin");
    const response = await request(next.pathname + next.search, {
      headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0],
        at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
      secrets.add(pair.slice(at + 1));
    }
    const location = response.headers.get("location");
    if (!location) {
      assert.equal(response.status, 200, "Local OIDC did not finish successfully");
      await response.body?.cancel();
      const cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      secrets.add(cookie);
      return { Cookie: cookie };
    }
    await response.body?.cancel();
    next = new URL(location, next);
  }
  throw Error("Local OIDC exceeded its redirect bound");
}
async function httpRaw(operation, args = {}) {
  protect(args);
  const response = await request("/api/tools", {
    method: "POST",
    headers,
    body: JSON.stringify({ operation, arguments: args }),
  });
  return { status: response.status, body: protect(await response.json()) };
}
async function http(operation, args = {}) {
  const { status, body } = await httpRaw(operation, args);
  if (status !== 200) throw Error(`${operation}: HTTP ${status} (${body.code ?? "unspecified"})`);
  return body;
}
async function mcp(name, args = {}) {
  protect(args);
  const response = await request("/mcp", {
    method: "POST",
    headers: { ...headers, Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw Error(`${name}: MCP HTTP ${response.status}`);
  const envelope = protect(await response.json());
  if (envelope.error) throw Error(`${name}: JSON-RPC error ${envelope.error.code}`);
  const result = envelope.result;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP response must contain JSON text");
  const body = protect(JSON.parse(text));
  if (result.isError) throw Error(`${name}: MCP tool error ${body.code ?? "unspecified"}`);
  if (result.structuredContent) assert.deepEqual(result.structuredContent, body);
  return body;
}
function retry(authority) {
  assert.equal(typeof authority.retry_token, "string", "Fresh retry authority is required");
  assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
  return protect({
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
}
function warning(receipt, blockId) {
  assert.equal(receipt.warnings?.length, 1, "Expected one duplicate-title advisory");
  assert.equal(receipt.warnings[0].code, "opening_heading_repeats_title");
  assert.equal(
    receipt.warnings[0].block_id,
    blockId,
    "Advisory must identify the actual opening block",
  );
}
function mutationReceipt(value) {
  // MCP decorates the stored receipt with a navigable URL; HTTP returns the
  // receipt directly. All persisted fields, especially warnings and heads,
  // must match across transports and retries.
  const { url, ...receipt } = value;
  if (url !== undefined) assert.equal(url, `${origin}/p/${value.page_id}`);
  return receipt;
}
const read = () => mcp("read_page", { page_id: pageId });

try {
  let authentication;
  if (local) authentication = await login();
  else {
    assert.ok(
      process.env.PAGES_API_KEY_FILE,
      "Page8 requires an existing authorized PAGES_API_KEY_FILE",
    );
    const key = await existingApiKey(process.env.PAGES_API_KEY_FILE);
    secrets.add(key);
    authentication = { Authorization: `Bearer ${key}` };
  }
  headers = {
    ...authentication,
    Origin: origin,
    "Content-Type": "application/json",
    "X-Pages-Driver": "Title warning QA",
  };

  stage = "HTTP create warns without changing the supplied body";
  createArgs = {
    title: fixtureTitle,
    markdown: openingMarkdown,
    ...retry(await mcp("list_pages")),
  };
  const created = await http("create_page", createArgs);
  assert.equal(typeof created.page_id, "string");
  pageId = created.page_id;
  report.fixture = pageId;
  const initial = await read();
  assert.equal(initial.title, fixtureTitle);
  assert.equal(initial.blocks.length, 1);
  assert.equal(initial.blocks[0].markdown, openingMarkdown);
  warning(created, initial.blocks[0].id);
  assert.deepEqual(initial.heads, created.heads);
  complete(stage);

  stage = "exact create retry through MCP returns the original receipt";
  assert.deepEqual(mutationReceipt(await mcp("create_page", createArgs)), mutationReceipt(created));
  complete(stage);

  stage = "an introduction and distinct heading need no warning";
  const edit = {
    page_id: pageId,
    base_heads: initial.heads,
    ...retry(initial),
    operations: [
      { op: "replace_block_markdown", block_id: initial.blocks[0].id, markdown: introduction },
    ],
  };
  const edited = await mcp("edit_page", edit);
  assert.equal(edited.warnings?.length ?? 0, 0);
  const withoutTitle = await http("read_page", { page_id: pageId });
  assert.equal(withoutTitle.blocks[0].markdown, introduction);
  complete(stage);

  stage = "create retry retains its warning after a later correction";
  assert.deepEqual(await http("create_page", createArgs), created);
  assert.equal(
    (await read()).blocks[0].markdown,
    introduction,
    "Retry must not restore the old body",
  );
  complete(stage);

  stage = "inserting a duplicate heading reports its new opening block";
  const current = await read();
  const insertArgs = {
    page_id: pageId,
    base_heads: current.heads,
    ...retry(current),
    operations: [{ op: "insert_markdown", after_block_id: null, markdown: `# ${fixtureTitle}` }],
  };
  const inserted = await mcp("edit_page", insertArgs);
  const withTitle = await read();
  assert.notEqual(withTitle.blocks[0].id, initial.blocks[0].id);
  assert.equal(withTitle.blocks[0].markdown, `# ${fixtureTitle}`);
  warning(inserted, withTitle.blocks[0].id);
  complete(stage);

  stage = "an exact edit retry preserves its warning and heads after an unrelated patch";
  const patched = await http("patch_page", {
    page_id: pageId,
    base_heads: withTitle.heads,
    ...retry(withTitle),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: initial.blocks[0].id,
        replacements: [{ old: "Keep this text unchanged.", new: "Preserve this text unchanged." }],
      },
    ],
  });
  warning(patched, withTitle.blocks[0].id);
  assert.notDeepEqual(patched.heads, inserted.heads);
  assert.deepEqual(mutationReceipt(await http("edit_page", insertArgs)), mutationReceipt(inserted));
  const final = await read();
  assert.deepEqual(final.heads, patched.heads);
  assert.equal(final.blocks.length, 2, "Exact retry must not insert another heading");
  assert.equal(final.blocks[1].markdown, introduction.replace("Keep", "Preserve"));
  complete(stage);
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = redact(error.message);
  console.error("FAIL " + stage + ": " + report.failure);
  process.exitCode = 1;
} finally {
  // An ambiguous create response is recovered only with its exact request. Never
  // infer ownership from a catalog title, and never delete an unrelated Page.
  try {
    if (headers && createArgs && !pageId) pageId = (await mcp("create_page", createArgs)).page_id;
    if (pageId) {
      const current = await read();
      assert.equal(current.title, fixtureTitle, "Only this run's owned fixture may be deleted");
      const catalog = await mcp("list_pages");
      await mcp("delete_page", { page_id: pageId, base_heads: current.heads, ...retry(catalog) });
      assert.equal((await httpRaw("read_page", { page_id: pageId })).status, 404);
      assert.equal(
        (await mcp("list_pages")).pages.some((page) => page.page_id === pageId),
        false,
      );
      report.cleanedUp = true;
    }
  } catch (error) {
    report.result = "fail";
    report.cleanupFailure = redact(error.message);
    process.exitCode = 1;
  }
  report.requests = requestCount;
  report.elapsedMs = Math.round(performance.now() - started);
  console.log(redact(JSON.stringify(report)));
}
