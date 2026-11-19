// The live tunnels hand the Worker every path but the refused ones.
//
// Each live target sits behind a cloudflared tunnel whose ingress
// (deployment/routes.mjs routesFor) admits every path on the Pages hostname
// except `refusedPaths`; the edge answers those with an empty 404 and the
// Worker never sees them. The Worker gateway is the guard for everything else:
// it answers its own routes, serves the app shell and its files, and refuses
// unknown /api/ and every /internal/ path. These tests hold both halves:
//
// - Every live target admits every route the gateway answers (GATEWAY), every
//   viewer route and shell file (APP), and every file the build writes, and
//   refuses `refusedPaths`.
// - Every host-only route the Worker and its Durable Objects define is under
//   /internal/, found by reading worker/*.mjs for the routes they call and
//   dispatch on. A host-only route outside that prefix fails here.
// - The gateway refuses every /internal/ path from outside on both deployment
//   shapes, and answers each GATEWAY request itself.
// - The output hostname keeps its own allowlist.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH } from "@cloud/dev-oidc.ts";
import { MEDIA_GUIDES } from "../agent-media-guides.mjs";
import { refusedPaths, routesFor } from "./deployment/routes.mjs";
import { QUALIFIED_TARGETS, deploymentProfile } from "./deployment/profiles.mjs";
import { VIEWER_ASSETS, hashedAssetPath, publicUrl } from "./viewer-chunks.mjs";
import worker from "../worker/index.mjs";
import { ADMISSION_ROUTES } from "../worker/admission-reasons.mjs";
import { CARD_IMAGE_THEMES } from "../worker/card-images.mjs";
import { LINK_PREVIEW_PATH, readLinkRoute } from "../worker/link-previews.mjs";
import { OAUTH_ROUTES } from "../worker/oauth.mjs";

const origin = "https://pages.example.test";
const U = "08c583e5-d29e-4f1e-b06b-333965254e94";
const HASH = "0123456789abcdef".repeat(4);
// 43 base64url characters: a connected agent's handle (account-auth.mjs).
const HANDLE = "aZ09_-".repeat(7) + "a";

/** A request for every route the gateway answers itself: [route, method,
 * path, options]. `ahead` marks a sample the gateway doesn't parse yet:
 * #4908 adds the Project forms to readLinkRoute. */
