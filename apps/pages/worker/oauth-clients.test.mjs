import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHATGPT_CLIENT,
  CHATGPT_REDIRECT,
  KILO_REDIRECT,
  OAuthError,
  clientFromMetadata,
  formActionSource,
  loggedClientId,
  loopbackNameClash,
  loopbackRedirect,
  metadataClient as fetchMetadataClient,
  metadataClientUrl,
  metadataFetchTimeouts,
  namedClient,
  oauthClientName,
  oauthDriverName,
  redirectAllowed,
} from "./oauth-clients.mjs";

// Unit fetches are mocked; the network-boundary tests exercise enforcement.
const publicEgress = { PAGES_OAUTH_METADATA_EGRESS: "public-https" };
const metadataClient = (url) => fetchMetadataClient(url, publicEgress);
const origin = "https://pages.example";
// The documents Anthropic and OpenAI publish at these client ids.
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const published = {
  [CLAUDE]: {
    client_id: CLAUDE,
    client_name: "Claude",
    client_uri: "https://claude.ai",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  [CLAUDE_CODE]: {
    client_id: CLAUDE_CODE,
    client_name: "Claude Code",
    client_uri: "https://claude.ai",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  [CHATGPT_CLIENT]: {
    client_id: CHATGPT_CLIENT,
    client_uri: "https://chatgpt.com/",
    redirect_uris: [CHATGPT_REDIRECT],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ],
    response_types: ["code"],
    client_name: "ChatGPT",
    logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
    token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: "https://chatgpt.com/oauth/jwks.json",
  },
};
const document = (id, extra = {}) => ({
  client_id: id,
  client_name: "Example",
  redirect_uris: ["https://app.example/callback"],
  token_endpoint_auth_method: "none",
  ...extra,
});
const client = (id, extra) => clientFromMetadata(new URL(id), document(id, extra));
// Real I/O turns. Tests mock only setTimeout, so these still advance.
const turns = async (count = 50) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function track(promise) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}
const answer = (url, cacheControl = "max-age=300") =>
  Response.json(document(url), { headers: { "Cache-Control": cacheControl } });

test("a metadata-document client id is a canonical https URL on a public DNS name", () => {
  for (const id of [
    CLAUDE,
    CLAUDE_CODE,
    CHATGPT_CLIENT,
    "https://app.example/client.json",
    "https://xn--bcher-kva.example/oauth/client",
    "https://a.b.example/x/y/z",
  ])
    assert.equal(metadataClientUrl(id, origin)?.href, id, id);
  for (const id of [
    undefined,
    null,
    42,
    "",
    "pages-kilo",
    "app.example/client.json",
    "http://app.example/client.json",
    "ftp://app.example/client.json",
    // No path, or a form the URL parser would rewrite before the fetch.
    "https://app.example",
    "https://app.example/",
    "https://APP.example/client.json",
    "https://app.example:443/client.json",
    "https://app.example/a/../client.json",
    "https://app.example/a/./client.json",
    "https://app.example/%2e%2e/client.json",
    "https://app.example/client.json ",
    "https://app.example\\client.json",
    // Credentials, another port, a query or a fragment.
    "https://user@app.example/client.json",
    "https://user:secret@app.example/client.json",
    "https://app.example:8443/client.json",
    "https://app.example/client.json?tenant=1",
    "https://app.example/client.json?",
    "https://app.example/client.json#x",
    "https://app.example/client.json#",
    // Addresses and names that are not a public site.
    "https://127.0.0.1/client.json",
    "https://2130706433/client.json",
    "https://0x7f.1/client.json",
    "https://10.0.0.8/client.json",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.1/client.json",
    "https://203.0.113.9/client.json",
    "https://[::1]/client.json",
    "https://[fd00::1]/client.json",
    "https://[::ffff:127.0.0.1]/client.json",
    "https://localhost/client.json",
    "https://intranet/client.json",
    "https://app.localhost/client.json",
    "https://printer.local/client.json",
    "https://metadata.google.internal/client.json",
    "https://db.corp/client.json",
    "https://router.lan/client.json",
    "https://nas.home.arpa/client.json",
    "https://app.test/client.json",
    "https://hidden.onion/client.json",
    "https://app.example./client.json",
    "https://-app.example/client.json",
    // The Pages host: a document there would be shown as Pages itself.
    "https://pages.example/assets/client.json",
    "https://app.example/" + "x".repeat(256),
  ])
    assert.equal(metadataClientUrl(id, origin), null, String(id));
});

