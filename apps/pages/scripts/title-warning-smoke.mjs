// One disposable Page through real HTTP and MCP. The default uses local OIDC.
// Live use is limited to Page10 and requires --allow-page10 plus an existing
// authorized PAGES_API_KEY_FILE. This script never starts servers or deploys.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parseEnv } from "node:util";
import { purgeTrashedFixture } from "./purge-fixture.mjs";
import { pageUrl } from "../shared/routes.mjs";

const origin = process.env.PAGES_ORIGIN ?? "http://localhost:9896";
const target = new URL(origin);
assert.equal(target.origin, origin, "PAGES_ORIGIN must be an origin without a trailing slash");
const local = target.hostname === "localhost" && target.protocol === "http:";
const page10 = origin === "https://page10.runtimed.run" && process.argv.includes("--allow-page10");
assert.ok(local || page10, "Only local OIDC or explicitly opted-in Page10 is supported");
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
    if (/token|key_prefix|nonce/i.test(key) && typeof entry === "string") secrets.add(entry);
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
/** A new nonce for one write. */
function retry() {
  return protect({
    nonce: crypto.randomUUID(),
  });
}
function warning(receipt, headingId) {
  assert.equal(receipt.warnings?.length, 1, "Expected one duplicate-title advisory");
  assert.equal(receipt.warnings[0].code, "opening_heading_repeats_title");
  assert.equal(typeof headingId, "string", "read_page's outline names the opening heading");
  assert.equal(
    receipt.warnings[0].node_id,
    headingId,
    "Advisory must identify the actual opening heading",
  );
}
function mutationReceipt(value, title) {
  // A result carries a navigable URL, with the title's slug when the result
  // has the title (`title`, for a create) and the bare link when it doesn't.
  // All persisted fields, especially warnings and heads, must match across
  // transports and retries.
  const { url, ...receipt } = value;
  if (url !== undefined) assert.equal(url, pageUrl(origin, { page_id: value.page_id, title }));
  return receipt;
}
const read = () => mcp("read_page", { page_id: pageId });
/** The opening heading's node_id, from read_page's outline. */
const openingHeading = async () =>
  (await mcp("read_page", { page_id: pageId, comments: "none" })).outline.entries.find(
    (entry) => entry.type === "heading",
  )?.node_id;

try {
  let authentication;
  if (local) authentication = await login();
  else {
    assert.ok(
      process.env.PAGES_API_KEY_FILE,
      "Page10 requires an existing authorized PAGES_API_KEY_FILE",
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
    ...retry(),
  };
  const created = await http("create_page", createArgs);
  assert.equal(typeof created.page_id, "string");
  pageId = created.page_id;
  report.fixture = pageId;
  const initial = await read();
  assert.equal(initial.title, fixtureTitle);
  assert.equal(initial.blocks.length, 1);
  assert.equal(initial.blocks[0].markdown, openingMarkdown);
  warning(created, await openingHeading());
  assert.deepEqual(initial.revision, created.revision);
  complete(stage);

  stage = "exact create retry through MCP returns the original receipt";
  const recreated = await mcp("create_page", createArgs);
  // The retry links the Page exactly as the first receipt did: the title's
  // slug after the id.
  assert.equal(created.url, pageUrl(origin, { page_id: pageId, title: fixtureTitle }));
  assert.equal(recreated.url, created.url);
  assert.deepEqual(
    mutationReceipt(recreated, fixtureTitle),
    mutationReceipt(created, fixtureTitle),
  );
  complete(stage);

  stage = "an introduction and distinct heading need no warning";
  const edit = {
    page_id: pageId,
    revision: initial.revision,
    ...retry(),
    operations: [
      { op: "replace_block_markdown", node_id: initial.blocks[0].node_id, markdown: introduction },
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
    revision: current.revision,
    ...retry(),
    operations: [{ op: "insert_markdown", after_node_id: null, markdown: `# ${fixtureTitle}` }],
  };
  const inserted = await mcp("edit_page", insertArgs);
  const withTitle = await read();
  assert.notEqual(withTitle.blocks[0].node_id, initial.blocks[0].node_id);
  assert.equal(withTitle.blocks[0].markdown, `# ${fixtureTitle}`);
  const titleHeading = await openingHeading();
  warning(inserted, titleHeading);
  complete(stage);

  stage = "an exact edit retry preserves its warning and heads after an unrelated patch";
  const patched = await http("edit_page", {
    page_id: pageId,
    revision: withTitle.revision,
    ...retry(),
    operations: [
      {
        op: "replace_match",
        node_id: initial.blocks[0].node_id,
        match_text: "Keep this text unchanged.",
        replacement: "Preserve this text unchanged.",
      },
    ],
  });
  warning(patched, titleHeading);
  assert.notDeepEqual(patched.revision, inserted.revision);
  assert.deepEqual(mutationReceipt(await http("edit_page", insertArgs)), mutationReceipt(inserted));
  const final = await read();
  assert.deepEqual(final.revision, patched.revision);
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
      await mcp("delete_page", { page_id: pageId, revision: current.revision, ...retry() });
      await purgeTrashedFixture(mcp, pageId, async () => retry());
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