const GATEWAY = [
  // Before authentication.
  ["connect", "GET", "/connect"],
  ["agent guide", "GET", "/llms.txt"],
  ...MEDIA_GUIDES.map(({ path }) => ["media guide", "GET", path]),
  ["health", "GET", "/health"],
  // worker/oauth.mjs handleOAuth, by OAUTH_ROUTES.
  ...[...OAUTH_ROUTES].map((path) => ["oauth", "PUT", path]),
  ["whoami", "GET", "/whoami"],
  ["sign-in", "GET", "/api/auth/login"],
  ["sign-in", "GET", "/oidc"],
  ["sign-in", "POST", "/api/auth/logout"],
  ["sign-in", "GET", "/api/auth/session"],
  // worker/account-auth.mjs handleAccountAuth.
  ["account", "PUT", "/api/auth/logout-all"],
  ["account", "PUT", "/api/auth/grants"],
  ["account", "PUT", `/api/auth/grants/${HANDLE}/revoke`],
  ["mcp", "POST", "/mcp"],
  ["register", "POST", "/api/pages/register"],
  ["tools", "POST", "/api/tools"],
  // The REST routes: the listing, and one tag of one Page, whose `/` and `:`
  // arrive percent-encoded.
  ["list pages", "GET", "/api/pages"],
  ["page tag", "PUT", `/api/pages/${U}/tags/status%3Areviewing`],
  ["page tag", "DELETE", `/api/pages/${U}/tags/repo%3Aorg%2Fname`],
  // /api/(pages|projects)/<id>/assets[/<sha256>]; a Project's are its content
  // document's.
  ["assets", "GET", `/api/pages/${U}/assets`],
  ["assets", "GET", `/api/pages/${U}/assets/${HASH}`],
  ["assets", "GET", `/api/projects/prj_${U}/assets`],
  ["assets", "HEAD", `/api/projects/sp_${U}/assets/${HASH}`],
  // worker/card-images.mjs handleCardImage: the stored hash, the owner's
  // upload, and each image.
  ["card image", "GET", `/api/pages/${U}/card-image`],
  ["card image", "PUT", `/api/pages/${U}/card-image?hash=${HASH}&theme=dark`],
  ...CARD_IMAGE_THEMES.map((theme) => [
    "card image",
    "GET",
    `/api/pages/${U}/card-image/${HASH}-${theme}.webp`,
  ]),
  ["access", "GET", `/api/access?page=${U}`],
  ["published preview", "GET", `/api/link-preview?page=${U}`],
  ["published preview", "GET", `/p/${U}/preview.json`],
  ["published preview", "GET", `/p/${U}/preview.png?v=1`],
  ["slack preview", "POST", "/api/slack/events"],
  // ADMISSION_ROUTES.
  ["admission", "GET", `/api/connect?page=${U}`],
  ["admission", "GET", `/api/sync?page=${U}`],
  ["admission", "POST", `/api/saved?page=${U}`],
  // worker/link-previews.mjs readLinkRoute.
  ["link preview", "GET", `/p/${U}/meta.json`],
  ["link preview", "HEAD", `/p/${U}/card.json`],
  ["link preview", "GET", `/project/prj_${U}/meta.json`, { ahead: "#4908" }],
  ["link preview", "HEAD", `/project/sp_${U}/card.json`, { ahead: "#4908" }],
];

/** The viewer's routes (shared/routes.mjs readPageRoute) and the shell's
 * files, which the gateway serves from ASSETS. */
const VIEWER_ROUTES = [
  "/",
  `/?page=${U}`,
  `/p/${U}`,
  `/p/${U}/`,
  `/p/${U}/Some-Title`,
  `/p/${U}/Some-Title/`,
  `/project/prj_${U}`,
  `/project/sp_${U}/`,
  `/s/sp_${U}`,
  `/s/prj_${U}/`,
  "/projects",
  "/projects/",
  "/pages",
  "/pages/",
  "/pages?q=roadmap",
];
// The files scripts/build.mjs writes to dist/public, by the names it gives
// them.
const SHELL_FILES = [
  "/index.html",
  "/connect.js",
  "/_headers",
  publicUrl("public/chunks/ABCDEFGH.js"),
  ...VIEWER_ASSETS.map((name) => publicUrl(hashedAssetPath(name, Buffer.from(name)))),
];
const APP = [...VIEWER_ROUTES, ...SHELL_FILES];

/** Every file of the last build, as the path it is served at, or null when
 * nothing is built. */
function builtFiles() {
  const root = fileURLToPath(new URL("../dist/public/", import.meta.url));
  if (!existsSync(root)) return null;
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => "/" + path.relative(root, path.join(entry.parentPath, entry.name)));
}

/** The service cloudflared picks for `path` on `hostname`: the first ingress
 * rule whose hostname matches and whose path pattern, if any, matches the
 * decoded path. */
function serviceFor(target, hostname, path) {
  const rules = routesFor(target).matchAll(
    /^ {2}- hostname: (\S+)\n(?: {4}path: (.+)\n)? {4}service: (\S+)$/gm,
  );
  const pathname = decodeURIComponent(new URL(path, "https://" + hostname).pathname);
  for (const [, host, pattern, service] of rules)
    if (host === hostname && (pattern === undefined || new RegExp(pattern).test(pathname)))
      return service;
  return "http_status:404";
}
const pagesHost = (target) => deploymentProfile(target).deployment;
const admitted = (target, path) => {
  const { hostname, listen } = pagesHost(target);
  return serviceFor(target, hostname, path) === "http://" + listen;
};