test("client URL admission does not depend on a known product name", () => {
  for (const id of [
    CHATGPT_CLIENT,
    CLAUDE,
    CLAUDE_CODE,
    "https://app.example/client.json",
    "https://claude.ai/oauth/another-client",
  ])
    assert.equal(metadataClientUrl(id, origin)?.href, id);
});

test("metadata needs a configured egress boundary, including for known and cached clients", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (id) => {
    calls.push(id);
    return Response.json(document(id), { headers: { "Cache-Control": "max-age=300" } });
  });
  for (const id of [CHATGPT_CLIENT, "https://boundary.example/client.json"]) {
    const url = new URL(id);
    for (const env of [
      undefined,
      {},
      { PAGES_OAUTH_METADATA_EGRESS: "true" },
      { PAGES_OAUTH_ANY_CLIENT_DOCUMENT: "true" },
    ])
      await assert.rejects(fetchMetadataClient(url, env), {
        error: "temporarily_unavailable",
        status: 503,
      });
    assert.equal(calls.length, id === CHATGPT_CLIENT ? 0 : 1);
    await metadataClient(url);
    await assert.rejects(fetchMetadataClient(url, {}), {
      error: "temporarily_unavailable",
      status: 503,
    });
  }
  assert.equal(calls.length, 2);
});

test("Pages names its own clients; any other is called by the host of its id", () => {
  assert.equal(oauthClientName("pages-chatgpt"), "ChatGPT");
  assert.equal(oauthClientName(CHATGPT_CLIENT), "ChatGPT");
  assert.equal(oauthClientName("pages-kilo"), "Kilo");
  assert.equal(oauthClientName("pages-local-e2e"), "Local test client");
  assert.equal(oauthClientName(CLAUDE), "Claude");
  assert.equal(oauthClientName(CLAUDE_CODE), "Claude Code");
  assert.equal(oauthClientName("https://app.example/client.json"), "app.example");
  // A look-alike path on another host gets that host, not the product name.
  assert.equal(oauthClientName("https://claude.ai.example/oauth/x"), "claude.ai.example");
  assert.equal(oauthClientName("https://claude.ai/oauth/another-client"), "claude.ai");
  for (const id of ["unregistered", "http://app.example/c", "https://10.0.0.8/c", undefined])
    assert.equal(oauthClientName(id), "Unknown client");

  assert.equal(oauthDriverName("pages-chatgpt"), "ChatGPT");
  assert.equal(oauthDriverName("pages-kilo"), "Kilo");
  assert.equal(oauthDriverName(CLAUDE_CODE), "Claude Code");
  assert.equal(oauthDriverName("https://app.example/client.json"), "app.example");
  assert.equal(oauthDriverName("pages-local-e2e"), "MCP");
  assert.equal(oauthDriverName("unregistered"), "MCP");
  // A host too long for a driver label falls back to the generic one.
  const long = `https://${"a".repeat(60)}.${"b".repeat(60)}.example/c`;
  assert.equal(metadataClientUrl(long)?.href, long);
  assert.equal(oauthDriverName(long), "MCP");

  assert.equal(loggedClientId(undefined), undefined);
  assert.equal(loggedClientId("pages-kilo"), "pages-kilo");
  assert.equal(loggedClientId(CLAUDE), CLAUDE);
  assert.equal(loggedClientId("https://app.example/any/path-a-stranger-chose"), "app.example");
  assert.equal(loggedClientId("free text"), "unknown");
});

