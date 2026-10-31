// Real local OIDC + OAuth + MCP + celld/R2 + browser image qualification.
// Only the external file download is synthetic: the test Worker forwards it to
// a loopback image source this smoke owns, which counts every download.
// This does not establish that ChatGPT forwards generated-image artifacts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startImageSource } from "./fixtures/local-mcp-image-source.mjs";
import { imageDownloadUrl, imageFileId, imagePng } from "./fixtures/local-mcp-images.mjs";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS;
await mkdir(output, { recursive: true });
const keys = JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"));
const endpoint = origin + "/mcp";
const callback = origin + "/oauth/test/callback";
const fullScope = "pages:read pages:write";
const clients = new Set();
const report = {
  completed: [],
  errors: [],
  fileHandoff:
    "Synthetic file descriptor; actual ChatGPT upload/generated-image handoff remains unverified",
};
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
let owner, pageId, asset;
const fixtures = [];
const complete = (name) => {
  report.completed.push(name);
  console.log(`[MCP images E2E] ${name}`);
};
const localFetch = (input, options = {}) => {
  assert.equal(new URL(input instanceof Request ? input.url : input).origin, origin);
  return fetch(input, {
    ...options,
    redirect: "manual",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
};
const retry = (value) => ({
  retry_token: value.retry_token,
  idempotency_key: value.retry_key_prefix + crypto.randomUUID(),
});
async function sessionApi(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const sessionTool = (name, args = {}) =>
  sessionApi(owner, "/api/tools", { operation: name, arguments: args });
async function call(client, name, args = {}, allowed = true) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  assert.equal(result.isError === true, !allowed, `${name}: ${JSON.stringify(result)}`);
  const value = JSON.parse(result.content[0].text);
  if (allowed) assert.deepEqual(result.structuredContent, value);
  return value;
}
// Each step gets its own download URL whose token names the source behavior,
// so no step depends on state another request left behind.
assert.match(process.env.PAGES_E2E_FIXTURE_ID ?? "", /^[0-9a-f]{32}$/, "run through the harness");
const source = await startImageSource({
  identity: process.env.PAGES_E2E_FIXTURE_ID,
  port: Number(process.env.PAGES_E2E_IMAGE_SOURCE_PORT),
});
const imageFile = (behavior = "ok") => {
  const download_url = imageDownloadUrl(behavior);
  return {
    token: new URL(download_url).searchParams.get("token"),
    file: { download_url, file_id: imageFileId, mime_type: "image/png", file_name: "tiny.png" },
  };
};
const importImage = (client, image, allowed = true) =>
  call(client, "import_page_image", { page_id: pageId, file: image.file }, allowed);
// A refused import must not reach the image source at all.
async function refusedImport(client) {
  const image = imageFile(),
    before = source.total();
  const refusal = await importImage(client, image, false);
  assert.equal(source.downloads(image.token), 0, "refused import does not download");
  assert.equal(source.total(), before, "refused import does not download");
  return refusal;
}

async function signIn(email) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  const network = await context.newCDPSession(page);
  network.on("Fetch.requestPaused", async ({ requestId, request }) => {
    try {
      const url = new URL(request.url);
      if (url.origin + url.pathname === callback) {
        await network.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          body: Buffer.from("<h1>Local OAuth callback</h1>").toString("base64"),
        });
      } else if (url.origin === origin) {
        // A page that navigates or closes drops its paused requests, such as
        // the viewer's /health check on a visibility change. Releasing one
        // then fails with "Invalid InterceptionId"; it never left the browser.
        await network.send("Fetch.continueRequest", { requestId }).catch((error) => {
          if (!/Invalid InterceptionId/.test(error.message)) throw error;
        });
      } else {
        report.errors.push("Browser attempted external network");
        await network.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      }
    } catch (error) {
      report.errors.push(`Browser interception failed: ${error.name}`);
      await network
        .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        .catch(() => {});
    }
  });
  await network.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  const begin = await context.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const url = new URL(begin.headers().location);
  url.searchParams.set("login_hint", email);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 30000,
  });
  return page;
}
async function grant(page, scope) {
  const data = { state: crypto.randomUUID() };
  const provider = {
    data,
    redirectUrl: callback,
    clientMetadata: {
      client_name: "Pages image import qualification",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    },
    state: () => data.state,
    clientInformation: () => ({ client_id: "pages-local-e2e", token_endpoint_auth_method: "none" }),
    tokens: () => data.tokens,
    saveTokens: (value) => {
      data.tokens = value;
    },
    saveCodeVerifier: (value) => {
      data.verifier = value;
    },
    codeVerifier: () => data.verifier,
    redirectToAuthorization: (value) => {
      data.authorization = value;
    },
    saveDiscoveryState: (value) => {
      data.discovery = value;
    },
    discoveryState: () => data.discovery,
  };
  assert.equal(
    await auth(provider, { serverUrl: endpoint, scope, fetchFn: localFetch }),
    "REDIRECT",
  );
  assert.equal(data.authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(data.authorization.searchParams.get("resource"), endpoint);
  await page.goto(data.authorization.href, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Connect Local test client to Pages" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await page.waitForURL((url) => url.origin + url.pathname === callback, {
    waitUntil: "domcontentloaded",
  });
  const returned = new URL(page.url());
  assert.equal(returned.searchParams.get("state"), data.state);
  assert.equal(returned.searchParams.get("iss"), origin);
  assert.equal(
    await auth(provider, {
      serverUrl: endpoint,
      authorizationCode: returned.searchParams.get("code"),
      fetchFn: localFetch,
    }),
    "AUTHORIZED",
  );
  const client = new Client({ name: "Pages MCP image test", version: "1" });
  clients.add(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      authProvider: provider,
      fetch: localFetch,
      requestInit: { headers: { "X-Pages-Driver": "Image import qualification" } },
    }),
    { timeout: 30000 },
  );
  return { client, provider };
}
async function access(action) {
  const current = await sessionApi(owner, `/api/access?page=${pageId}`);
  assert.equal(current.status, 200);
  const updated = await sessionApi(owner, `/api/access?page=${pageId}`, {
    ...action,
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
}

try {
  const networkProbe = await browser.newPage();
  try {
    await assert.rejects(
      networkProbe.goto("https://example.com/image-fixture-network-check", { timeout: 5000 }),
      /net::ERR_NAME_NOT_RESOLVED/,
    );
  } finally {
    await networkProbe.close();
  }
  // The Worker under test must be this run's fixture build. Downloads from any
  // other build are refused by the image source and reported below.
  const fixture = await (await localFetch(origin + "/__e2e/image-source")).json();
  assert.equal(fixture.fixture, process.env.PAGES_E2E_FIXTURE_ID, "fixture identity");
  owner = await signIn("dev@localhost");
  const ownerGrant = await grant(owner, fullScope);
  const catalog = await call(ownerGrant.client, "list_pages");
  const created = await call(ownerGrant.client, "create_page", {
    title: "MCP private image handoff",
    markdown: "A private image imported through MCP.",
    ...retry(catalog),
  });
  pageId = created.page_id;
  fixtures.push(pageId);
  const descriptors = await ownerGrant.client.listTools();
  const descriptor = descriptors.tools.find((tool) => tool.name === "import_page_image");
  assert.ok(descriptor);
  assert.deepEqual(descriptor._meta["openai/fileParams"], ["file"]);
  complete("Local OIDC, PKCE consent and MCP expose the file-input tool");

  const first = imageFile();
  asset = await importImage(ownerGrant.client, first);
  assert.equal(asset.page_id, pageId);
  assert.equal(asset.asset_id, createHash("sha256").update(imagePng()).digest("hex"));
  assert.equal(asset.asset_url, `/api/pages/${pageId}/assets/${asset.asset_id}`);
  assert.equal(asset.url, origin + `/p/${pageId}`);
  assert.equal(asset.mime_type, "image/png");
  assert.equal(asset.size, imagePng().length);
  assert.equal(asset.width, 3);
  assert.equal(asset.height, 2);
  assert.equal(JSON.stringify(asset).includes("oaiusercontent"), false);
  assert.equal(JSON.stringify(asset).includes(imageFileId), false);
  assert.deepEqual(await importImage(ownerGrant.client, first), asset);
  assert.equal(source.downloads(first.token), 2, "each import downloads its file once");

  const uploaded = await localFetch(origin + `/api/pages/${pageId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": "image/png" },
    body: imagePng(),
  });
  assert.equal(uploaded.status, 200);
  const byteAsset = await uploaded.json();
  for (const field of ["asset_id", "asset_url", "mime_type", "size", "width", "height"])
    assert.deepEqual(byteAsset[field], asset[field], field);
  assert.equal(byteAsset.url, asset.asset_url);
  complete("ChatGPT file handoff and API-key byte upload resolve to the same private asset");

  const read = await call(ownerGrant.client, "read_page", { page_id: pageId });
  const insertion = {
    page_id: pageId,
    base_heads: read.heads,
    ...retry(read),
    operations: [
      {
        op: "insert_image",
        asset_id: asset.asset_id,
        alt: "Imported private image",
        after_block_id: read.blocks[0].id,
      },
    ],
  };
  const inserted = await call(ownerGrant.client, "edit_page", insertion);
  assert.equal(inserted.url, origin + `/p/${pageId}`);
  assert.equal(inserted.result.inserted_images.length, 1);
  const insertedImage = inserted.result.inserted_images[0];
  assert.deepEqual(insertedImage, {
    block_id: insertedImage.block_id,
    asset_id: asset.asset_id,
    asset_url: asset.asset_url,
    alt: "Imported private image",
  });
  assert.equal(typeof insertedImage.block_id, "string");
  assert.notDeepEqual(inserted.heads, read.heads);
  assert.deepEqual(await call(ownerGrant.client, "edit_page", insertion), inserted);
  const after = await call(ownerGrant.client, "read_page", { page_id: pageId });
  assert.equal(after.blocks.length, read.blocks.length + 1);
  assert.equal(after.blocks[1].id, insertedImage.block_id);
  assert.equal(after.blocks[1].markdown, `![Imported private image](${asset.asset_url})`);
  assert.deepEqual(after.heads, inserted.heads);
  assert.equal(JSON.stringify(after).includes("oaiusercontent"), false);
  assert.equal(JSON.stringify(after).includes(imageFileId), false);
  assert.equal(JSON.stringify(after).includes("base64"), false);
  complete(
    "Guarded insert_image returns the actual block and revision; exact retry does not duplicate it",
  );

  const missing = {
    page_id: pageId,
    base_heads: after.heads,
    ...retry(after),
    operations: [{ op: "insert_image", asset_id: "0".repeat(64), alt: "Missing asset" }],
  };
  await call(ownerGrant.client, "edit_page", missing, false);
  assert.deepEqual(
    (await call(ownerGrant.client, "read_page", { page_id: pageId })).heads,
    after.heads,
  );
  const otherCatalog = await call(ownerGrant.client, "list_pages");
  const otherPage = await call(ownerGrant.client, "create_page", {
    title: "Separate image namespace",
    markdown: "The first Page's asset must not be accessible here.",
    ...retry(otherCatalog),
  });
  fixtures.push(otherPage.page_id);
  const otherRead = await call(ownerGrant.client, "read_page", { page_id: otherPage.page_id });
  await call(
    ownerGrant.client,
    "edit_page",
    {
      page_id: otherPage.page_id,
      base_heads: otherRead.heads,
      ...retry(otherRead),
      operations: [{ op: "insert_image", asset_id: asset.asset_id, alt: "Wrong Page" }],
    },
    false,
  );
  assert.deepEqual(
    (await call(ownerGrant.client, "read_page", { page_id: otherPage.page_id })).heads,
    otherRead.heads,
  );
  complete("Missing and cross-Page assets reject insertion without changing the document");

  const authenticated = await owner.context().request.get(origin + asset.asset_url);
  assert.equal(authenticated.status(), 200);
  assert.deepEqual(await authenticated.body(), Buffer.from(imagePng()));
  assert.match(authenticated.headers()["cache-control"], /private/);
  assert.equal((await localFetch(origin + asset.asset_url)).status, 401);
  for (const [method, path] of [
    ["GET", asset.asset_url],
    ["POST", `/api/pages/${pageId}/assets`],
  ]) {
    const response = await localFetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${ownerGrant.provider.data.tokens.access_token}`,
        "Content-Type": "image/png",
      },
      ...(method === "POST" ? { body: imagePng() } : {}),
    });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  }
  await owner.goto(origin + `/p/${pageId}`, { waitUntil: "domcontentloaded" });
  await expect(owner.locator("wg-content img").filter({ visible: true })).toHaveCount(1, {
    timeout: 30000,
  });
  await expect
    .poll(() =>
      owner
        .locator("wg-content img")
        .evaluate((image) => image.complete && image.naturalWidth === 3),
    )
    .toBe(true);
  await owner.screenshot({ path: `${output}/mcp-imported-image.png`, fullPage: true });
  complete(
    "Authenticated browser renders imported bytes; anonymous reads and raw MCP-token asset access are denied",
  );

  const readGrant = await grant(owner, "pages:read");
  const deniedScope = await refusedImport(readGrant.client);
  assert.equal(deniedScope.code, "oauth_insufficient_scope");
  const scopeRead = await call(readGrant.client, "read_page", { page_id: pageId });
  const deniedInsert = await call(
    readGrant.client,
    "edit_page",
    {
      page_id: pageId,
      base_heads: scopeRead.heads,
      ...retry(scopeRead),
      operations: [{ op: "insert_image", asset_id: asset.asset_id, alt: "Read-only grant" }],
    },
    false,
  );
  assert.equal(deniedInsert.code, "oauth_insufficient_scope");
  const editor = await signIn("alice@localhost");
  const identity = (await sessionApi(editor, "/api/auth/session")).body.identity;
  const editorGrant = await grant(editor, fullScope);
  await access({ action: "invite", email: "alice@localhost", role: "editor" });
  const editorImage = imageFile();
  assert.deepEqual(await importImage(editorGrant.client, editorImage), asset);
  assert.equal(source.downloads(editorImage.token), 1);
  const editorRead = await call(editorGrant.client, "read_page", { page_id: pageId });
  const pendingEditorInsert = {
    page_id: pageId,
    base_heads: editorRead.heads,
    ...retry(editorRead),
    operations: [{ op: "insert_image", asset_id: asset.asset_id, alt: "Revoked editor" }],
  };
  assert.equal((await editor.context().request.get(origin + asset.asset_url)).status(), 200);
  await access({ action: "set_role", principal: identity.principal, role: "viewer" });
  const deniedAcl = await refusedImport(editorGrant.client);
  assert.notEqual(deniedAcl.code, "oauth_insufficient_scope");
  await call(editorGrant.client, "edit_page", pendingEditorInsert, false);
  assert.equal((await editor.context().request.get(origin + asset.asset_url)).status(), 200);
  await access({ action: "set_role", principal: identity.principal, role: null });
  await refusedImport(editorGrant.client);
  await call(editorGrant.client, "edit_page", pendingEditorInsert, false);
  assert.equal((await editor.context().request.get(origin + asset.asset_url)).status(), 403);
  complete(
    "Read-only OAuth, Page downgrade and revocation deny import and insertion; image reads follow current access",
  );

  const revoked = await localFetch(origin + "/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "pages-local-e2e",
      token: ownerGrant.provider.data.tokens.access_token,
    }),
  });
  assert.equal(revoked.status, 200);
  const revokedImage = imageFile(),
    beforeRevoked = source.total();
  const revokedRequest = await localFetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerGrant.provider.data.tokens.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "import_page_image",
        arguments: { page_id: pageId, file: revokedImage.file },
      },
    }),
  });
  assert.equal(revokedRequest.status, 401);
  await revokedRequest.body?.cancel();
  assert.equal(source.downloads(revokedImage.token), 0);
  assert.equal(source.total(), beforeRevoked);
  complete("Revoked OAuth grant cannot import or trigger a file download");

  const freshOwnerGrant = await grant(owner, fullScope);
  const expiredImage = imageFile("expired");
  await importImage(freshOwnerGrant.client, expiredImage, false);
  assert.equal(source.downloads(expiredImage.token), 1, "expired link is tried once");
  const expiredCount = source.total();
  await owner.goto(origin + `/p/${pageId}`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(() =>
      owner
        .locator("wg-content img")
        .evaluate((image) => image.complete && image.naturalWidth === 3),
    )
    .toBe(true);
  const stored = await owner.context().request.get(origin + asset.asset_url);
  assert.equal(stored.status(), 200);
  assert.deepEqual(await stored.body(), Buffer.from(imagePng()));
  assert.equal(source.total(), expiredCount, "reload and retry do not download");
  assert.deepEqual(await call(freshOwnerGrant.client, "edit_page", insertion), inserted);
  complete(
    "Stored image and exact insertion retry survive source-link expiry and reload without redownloading",
  );
  assert.deepEqual(source.errors, [], "image source saw only this fixture's downloads");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || error.message;
  await owner?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  report.cleaned = true;
  for (const fixtureId of fixtures.reverse()) {
    try {
      const read = (await sessionTool("read_page", { page_id: fixtureId })).body;
      const catalog = (await sessionTool("list_pages")).body;
      const deleted = await sessionTool("delete_page", {
        page_id: fixtureId,
        base_heads: read.heads,
        ...retry(catalog),
      });
      assert.equal(deleted.status, 200);
      const invoke = async (operation, args) => {
        const result = await sessionTool(operation, args);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body;
      };
      await purgeTrashedFixture(invoke, fixtureId, async () => retry(await invoke("list_pages")));
      if (asset && fixtureId === pageId)
        assert.equal((await owner.context().request.get(origin + asset.asset_url)).status(), 404);
    } catch (error) {
      report.cleaned = false;
      report.cleanupError = error.message;
    }
  }
  await Promise.all([...clients].map((client) => client.close().catch(() => {})));
  report.imageSource = {
    downloads: source.total(),
    isolates: source.isolates(),
    errors: source.errors,
  };
  await source.close();
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