const pathname = (path) => new URL(path, origin).pathname;
const all = (source, pattern) => [...source.matchAll(pattern)];

// The Worker's and its Durable Objects' own source, tests and fixtures aside.
const workerDir = new URL("../worker/", import.meta.url);
const workerSources = readdirSync(workerDir)
  .filter((name) => name.endsWith(".mjs") && !/[.]test[.]mjs$|fixture/.test(name))
  .map((name) => [name, readFileSync(new URL(name, workerDir), "utf8")]);

/** Every route path the Worker and its Durable Objects send to a Durable
 * Object or dispatch on, as [file, path]. Read from the source: the paths of
 * `https://pages.internal/...` requests and `forwarded(request, path)`,
 * `pathname === path` and `path === path` comparisons, `"<path>":` map keys,
 * and lists checked with `.includes(pathname)`. A path named by a constant
 * resolves through its `const NAME = "/..."` declaration. */
function routeStrings() {
  const constants = new Map();
  const lists = new Map();
  for (const [, source] of workerSources) {
    for (const [, name, value] of all(source, /\bconst ([A-Z][A-Z0-9_]*) = "(\/[^"]*)"/g))
      constants.set(name, [...(constants.get(name) ?? []), value]);
    for (const [, name, body] of all(
      source,
      /\bconst ([A-Z][A-Z0-9_]*) = (?:Object\.freeze\()?\[([^\]]*)\]/g,
    ))
      lists.set(name, [...(lists.get(name) ?? []), body]);
  }
  const resolve = (literal, name) =>
    literal !== undefined ? [literal] : (constants.get(name) ?? []);
  const items = (body) =>
    all(body, /"(\/[^"]*)"|\b([A-Z][A-Z0-9_]+)\b/g).flatMap(([, l, n]) => resolve(l, n));
  const subject = String.raw`(?:url\.pathname|new URL\(request\.url\)\.pathname|pathname|path)`;
  const found = [];
  for (const [file, source] of workerSources) {
    const add = (paths) => paths.forEach((path) => found.push([file, path]));
    for (const [, path] of all(source, /https:\/\/pages\.internal(\/[^"`?]*)/g)) add([path]);
    for (const [, l, n] of all(
      source,
      /\bforwarded\(\s*[\w.]+,\s*(?:"(\/[^"]*)"|([A-Z][A-Z0-9_]*)\b)/g,
    ))
      add(resolve(l, n));
    for (const [, l, n] of all(
      source,
      new RegExp(String.raw`\b${subject} === (?:"(\/[^"]*)"|([A-Z][A-Z0-9_]*)\b)`, "g"),
    ))
      add(resolve(l, n));
    for (const [, l] of all(source, /^\s*"(\/[^"]*)":/gm)) add([l]);
    for (const [, body] of all(
      source,
      new RegExp(String.raw`\[([^\]]*)\]\.includes\(\s*${subject}\b`, "g"),
    ))
      add(items(body));
    for (const [, name] of all(
      source,
      new RegExp(String.raw`\b([A-Z][A-Z0-9_]*)\.includes\(\s*${subject}\b`, "g"),
    ))
      for (const body of lists.get(name) ?? []) add(items(body));
  }
  return found;
}

test("the supported targets include the isolated Page11 experiment", () => {
  assert.deepEqual(QUALIFIED_TARGETS, ["page10", "pages", "pages2", "page11", "page12"]);
});

test("the refused paths are /internal/ and the loopback test issuer", () => {
  assert.equal(refusedPaths, "internal/|dev/oidc(/|$)");
  assert.equal(NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH, "/dev/oidc");
});

for (const target of QUALIFIED_TARGETS)
  test(`${target} admits every path on its Pages hostname except the refused ones`, () => {
    for (const [name, method, path] of GATEWAY)
      assert.equal(admitted(target, path), true, `${target} ${name}: ${method} ${path}`);
    for (const path of APP) assert.equal(admitted(target, path), true, `${target} app: ${path}`);
    // Paths the gateway answers itself or refuses: the tunnel no longer
    // decides them.
    for (const path of [
      "/state",
      "/api/nope",
      "/api/auth/kilo/callback",
      `/api/pages/${U}/card-image/latest`,
      `/p/${U}/Some.Title`,
      "/internal",
      "/Internal/create",
      "/dev/oidcX",
      "/favicon.ico",
      // The library catalog (worker/library-catalog.mjs).
      `/catalog/${HASH}/manifest.json`,
      `/catalog/${HASH}/d3.js`,
    ])
      assert.equal(admitted(target, path), true, `${target} reaches the Worker: ${path}`);
    const internal = routeStrings()
      .map(([, path]) => path)
      .filter((path) => path.startsWith("/internal/"));
    for (const path of [
      "/internal/",
      LINK_PREVIEW_PATH,
      ...internal,
      NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH,
      `${NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH}/`,
      `${NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH}/token`,
    ])
      assert.equal(admitted(target, path), false, `${target} refuses: ${path}`);
  });

test("every built asset path reaches the Worker on every target", (t) => {
  const built = builtFiles();
  // Without a build, the names the build gives its files.
  if (built === null) t.diagnostic("dist/public is absent; checking the names build.mjs writes");
  const files = built ?? SHELL_FILES;
  assert.ok(files.length > 5, "the asset list names the shell's files");
  // A hashed file and a catalog path no allowlist ever named.
  const unnamed = ["/sift-csv-ABCDEFGH.wasm", `/catalog/${HASH}/library.js`];
  for (const target of QUALIFIED_TARGETS)
    for (const path of [...files, ...unnamed])
      assert.equal(admitted(target, path), true, `${target} admits built file ${path}`);
});

test("every host-only route the Worker and its Durable Objects define is under /internal/", () => {
  const routes = routeStrings();
  // The scan finds the host routes each Durable Object class dispatches on.
  for (const path of [
    "/internal/catalog",
    "/internal/create",
    "/internal/tool",
    "/internal/space/read",
    "/internal/location",
    LINK_PREVIEW_PATH,
  ])
    assert.ok(
      routes.some(([, route]) => route === path),
      `the scan finds ${path}`,
    );
  assert.ok(new Set(routes.map(([, path]) => path)).size > 40, "the scan finds the host routes");
  // A route the gateway serves to the public may be named outside /internal/:
  // a Page host takes the admission routes whole from the gateway, and
  // helpers compare a request with the public routes they serve.
  const served = new Set([...GATEWAY.map(([, , path]) => path), ...APP].map(pathname));
  for (const path of ADMISSION_ROUTES) assert.ok(served.has(path), path);
  for (const [file, path] of routes)
    assert.ok(
      path.startsWith("/internal/") || served.has(path),
      `worker/${file} names host route ${path} outside /internal/: the tunnel admits it from outside`,
    );
});

/** The gateway with stub Durable Objects that count the requests they get. */
function gatewayHarness(t) {
  // No request leaves the process; quiet the gateway's own log lines.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network disabled in tunnel route tests");
  });
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, () => {});
  const shell = [];
  const hostCalls = [];
  const host = {
    getByName: () => ({
      fetch: async (request) => {
        hostCalls.push(new URL(request.url).pathname);
        return Response.json({ error: "stub host" }, { status: 418 });
      },
    }),
  };
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    ASSETS: {
      fetch: async (request) => {
        shell.push(new URL(request.url).pathname);
        return new Response("app shell", { headers: { "content-type": "text/html" } });
      },
    },
    PAGES: host,
    CATALOGS: host,
    PROJECTS: host,
  };
  /** Sends one request as `url` with `headers`, and reports how it was answered. */
  const send = async (method, url, headers = {}) => {
    const before = { shell: shell.length, host: hostCalls.length };
    const response = await worker.fetch(new Request(url, { method, headers }), env);
    const text = method === "HEAD" ? "" : await response.text();
    return {
      status: response.status,
      shell: shell.length > before.shell,
      host: hostCalls.length > before.host,
      catchAll: response.status === 404 && text === JSON.stringify({ error: "Not found" }),
    };
  };
  return { send };
}