test("named clients keep one exact callback and the test client needs its fixture flags", () => {
  const chatgpt = namedClient("pages-chatgpt", origin, {});
  assert.deepEqual(chatgpt.redirectUris, [CHATGPT_REDIRECT]);
  assert.equal(chatgpt.host, "chatgpt.com");
  const kilo = namedClient("pages-kilo", origin, {});
  assert.equal(redirectAllowed(kilo, KILO_REDIRECT, origin), true);
  // The loopback port exception is for metadata documents, never a named client.
  assert.equal(redirectAllowed(kilo, "http://127.0.0.1:19877/mcp/oauth/callback", origin), false);
  assert.equal(namedClient(CLAUDE, origin, {}), null);
  assert.equal(namedClient(CHATGPT_CLIENT, origin, {}), null);
  const flags = { PAGES_E2E_ONLY: "true", NOTEBOOK_CLOUD_LOCAL_OIDC: "true" };
  assert.equal(namedClient("pages-local-e2e", origin, flags), null);
  assert.equal(namedClient("pages-local-e2e", "http://127.0.0.1:9467", {}), null);
  assert.deepEqual(namedClient("pages-local-e2e", "http://127.0.0.1:9467", flags).redirectUris, [
    "http://127.0.0.1:9467/oauth/test/callback",
  ]);
});

test("the documents Claude, Claude Code and ChatGPT publish are admitted", () => {
  for (const [id, metadata] of Object.entries(published)) {
    const admitted = clientFromMetadata(new URL(id), metadata);
    assert.equal(admitted.id, id);
    assert.equal(admitted.named, false);
    assert.equal(admitted.known, true);
    assert.equal(admitted.name, metadata.client_name);
    assert.deepEqual(admitted.redirectUris, metadata.redirect_uris);
  }
  // Claude's second document describes a confidential client. Pages never
  // advertises that method, and refuses the document.
  assert.throws(
    () =>
      clientFromMetadata(new URL(CLAUDE + "/confidential_client"), {
        ...published[CLAUDE],
        client_id: CLAUDE + "/confidential_client",
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: "https://claude.ai/v1/mcp/jwks",
      }),
    { error: "invalid_client" },
  );
});

test("a document must name its own URL and describe a public authorization-code client", () => {
  const id = "https://app.example/client.json";
  const admitted = client(id);
  assert.deepEqual(admitted, {
    id,
    name: "app.example",
    host: "app.example",
    declaredName: "Example",
    redirectUris: ["https://app.example/callback"],
    named: false,
    known: false,
  });
  // A stranger's document can claim a product name. It never becomes the name.
  const lookalike = client(id, { client_name: "Claude" });
  assert.equal(lookalike.name, "app.example");
  assert.equal(lookalike.known, false);
  assert.equal(lookalike.declaredName, "Claude");
  assert.equal(client(id, { client_name: "  Padded  " }).declaredName, "Padded");
  // RFC 7591 defaults apply when the lists are absent.
  assert.equal(client(id, { grant_types: undefined, response_types: undefined }).id, id);
  assert.equal(
    client(id, {
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none"],
    }).id,
    id,
  );
  for (const extra of [
    { client_id: "https://app.example/other.json" },
    { client_id: "https://app.example/client.json/" },
    { client_id: "https://APP.example/client.json" },
    { client_id: undefined },
    { client_name: undefined },
    { client_name: "" },
    { client_name: "   " },
    { client_name: 7 },
    { client_name: "x".repeat(129) },
    { client_name: "Claude‮edoc" },
    { client_name: "Cl​aude" },
    { client_name: "Claude\nCode" },
    { client_secret: "s3cret" },
    { client_secret: null },
    { redirect_uris: undefined },
    { redirect_uris: "https://app.example/callback" },
    { redirect_uris: [] },
    { redirect_uris: ["https://app.example/callback", 7] },
    { redirect_uris: Array.from({ length: 33 }, (_, n) => `https://app.example/${n}`) },
    { grant_types: ["refresh_token"] },
    { grant_types: "authorization_code" },
    { response_types: ["token"] },
    { response_types: "code" },
    { token_endpoint_auth_method: undefined },
    { token_endpoint_auth_method: "client_secret_basic" },
    { token_endpoint_auth_method: "private_key_jwt" },
    {
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: "none",
    },
  ])
    assert.throws(
      () => client(id, extra),
      (error) => error instanceof OAuthError && error.error === "invalid_client",
      JSON.stringify(extra),
    );
  for (const metadata of [null, undefined, "text", 7, [], [document(id)]])
    assert.throws(() => clientFromMetadata(new URL(id), metadata), { error: "invalid_client" });
});

