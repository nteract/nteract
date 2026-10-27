// Real local OIDC/PKCE/consent and MCP SDK qualification. No hosted credentials.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function runOAuthSmoke({ origin, output, restart, ownerKey } = {}) {
  const base = new URL(origin);
  assert.equal(base.origin, origin);
  assert.equal(base.protocol, "http:");
  assert.equal(base.hostname, "localhost");
  assert.equal(base.username + base.password, "");
  await mkdir(output, { recursive: true });
  const report = { completed: [], errors: [], sdk: "@modelcontextprotocol/sdk" };
  const complete = (step) => {
    report.completed.push(step);
    console.log(`[OAuth E2E] ${step}`);
  };
  const retry = (read) => {
    assert.equal(typeof read.retry_token, "string");
    assert.equal(typeof read.retry_key_prefix, "string");
    return {
      retry_token: read.retry_token,
      idempotency_key: read.retry_key_prefix + crypto.randomUUID(),
    };
  };
  const clients = new Set();
  const browser = await chromium.launch({
    headless: true,
    // Defense in depth: even a missed interception must never resolve a public
    // callback host. Disable proxies so they cannot bypass this local-only DNS.
    args: [
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
  });
  let owner, collaborator, pageId;
  const endpoint = origin + "/mcp";
  const callback = origin + "/oauth/test/callback";
  const clientId = "pages-local-e2e";
  const chatgptCallback = "https://chatgpt.com/connector_platform_oauth_redirect";
  const kiloCallback = "http://127.0.0.1:19876/mcp/oauth/callback";
  let interceptedChatgptCallbacks = 0;
  let interceptedKiloCallbacks = 0;
  const fullScope = "pages:read pages:write offline_access";
  // Reject unexpected destinations rather than accidentally exercising a public provider.
  const localFetch = (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, origin, "OAuth SDK attempted an external request");
    return fetch(input, {
      ...options,
      redirect: "manual",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
  };
  async function browserPage() {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/oauth/authorize" && request.method() === "POST")
        report.lastConsentRequest = {
          origin: request.headers().origin ?? null,
          fetchSite: request.headers()["sec-fetch-site"] ?? null,
        };
    });
    // Playwright route handlers cover the initial request of a redirect chain.
    // CDP Fetch interception pauses each request, including the cross-origin
    // callback after the form POST. A DNS deny rule independently prevents any
    // public fetch if this handler ever misses a request.
    const network = await context.newCDPSession(page);
    network.on("Fetch.requestPaused", async ({ requestId, request, resourceType }) => {
      try {
        const url = new URL(request.url);
        const destination = url.origin + url.pathname;
        if ([callback, chatgptCallback, kiloCallback].includes(destination)) {
          assert.equal(request.method, "GET");
          assert.equal(resourceType, "Document");
          if (destination === chatgptCallback) interceptedChatgptCallbacks++;
          if (destination === kiloCallback) interceptedKiloCallbacks++;
          await network.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html" }],
            body: Buffer.from(
              destination === kiloCallback
                ? "<h1>Intercepted Kilo callback</h1>"
                : destination === chatgptCallback
                  ? "<h1>Intercepted ChatGPT callback</h1>"
                  : "<h1>Local OAuth callback received</h1>",
            ).toString("base64"),
          });
        } else if (url.origin === origin) {
          await network.send("Fetch.continueRequest", { requestId });
        } else {
          report.errors.push(`Unexpected browser destination: ${url.origin}${url.pathname}`);
          await network.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        }
      } catch (error) {
        report.errors.push(`Browser interception failed: ${error.name}`);
        await network
          .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
          .catch(() => {});
      }
    });
    await network.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    return page;
  }
  function provider(scope, { external = false, kilo = false } = {}) {
    assert.equal(external && kilo, false);
    const redirectUrl = kilo ? kiloCallback : external ? chatgptCallback : callback;
    const id = kilo ? "pages-kilo" : external ? "pages-chatgpt" : clientId;
    const data = { state: crypto.randomUUID() };
    return {
      data,
      redirectUrl,
      clientMetadata: {
        client_name: "Pages local OAuth qualification",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      },
      state: () => data.state,
      clientInformation: () => ({ client_id: id, token_endpoint_auth_method: "none" }),
      tokens: () => data.tokens,
      saveTokens: (tokens) => {
        data.tokens = tokens;
      },
      saveCodeVerifier: (value) => {
        data.verifier = value;
      },
      codeVerifier: () => data.verifier,
      redirectToAuthorization: (url) => {
        data.authorization = url;
      },
      saveDiscoveryState: (value) => {
        data.discovery = value;
      },
      discoveryState: () => data.discovery,
    };
  }
  async function startGrant(
    page,
    scope,
    { fresh = false, cancel = false, screenshots = false, external = false, kilo = false } = {},
  ) {
    const client = provider(scope, { external, kilo });
    const callbackCount = kilo ? interceptedKiloCallbacks : interceptedChatgptCallbacks;
    const result = await auth(client, { serverUrl: endpoint, scope, fetchFn: localFetch });
    assert.equal(result, "REDIRECT");
    assert.equal(client.data.authorization.searchParams.get("resource"), endpoint);
    assert.equal(client.data.authorization.searchParams.get("code_challenge_method"), "S256");
    await page.goto(client.data.authorization.href, { waitUntil: "domcontentloaded" });
    if (fresh) {
      await expect(page.getByRole("link", { name: "Sign In", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Sign In", exact: true }).click();
    }
    await expect(
      page.getByRole("heading", {
        name: kilo
          ? "Connect Kilo to Pages"
          : external
            ? "Connect ChatGPT to Pages"
            : "Connect Local test client to Pages",
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access", exact: true })).toBeVisible();
    if (screenshots) {
      await page.screenshot({ path: `${output}/oauth-consent-wide.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${output}/oauth-consent-narrow.png`, fullPage: true });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    const approval = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/oauth/authorize" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: cancel ? "Cancel" : "Allow access", exact: true })
      .click();
    assert.equal(
      (await approval).status(),
      303,
      "Consent must redirect after approval/cancellation",
    );
    await page.waitForURL((url) => url.origin + url.pathname === client.redirectUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    if (external || kilo) {
      assert.equal(
        kilo ? interceptedKiloCallbacks : interceptedChatgptCallbacks,
        callbackCount + 1,
      );
      await expect(
        page.getByRole("heading", {
          name: kilo ? "Intercepted Kilo callback" : "Intercepted ChatGPT callback",
        }),
      ).toBeVisible();
    }
    const returned = new URL(page.url());
    assert.equal(returned.searchParams.get("state"), client.data.state);
    assert.equal(returned.searchParams.get("iss"), origin);
    if (cancel) {
      assert.equal(returned.searchParams.get("error"), "access_denied");
      assert.equal(returned.searchParams.has("code"), false);
      return client;
    }
    const code = returned.searchParams.get("code");
    assert.ok(code);
    assert.equal(
      await auth(client, { serverUrl: endpoint, authorizationCode: code, fetchFn: localFetch }),
      "AUTHORIZED",
    );
    assert.ok(client.data.tokens.access_token.startsWith("pages_at_"));
    assert.equal(
      client.data.tokens.scope.split(" ").includes("pages:write"),
      scope.includes("pages:write"),
    );
    client.data.authorizationCode = code;
    return client;
  }
  async function form(path, values) {
    return localFetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
  }
  async function sessionApi(page, path, body) {
    return page.evaluate(
      async ({ path, body }) => {
        const result = await fetch(path, {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: result.status, body: await result.json() };
      },
      { path, body },
    );
  }
  async function sdkConnection(provider) {
    const client = new Client({ name: "Pages local OAuth test", version: "1" });
    clients.add(client);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      authProvider: provider,
      fetch: localFetch,
      requestInit: { headers: { "X-Pages-Driver": "OAuth E2E" } },
    });
    await client.connect(transport, { timeout: 20000 });
    return client;
  }
  async function call(client, name, args = {}, allowed = true) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    assert.equal(result.isError === true, !allowed, `${name}: ${JSON.stringify(result)}`);
    return result.content?.[0]?.type === "text" ? JSON.parse(result.content[0].text) : result;
  }
  async function patch(client, text, allowed = true) {
    const read = await call(client, "read_page", { page_id: pageId });
    return call(
      client,
      "patch_page",
      {
        page_id: pageId,
        base_heads: read.heads,
        ...retry(read),
        operations: [
          {
            op: "replace_match",
            block_id: read.blocks[0].id,
            match_text: "garden",
            replacement: text,
          },
        ],
      },
      allowed,
    );
  }
  async function access(action) {
    const current = await sessionApi(owner, `/api/access?page=${pageId}`);
    assert.equal(current.status, 200);
    const response = await sessionApi(owner, `/api/access?page=${pageId}`, {
      ...action,
      expected_revision: current.body.access.revision,
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  async function bearerStatus(token, path = "/mcp") {
    const response = await localFetch(origin + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(
        path === "/mcp"
          ? { jsonrpc: "2.0", id: 1, method: "tools/list" }
          : { operation: "list_pages", arguments: {} },
      ),
    });
    await response.body?.cancel();
    return response.status;
  }
  let ownerClient;
  try {
    // Probe without interception, with no cookies or credentials, before issuing
    // a code. If Chromium can resolve a public host, fail before OAuth begins.
    const networkProbe = await browser.newPage();
    try {
      await assert.rejects(
        networkProbe.goto("https://example.com/pages-oauth-network-check", { timeout: 5000 }),
        /net::ERR_NAME_NOT_RESOLVED/,
      );
    } finally {
      await networkProbe.close();
    }
    report.publicDnsDenied = true;
    complete(
      "Public DNS denied before OAuth; browser interception cannot fall through to external hosts",
    );
    const unauthenticated = await localFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.match(
      unauthenticated.headers.get("www-authenticate"),
      /resource_metadata=.*oauth-protected-resource\/mcp/,
    );
    await unauthenticated.body?.cancel();
    const resource = await (
      await localFetch(origin + "/.well-known/oauth-protected-resource/mcp")
    ).json();
    assert.equal(resource.resource, endpoint);
    assert.equal(resource.scopes_supported.includes("offline_access"), false);
    const server = await (
      await localFetch(origin + "/.well-known/oauth-authorization-server")
    ).json();
    assert.deepEqual(server.token_endpoint_auth_methods_supported, ["none"]);
    assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
    assert.equal(server.authorization_response_iss_parameter_supported, true);
    complete("Public discovery, resource audience, S256 and issuer response metadata");
    owner = await browserPage();
    const ownerGrant = await startGrant(owner, fullScope, { fresh: true, screenshots: true });
    ownerClient = await sdkConnection(ownerGrant);
    const inventory = await ownerClient.listTools();
    assert.ok(inventory.tools.some((tool) => tool.name === "read_page"));
    assert.ok(inventory.tools.some((tool) => tool.name === "patch_page"));
    const catalog = await call(ownerClient, "list_pages");
    const created = await call(ownerClient, "create_page", {
      title: "Local OAuth garden",
      markdown: "A shared garden.",
      ...retry(catalog),
    });
    pageId = created.page_id;
    assert.ok(pageId);
    assert.ok(
      (await call(ownerClient, "list_pages")).pages.some((page) => page.page_id === pageId),
    );
    await patch(ownerClient, "garden with OAuth");
    assert.match(
      JSON.stringify(await call(ownerClient, "read_page", { page_id: pageId })),
      /garden with OAuth/,
    );
    complete(
      "Fresh browser OIDC login, consent, SDK PKCE exchange, initialize/list/create/read/edit",
    );
    await startGrant(owner, "pages:read", { cancel: true });
    complete("Canceled consent returns access_denied, state and issuer without a code");
    const chatgptGrant = await startGrant(owner, fullScope, { external: true });
    const chatgptClient = await sdkConnection(chatgptGrant);
    await call(chatgptClient, "read_page", { page_id: pageId });
    await startGrant(owner, "pages:read", { external: true, cancel: true });
    assert.equal(interceptedChatgptCallbacks, 2);
    report.crossOriginCallbacks = {
      intercepted: interceptedChatgptCallbacks,
      allowed: 1,
      canceled: 1,
    };
    complete(
      "Chromium Allow and Cancel navigate to exact ChatGPT callback under CSP; callback requests intercepted locally",
    );
    const kiloGrant = await startGrant(owner, fullScope, { kilo: true });
    const kiloClient = await sdkConnection(kiloGrant);
    await call(kiloClient, "read_page", { page_id: pageId });
    await startGrant(owner, "pages:read", { kilo: true, cancel: true });
    assert.equal(interceptedKiloCallbacks, 2);
    report.kiloCallbacks = {
      intercepted: interceptedKiloCallbacks,
      allowed: 1,
      canceled: 1,
      callback: kiloCallback,
      qualification: "Local HTTP Pages origin; deployed HTTPS origin remains unverified",
    };
    complete(
      "Chromium Allow and Cancel navigate to exact Kilo loopback callback under CSP; intercepted locally, SDK exchange and MCP read pass",
    );
    // Return the authenticated tab to Pages before using browser-session APIs.
    await owner.goto(callback, { waitUntil: "domcontentloaded" });
    const replayGrant = await startGrant(owner, fullScope);
    const replayCode = await form("/oauth/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code: replayGrant.data.authorizationCode,
      redirect_uri: callback,
      code_verifier: replayGrant.data.verifier,
      resource: endpoint,
    });
    assert.equal(replayCode.status, 400);
    assert.equal((await replayCode.json()).error, "invalid_grant");
    assert.equal(await bearerStatus(replayGrant.data.tokens.access_token), 401);
    const replayRefresh = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: replayGrant.data.tokens.refresh_token,
      client_id: clientId,
      resource: endpoint,
    });
    assert.equal(replayRefresh.status, 400);
    assert.equal((await replayRefresh.json()).error, "invalid_grant");
    complete(
      "Bound authorization-code replay rejects and revokes its disposable access/refresh grant",
    );
    const readerGrant = await startGrant(owner, "pages:read");
    const reader = await sdkConnection(readerGrant);
    await call(reader, "read_page", { page_id: pageId });
    await patch(reader, "forbidden scope write", false);
    assert.equal(await bearerStatus(ownerGrant.data.tokens.access_token, "/api/tools"), 403);
    complete("Read-only OAuth denies edits; MCP token cannot authorize browser/API routes");
    collaborator = await browserPage();
    const login = await collaborator
      .context()
      .request.get(origin + "/api/auth/login", { maxRedirects: 0 });
    assert.equal(login.status(), 302);
    const loginUrl = new URL(login.headers().location);
    loginUrl.searchParams.set("login_hint", "alice@localhost");
    await collaborator.goto(loginUrl.href, { waitUntil: "domcontentloaded" });
    await expect(collaborator.getByRole("button", { name: /, switch page$/ })).toBeVisible();
    const identity = (await sessionApi(collaborator, "/api/auth/session")).body.identity;
    assert.ok(identity?.principal);
    const collaboratorGrant = await startGrant(collaborator, fullScope);
    const collaboratorClient = await sdkConnection(collaboratorGrant);
    await call(collaboratorClient, "read_page", { page_id: pageId }, false);
    await access({ action: "invite", email: "alice@localhost", role: "editor" });
    await call(collaboratorClient, "read_page", { page_id: pageId });
    await patch(collaboratorClient, "garden with collaborators");
    await access({ action: "set_role", principal: identity.principal, role: "viewer" });
    await call(collaboratorClient, "read_page", { page_id: pageId });
    await patch(collaboratorClient, "forbidden ACL write", false);
    await access({ action: "set_role", principal: identity.principal, role: null });
    await call(collaboratorClient, "read_page", { page_id: pageId }, false);
    assert.ok(
      !(await call(collaboratorClient, "list_pages")).pages.some((page) => page.page_id === pageId),
    );
    complete(
      "Live OAuth grant obeys private default, invite, downgrade and Page revocation without reauth",
    );
    if (ownerKey) assert.equal(await bearerStatus(ownerKey), 200);
    complete(
      ownerKey
        ? "Synthetic Anaconda API key still coexists with OAuth"
        : "API-key coexistence not requested",
    );
    if (restart) {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      await restart();
      ownerClient = await sdkConnection(ownerGrant);
      await call(ownerClient, "read_page", { page_id: pageId });
      complete("Existing OAuth access token and Page survive a real celld process restart");
    }
    const prior = ownerGrant.data.tokens.refresh_token;
    assert.ok(prior);
    assert.equal(
      await auth(ownerGrant, { serverUrl: endpoint, fetchFn: localFetch }),
      "AUTHORIZED",
    );
    assert.notEqual(ownerGrant.data.tokens.refresh_token, prior);
    await call(ownerClient, "read_page", { page_id: pageId });
    const replay = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: prior,
      client_id: clientId,
      resource: endpoint,
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
    assert.equal(await bearerStatus(ownerGrant.data.tokens.access_token), 401);
    complete(
      "SDK refresh rotates tokens; replay rejects and revokes the grant's descendant access tokens",
    );
    const revoked = await form("/oauth/revoke", {
      token: collaboratorGrant.data.tokens.refresh_token,
      client_id: clientId,
    });
    assert.equal(revoked.status, 200);
    assert.equal(await bearerStatus(collaboratorGrant.data.tokens.access_token), 401);
    if (restart) {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      await restart();
      assert.equal(await bearerStatus(ownerGrant.data.tokens.access_token), 401);
      assert.equal(await bearerStatus(collaboratorGrant.data.tokens.access_token), 401);
      assert.equal(await bearerStatus(readerGrant.data.tokens.access_token), 200);
      complete(
        "Explicit revocation and refresh replay tombstones survive restart; unrelated grant remains valid",
      );
    }
    assert.deepEqual(report.errors, []);
  } catch (error) {
    // Never record SDK exceptions containing a request, code or bearer credential.
    report.failure = {
      name: error.name,
      message: error.message.replace(/pages_(?:at|rt)_[A-Za-z0-9_-]+/g, "[redacted]"),
    };
    for (const [name, page] of [
      ["owner", owner],
      ["collaborator", collaborator],
    ])
      if (page)
        await page
          .screenshot({ path: `${output}/failure-${name}.png`, fullPage: true })
          .catch(() => {});
    throw error;
  } finally {
    await Promise.all([...clients].map((client) => client.close().catch(() => {})));
    if (owner && pageId) {
      // A callback failure can leave this tab on the intercepted client origin.
      await owner.goto(callback, { waitUntil: "domcontentloaded" }).catch(() => {});
      const read = await sessionApi(owner, "/api/tools", {
        operation: "read_page",
        arguments: { page_id: pageId },
      }).catch(() => null);
      if (read?.status === 200) {
        const catalog = await sessionApi(owner, "/api/tools", {
          operation: "list_pages",
          arguments: {},
        });
        const deleted = await sessionApi(owner, "/api/tools", {
          operation: "delete_page",
          arguments: {
            page_id: pageId,
            base_heads: read.body.heads,
            ...retry(catalog.body),
          },
        }).catch(() => null);
        report.cleaned = deleted?.status === 200;
        if (!report.cleaned)
          report.cleanupFailure = { status: deleted?.status, error: deleted?.body?.error };
      }
    }
    await browser.close();
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOAuthSmoke({
    origin: process.env.PAGES_ORIGIN,
    output: process.env.PAGES_SCREENSHOTS || "/tmp/pages-oauth-browser",
  });
}