test("the gateway answers every GATEWAY request itself and serves APP from the shell", async (t) => {
  const { send } = gatewayHarness(t);
  for (const [name, method, path, { ahead } = {}] of GATEWAY) {
    const answer = await send(method, origin + path);
    // An `ahead` sample the gateway doesn't parse yet is the app's for now.
    if (ahead && !readLinkRoute(path)) {
      assert.equal(answer.shell, true, `${path} reaches the shell until ${ahead}`);
      continue;
    }
    assert.equal(answer.shell, false, `${name}: ${method} ${path} fell through to the shell`);
    assert.equal(answer.catchAll, false, `${name}: ${method} ${path} hit the catch-all 404`);
  }
  for (const path of APP) {
    const answer = await send("GET", origin + path);
    assert.equal(answer.shell, true, `${path} is served from the shell`);
  }
  // A tag path with a second segment is admitted by the ingress, not by the
  // gateway.
  for (const method of ["PUT", "DELETE"])
    assert.equal(
      (await send(method, `${origin}/api/pages/${U}/tags/repo:org/name`)).catchAll,
      true,
      method,
    );
});

test("the gateway refuses every /internal/ path from outside on both deployment shapes", async (t) => {
  const { send } = gatewayHarness(t);
  const internal = [
    "/internal/",
    ...new Set(
      routeStrings()
        .map(([, path]) => path)
        .filter((path) => path.startsWith("/internal/")),
    ),
  ];
  const host = new URL(origin).host;
  // Both shapes run worker/index.mjs. Standalone celld gets the request from
  // cloudflared over plain HTTP; on Cloudflare the Worker sees the visitor's
  // https: URL. The edge marks both with the visitor's scheme.
  const shapes = {
    "standalone celld": (path) => [`http://${host}${path}`, { "cf-visitor": '{"scheme":"https"}' }],
    "Cloudflare Workers": (path) => [
      `https://${host}${path}`,
      { "cf-visitor": '{"scheme":"https"}' },
    ],
  };
  for (const [shape, request] of Object.entries(shapes))
    for (const path of internal)
      for (const method of ["GET", "POST"]) {
        const answer = await send(method, ...request(path));
        assert.equal(answer.catchAll, true, `${shape}: ${method} ${path} is the catch-all 404`);
        assert.equal(answer.host, false, `${shape}: ${method} ${path} reached a Durable Object`);
        assert.equal(answer.shell, false, `${shape}: ${method} ${path} reached the shell`);
      }
  // The same holds for unknown /api/ paths.
  for (const request of Object.values(shapes))
    assert.equal((await send("GET", ...request("/api/nope"))).catchAll, true);
});

test("the output hostname keeps its own allowlist", () => {
  for (const target of QUALIFIED_TARGETS) {
    const output = deploymentProfile(target).output;
    const current = routesFor(target);
    const earlier = routesFor(target, { omit: ["admitAll"] });
    if (!output) {
      assert.equal(current.split("  - hostname: ").length - 1, 2, target);
      continue;
    }
    // Byte for byte the rules the earlier form wrote for it.
    const outputRules = (routes) =>
      routes.slice(routes.indexOf(`  - hostname: ${output.hostname}`));
    assert.equal(outputRules(current), outputRules(earlier), target);
    const service = (path) => serviceFor(target, output.hostname, path);
    for (const path of [
      "/health",
      "/frame/v2/",
      "/catalog.json",
      `/catalog/${"a".repeat(64)}/frame.js`,
    ])
      assert.equal(service(path), "http://" + output.listen, `${target} output admits ${path}`);
    for (const path of ["/", "/internal/create", "/frame/v2/x", "/api/pages", "/state"])
      assert.equal(service(path), "http_status:404", `${target} output refuses ${path}`);
  }
});