test("a callback matches a listed one exactly, except the port of a loopback callback", () => {
  const id = "https://app.example/client.json";
  const web = client(id, {
    redirect_uris: ["https://app.example/callback", "https://other.example/cb?kind=mcp"],
  });
  for (const uri of ["https://app.example/callback", "https://other.example/cb?kind=mcp"])
    assert.equal(redirectAllowed(web, uri, origin), true, uri);
  for (const uri of [
    "https://app.example/callback/",
    "https://app.example/Callback",
    "https://app.example/callback?next=1",
    "https://app.example:443/callback",
    "https://app.example:8443/callback",
    "http://app.example/callback",
    "https://app.example.evil.example/callback",
    "https://other.example/cb",
    "https://other.example/cb?kind=other",
    "https://app.example/callback#fragment",
    "https://user@app.example/callback",
    "",
    undefined,
  ])
    assert.equal(redirectAllowed(web, uri, origin), false, String(uri));

  const native = clientFromMetadata(new URL(CLAUDE_CODE), published[CLAUDE_CODE]);
  for (const uri of [
    "http://localhost/callback",
    "http://localhost:3118/callback",
    "http://localhost:65535/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:54321/callback",
  ]) {
    assert.equal(redirectAllowed(native, uri, origin), true, uri);
    assert.equal(loopbackRedirect(uri), true, uri);
  }
  for (const uri of [
    "http://localhost:3118/callback/",
    "http://localhost:3118/other",
    "http://localhost:3118/callback?next=evil",
    "http://localhost:3118/callback#fragment",
    "https://localhost:3118/callback",
    "http://localhost:3118@evil.example/callback",
    "http://localhost.evil.example:3118/callback",
    "http://127.0.0.2:3118/callback",
    "http://[::1]:3118/callback",
    "http://0.0.0.0:3118/callback",
    "http://192.168.1.1:3118/callback",
    "http://169.254.169.254/callback",
    "http://evil.example/callback",
    "custom-scheme://callback",
    "javascript:alert(1)",
  ])
    assert.equal(redirectAllowed(native, uri, origin), false, uri);
  // A listed loopback host does not stand in for the other one.
  const oneHost = client(id, { redirect_uris: ["http://127.0.0.1/cb"] });
  assert.equal(redirectAllowed(oneHost, "http://127.0.0.1:4000/cb", origin), true);
  assert.equal(redirectAllowed(oneHost, "http://localhost:4000/cb", origin), false);
  // Listing a callback does not make every scheme or host acceptable.
  const odd = client(id, {
    redirect_uris: [
      "http://app.example/callback",
      "cursor://callback",
      "http://[::1]/callback",
      "https://pages.example/oauth/authorize",
      "http://10.0.0.8/callback",
      // A path the consent page's policy could not name.
      "https://app.example/cb;script-src%20*",
      "https://app.example/cb,https://evil.example",
      "https://app.example/cb'unsafe-inline'",
      "http://localhost/cb;x",
    ],
  });
  for (const uri of odd.redirectUris) assert.equal(redirectAllowed(odd, uri, origin), false, uri);
  assert.equal(loopbackRedirect("https://app.example/callback"), false);
  assert.equal(loopbackRedirect("http://evil.example/callback"), false);
});

test("a callback on the Pages hostname is refused on every port, on a loopback origin too", () => {
  const id = "https://app.example/client.json";
  const web = client(id, {
    redirect_uris: [
      "https://pages.example/cb",
      "https://pages.example:8443/cb",
      "https://near.pages.example/cb",
    ],
  });
  assert.equal(redirectAllowed(web, "https://pages.example/cb", origin), false);
  assert.equal(redirectAllowed(web, "https://pages.example:8443/cb", origin), false);
  assert.equal(redirectAllowed(web, "https://near.pages.example/cb", origin), true);
  assert.equal(loopbackNameClash("https://pages.example:8443/cb", origin), null);

  // A cookie belongs to a hostname, not a port: a native client listening on
  // the name a local Pages server uses would be sent the Pages session.
  const native = clientFromMetadata(new URL(CLAUDE_CODE), published[CLAUDE_CODE]);
  for (const [local, same, other] of [
    ["http://localhost:9894", "localhost", "127.0.0.1"],
    ["http://127.0.0.1:9894", "127.0.0.1", "localhost"],
    ["http://localhost", "localhost", "127.0.0.1"],
  ]) {
    for (const port of ["", ":9894", ":54034"]) {
      const clash = `http://${same}${port}/callback`;
      assert.equal(redirectAllowed(native, clash, local), false, `${clash} at ${local}`);
      assert.equal(loopbackNameClash(clash, local), other, `${clash} at ${local}`);
      const apart = `http://${other}${port}/callback`;
      assert.equal(redirectAllowed(native, apart, local), true, `${apart} at ${local}`);
      assert.equal(loopbackNameClash(apart, local), null, `${apart} at ${local}`);
    }
  }
  // Only an `http` loopback origin has another name to run under.
  assert.equal(loopbackNameClash("http://localhost:3118/callback", "https://localhost:9894"), null);
  assert.equal(loopbackNameClash("http://localhost:3118/callback", "http://[::1]:9894"), null);
  // Not a callback at all.
  for (const uri of ["http://localhost:3118/cb#f", "http://user@localhost/cb", "", undefined])
    assert.equal(loopbackNameClash(uri, "http://localhost:9894"), null, String(uri));
});

test("the consent form may be sent to the callback's origin and path", () => {
  assert.equal(formActionSource(CHATGPT_REDIRECT, origin), CHATGPT_REDIRECT);
  assert.equal(formActionSource(KILO_REDIRECT, origin), KILO_REDIRECT);
  assert.equal(
    formActionSource("http://localhost:3118/callback", origin),
    "http://localhost:3118/callback",
  );
  // A policy source has no query. The URL parser has already encoded a space.
  assert.equal(
    formActionSource("https://app.example/cb?kind=mcp", origin),
    "https://app.example/cb",
  );
  assert.equal(formActionSource("https://app.example/a b", origin), "https://app.example/a%20b");
  // A callback that is refused has no source, and the policy is never widened
  // to its origin.
  for (const uri of [
    "https://app.example/cb;script-src%20*",
    "https://app.example/cb;script-src *",
    "https://app.example/cb,https://evil.example",
    "https://app.example/cb'unsafe-inline'",
    "javascript:alert(1)",
  ]) {
    assert.equal(formActionSource(uri, origin), "", uri);
    assert.equal(loopbackRedirect(uri), false, uri);
  }
  assert.equal(formActionSource(origin + "/oauth/test/callback", origin), "");
});

test("a document is fetched without redirects, bounded in size and time, and only as JSON", async (t) => {
  let fetched,
    calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (fetched instanceof Error) throw fetched;
    return fetched;
  });
  let n = 0;
  const next = () => new URL(`https://fetch-${n++}.example/client.json`);
  const json = (id, extra, init = {}) =>
    new Response(JSON.stringify(document(id, extra)), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      ...init,
    });
  let url = next();
  fetched = json(url.href);
  assert.equal((await metadataClient(url)).id, url.href);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, url.href);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(calls[0].options.headers.authorization, undefined);

  url = next();
  fetched = new Response(JSON.stringify(document(url.href)), {
    headers: { "Content-Type": "application/cimd+json; charset=utf-8" },
  });
  assert.equal((await metadataClient(url)).id, url.href);

  const unavailable = [
    () => new Response(null, { status: 302, headers: { Location: "https://10.0.0.8/private" } }),
    () => new Response(null, { status: 301, headers: { Location: "https://other.example/c" } }),
    (id) => json(id, {}, { status: 201 }),
    (id) => json(id, {}, { status: 404 }),
    (id) => json(id, {}, { status: 503 }),
    (id) =>
      new Response(JSON.stringify(document(id)), { headers: { "Content-Type": "text/html" } }),
    (id) => new Response(JSON.stringify(document(id))),
    () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    (id) => json(id, { padding: "x".repeat(5120) }),
    () => new Response("\xff\xfe", { headers: { "Content-Type": "application/json" } }),
    () => new TypeError("fetch failed"),
  ];
  for (const [index, build] of unavailable.entries()) {
    url = next();
    fetched = build(url.href);
    await assert.rejects(
      metadataClient(url),
      (error) =>
        error instanceof OAuthError &&
        error.error === "temporarily_unavailable" &&
        error.status === 503 &&
        // The refusal names the host and nothing the response said.
        error.message ===
          `Pages could not read the client information at ${url.hostname}. Try again.`,
      `case ${index}`,
    );
  }
  url = next();
  fetched = json("https://another.example/client.json");
  await assert.rejects(metadataClient(url), { error: "invalid_client", status: 400 });
});

test("validated documents are cached per client id, never past 64 entries or their freshness", async (t) => {
  let now = Date.now() + 10_000_000;
  const calls = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json(document(url), { headers: { "Cache-Control": "max-age=300" } });
  });
  const url = (n) => new URL(`https://cache-${n}.example/client.json`);
  await metadataClient(url(0));
  await metadataClient(url(0));
  assert.equal(calls.length, 1);
  // Each client id has its own entry: one document never answers for another.
  assert.equal((await metadataClient(url(1))).id, url(1).href);
  assert.equal(calls.length, 2);
  for (let n = 2; n < 64; n++) await metadataClient(url(n));
  assert.equal(calls.length, 64);
  await metadataClient(url(0));
  assert.equal(calls.length, 64, "64 entries are kept");
  // One more evicts the oldest entry and no other.
  await metadataClient(url(64));
  await metadataClient(url(1));
  assert.equal(calls.length, 65);
  await metadataClient(url(0));
  assert.equal(calls.length, 66, "the oldest entry was evicted");
  // Many more strangers do not grow the cache: the newest 64 stay.
  for (let n = 100; n < 400; n++) await metadataClient(url(n));
  const before = calls.length;
  for (let n = 336; n < 400; n++) await metadataClient(url(n));
  assert.equal(calls.length, before);
  await metadataClient(url(335));
  assert.equal(calls.length, before + 1);
  // Past its freshness an entry is fetched again.
  now += 300_000;
  await metadataClient(url(399));
  assert.equal(calls.length, before + 2);
});

test("a document is kept for its max-age less its age, five minutes at most, and never when told not to", async (t) => {
  let now = Date.now() + 100_000_000,
    calls = 0,
    headers = {},
    body,
    status = 200;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(body, { status, headers });
  });
  const url = new URL("https://fresh.example/client.json");
  body = document(url.href);
  const perform = () => metadataClient(url);
  for (const directive of [
    "no-store, max-age=300",
    "no-cache, max-age=300",
    'no-cache="Set-Cookie", max-age=300',
    "private, max-age=300",
    "max-age=0",
    "max-age=abc",
    "max-age=10, max-age=300",
  ]) {
    now += 1_000_000;
    headers = { "Cache-Control": directive };
    const before = calls;
    await perform();
    await perform();
    assert.equal(calls - before, 2, directive);
  }
  for (const [cacheHeaders, seconds] of [
    [{}, 60],
    [{ "Cache-Control": "max-age=900" }, 300],
    [{ "Cache-Control": 'max-age="10"', Age: "3" }, 7],
    [{ "Cache-Control": "max-age=100", Date: true }, 20],
  ]) {
    now += 1_000_000;
    headers = cacheHeaders.Date
      ? { ...cacheHeaders, Date: new Date(now - 80_000).toUTCString() }
      : cacheHeaders;
    const before = calls;
    await perform();
    now += seconds * 1000 - 1000;
    await perform();
    assert.equal(calls - before, 1, JSON.stringify(cacheHeaders));
    now += 1000;
    await perform();
    assert.equal(calls - before, 2, JSON.stringify(cacheHeaders));
  }
  // A document that fails validation, or a failed fetch, is never kept.
  now += 1_000_000;
  headers = { "Cache-Control": "max-age=300" };
  body = document("https://unexpected.example/client.json");
  const beforeInvalid = calls;
  await assert.rejects(perform(), { error: "invalid_client" });
  await assert.rejects(perform(), { error: "invalid_client" });
  assert.equal(calls - beforeInvalid, 2);
  body = document(url.href);
  status = 503;
  await assert.rejects(perform(), { status: 503 });
  await assert.rejects(perform(), { status: 503 });
  assert.equal(calls - beforeInvalid, 4);
  // A fresh entry is replaced by nothing when the next fetch fails.
  status = 200;
  await perform();
  now += 300_000;
  status = 503;
  await assert.rejects(perform(), { status: 503 });
});

test("a fetch that outlasts its time limit is abandoned, headers or body", async (t) => {
  assert.equal(metadataFetchTimeouts.fetch, 5000);
  const saved = { ...metadataFetchTimeouts };
  t.after(() => Object.assign(metadataFetchTimeouts, saved));
  metadataFetchTimeouts.fetch = 20;
  // `AbortSignal.timeout()` does not keep the event loop alive, and a stalled
  // fetch holds nothing else. This timer does, so the abort is what ends each
  // case below, whichever tests run beside this one.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const signals = [];
  let respond;
  t.mock.method(globalThis, "fetch", (url, { signal }) => {
    signals.push(signal);
    return respond(url, signal);
  });
  const refused = (url) => ({
    error: "temporarily_unavailable",
    status: 503,
    message: `Pages could not read the client information at ${url.hostname}. Try again.`,
  });
  // No response: the fetch ends when its own signal aborts, as a real one does.
  respond = (url, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  let url = new URL("https://stalled-headers.example/client.json");
  await assert.rejects(metadataClient(url), refused(url));
  assert.equal(signals[0].reason.name, "TimeoutError");
  // Headers arrive and the body never ends.
  let cancelled = false;
  respond = async () =>
    new Response(
      new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode('{"client_id":')),
        cancel: () => {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  url = new URL("https://stalled-body.example/client.json");
  await assert.rejects(metadataClient(url), refused(url));
  assert.equal(signals[1].reason.name, "TimeoutError");
  assert.equal(cancelled, true, "the stalled body is cancelled");
  // A body whose cancellation never finishes does not outlast the limit
  // either, whether it stalls or runs past the size limit.
  for (const [host, chunk] of [
    ["stalled-cancel.example", '{"client_id":'],
    ["oversized-cancel.example", "x".repeat(6000)],
  ]) {
    let cancelling = false;
    respond = async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode(chunk)),
          cancel: () => {
            cancelling = true;
            return new Promise(() => {});
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    url = new URL(`https://${host}/client.json`);
    await assert.rejects(metadataClient(url), refused(url));
    assert.equal(cancelling, true, host);
    assert.equal(signals.at(-1).reason.name, "TimeoutError", host);
  }
  // None of them left its client id held.
  respond = async (id) => answer(id, "no-store");
  assert.equal((await metadataClient(url)).id, url.href);
});

test("a request waiting on another's fetch resumes from its own timer, then reads the cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    await gate.promise;
    return answer(url);
  });
  const url = new URL("https://shared.example/client.json");
  const owner = metadataClient(url);
  const waiter = metadataClient(url);
  const waiting = track(waiter);
  await turns();
  assert.equal(calls, 1, "only the first request fetches");
  gate.resolve();
  const client = await owner;
  await turns();
  assert.equal(waiting.settled, false, "the owner's fetch settling does not resume the waiter");
  t.mock.timers.tick(metadataFetchTimeouts.poll);
  assert.equal(await waiter, client);
  assert.equal(calls, 1);
});

test("a waiter fetches for itself when the fetch it waited on kept nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [host, first] of [
    ["unkept.example", (url) => answer(url, "no-store")],
    ["failed.example", () => new Response(null, { status: 503 })],
  ]) {
    const gate = deferred();
    const responses = [first, (url) => answer(url, "no-store")];
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
      const respond = responses[calls++];
      if (calls === 1) await gate.promise;
      return respond(url);
    });
    const url = new URL(`https://${host}/client.json`);
    const owner = metadataClient(url);
    const waiter = metadataClient(url);
    const owning = track(owner);
    await turns();
    assert.equal(calls, 1, host);
    gate.resolve();
    await turns();
    assert.equal(owning.settled, true, host);
    assert.equal(calls, 1, "the waiter has not resumed inside the owner's fetch");
    t.mock.timers.tick(metadataFetchTimeouts.poll);
    assert.equal((await waiter).id, url.href);
    assert.equal(calls, 2, host);
    globalThis.fetch.mock.restore();
  }
});

test("a waiter gives up after its wait, and takes over a client id whose fetch was abandoned", async (t) => {
  const saved = { ...metadataFetchTimeouts };
  t.after(() => Object.assign(metadataFetchTimeouts, saved));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0,
    respond = () => new Promise(() => {});
  t.mock.method(globalThis, "fetch", (url) => (calls++, respond(url)));
  const advance = async (ms) => {
    for (let elapsed = 0; elapsed <= ms; elapsed += metadataFetchTimeouts.poll) {
      t.mock.timers.tick(metadataFetchTimeouts.poll);
      await turns(2);
    }
  };
  // A fetch that never settles holds its id for its time limit and a second.
  const url = new URL("https://hung.example/client.json");
  metadataClient(url);
  metadataFetchTimeouts.wait = 1000;
  const impatient = metadataClient(url);
  const leaving = track(impatient);
  await advance(1000);
  assert.equal(leaving.settled, true);
  await assert.rejects(impatient, {
    error: "temporarily_unavailable",
    status: 503,
    message: "Pages is still reading hung.example. Try again.",
  });
  assert.equal(calls, 1);
  // With the usual wait, a later request outlasts the hold and fetches itself.
  metadataFetchTimeouts.wait = saved.wait;
  const patient = metadataClient(url);
  respond = async (id) => answer(id);
  await advance(6000);
  assert.equal((await patient).id, url.href);
  assert.equal(calls, 2);
});

test("at most 16 client ids are fetched at once; a waiter takes no slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    await gate.promise;
    return answer(url, "no-store");
  });
  const url = (n) => new URL(`https://slow-${n}.example/client.json`);
  const owners = Array.from({ length: 16 }, (_, n) => metadataClient(url(n)));
  const waiter = metadataClient(url(0));
  await assert.rejects(metadataClient(url(16)), {
    error: "temporarily_unavailable",
    status: 503,
    message: "Pages is checking too many clients at once. Try again.",
  });
  await turns();
  assert.equal(calls, 16);
  gate.resolve();
  await Promise.all(owners);
  assert.equal((await metadataClient(url(16))).id, url(16).href);
  t.mock.timers.tick(metadataFetchTimeouts.poll);
  assert.equal((await waiter).id, url(0).href);
  assert.equal(calls, 18);
});
