// The live tunnels admit every route the Worker gateway serves.
//
// Each live target sits behind a cloudflared tunnel whose ingress
// (deployment/routes.mjs routesFor) is an allowlist: the edge answers any
// other path with an empty 404 and the Worker never sees it. Local E2E runs
// celld without a tunnel, so a gateway route missing from the allowlist
// passes every local test and fails only in production, as link previews,
// card images and Project assets did. These tests tie the allowlist to the
// gateway's own code:
//
// - GATEWAY holds a request for every route worker/index.mjs answers itself,
//   and APP every viewer route and shell file it serves from ASSETS. Every
//   live target admits every one.
// - Driven through worker.fetch, no GATEWAY request falls through to the
//   gateway's catch-all 404 or the app shell, and every APP request reaches
//   the shell. The parsers the gateway uses (readLinkRoute, CARD_IMAGE_FILE,
//   ADMISSION_ROUTES, OAUTH_ROUTES, handleAccountAuth, readPageRoute and the
//   shell asset names) accept the samples.
// - A scan of the gateway's dispatch finds every exact path, path regex and
//   route handler it uses. One these tables don't cover fails here, so a new
//   gateway route needs an allowlist decision before it ships.
// - OFF_TUNNEL holds paths kept off the tunnel on purpose, and NEAR_MISSES
//   paths one step from an admitted route. No live target admits either.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH } from "@cloud/dev-oidc.ts";
import { routesFor } from "./deployment/routes.mjs";
import { QUALIFIED_TARGETS } from "./deployment/profiles.mjs";
import { VIEWER_ASSETS, VIEWER_CHUNK, hashedAssetPath, publicUrl } from "./viewer-chunks.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import worker from "../worker/index.mjs";
import { ADMISSION_ROUTES } from "../worker/admission-reasons.mjs";
import { handleAccountAuth } from "../worker/account-auth.mjs";
import { CARD_IMAGE_FILE, CARD_IMAGE_THEMES } from "../worker/card-images.mjs";
import { LINK_PREVIEW_PATH, readLinkRoute } from "../worker/link-previews.mjs";
import { OAUTH_ROUTES, handleOAuth } from "../worker/oauth.mjs";

const origin = "https://pages.runtimed.run";
const U = "08c583e5-d29e-4f1e-b06b-333965254e94";
const HASH = "0123456789abcdef".repeat(4);
// 43 base64url characters: a connected agent's handle (account-auth.mjs).
const HANDLE = "aZ09_-".repeat(7) + "a";
// The extensions CARD_IMAGE_FILE names; the test below pins its source.
const CARD_IMAGE_EXTENSIONS = ["webp", "png", "jpg"];

/** A request for every route the gateway answers itself: [route, method,
 * path, options]. `ahead` marks a sample admitted before the gateway parses
 * it: #4908 adds the Project forms to readLinkRoute. */
const GATEWAY = [
  // Before authentication.
  ["connect", "GET", "/connect"],
  ["agent guide", "GET", "/llms.txt"],
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
  // /api/(pages|projects)/<id>/assets[/<sha256>]; a Project's are its content
  // document's.
  ["assets", "GET", `/api/pages/${U}/assets`],
  ["assets", "GET", `/api/pages/${U}/assets/${HASH}`],
  ["assets", "GET", `/api/projects/prj_${U}/assets`],
  ["assets", "HEAD", `/api/projects/sp_${U}/assets/${HASH}`],
  // worker/card-images.mjs handleCardImage: the stored hash, the owner's
  // upload, and each image by CARD_IMAGE_FILE.
  ["card image", "GET", `/api/pages/${U}/card-image`],
  ["card image", "PUT", `/api/pages/${U}/card-image?hash=${HASH}&theme=dark`],
  ...CARD_IMAGE_THEMES.flatMap((theme) =>
    CARD_IMAGE_EXTENSIONS.map((ext) => [
      "card image",
      "GET",
      `/api/pages/${U}/card-image/${HASH}-${theme}.${ext}`,
    ]),
  ),
  ["access", "GET", `/api/access?page=${U}`],
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
const SHELL_FILES = [
  "/index.html",
  // The /connect page's script, copied unhashed (scripts/build.mjs).
  "/connect.js",
  publicUrl("public/chunks/ABCDEFGH.js"),
  ...VIEWER_ASSETS.map((name) => publicUrl(hashedAssetPath(name, Buffer.from(name)))),
];
const APP = [...VIEWER_ROUTES, ...SHELL_FILES];

/** Paths kept off the tunnel on purpose. Every host-internal path index.mjs
 * names joins these below. */
const OFF_TUNNEL = [
  // The gateway answers its own 404 for any other /api/ or /internal/ path.
  "/api/nope",
  "/internal/",
  LINK_PREVIEW_PATH,
  // celld's node state, on the internal listener only.
  "/state",
  // The loopback test issuer, mounted only on localhost.
  NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH,
  `${NOTEBOOK_CLOUD_LOCAL_OIDC_MOUNT_PATH}/token`,
  // Mints a local dev key (worker/local-api-keys.mjs), mounted only on localhost.
  "/dev/api-key",
  // Where Kilo sends a browser back (worker/kilo-handoff.mjs), answered only
  // where the deployment signs in with Kilo. No tunnel target does. Its start,
  // /api/auth/login, is the sign-in route every target admits.
  "/api/auth/kilo/callback",
  // The asset binding's header rules, not a file it serves.
  "/_headers",
];

/** One step from an admitted route. */
const NEAR_MISSES = [
  // Link previews: exact files, no trailing slash, lowercase v4 IDs of the
  // right kind, and no JSON routes under /s/.
  `/p/${U}/meta.json/`,
  `/p/${U}/card.json/`,
  `/p/${U}/other.json`,
  `/p/${U}/meta.JSON`,
  `/p/${U}/metaXjson`,
  `/p/${U}/meta.json/private`,
  `/p/${U}//meta.json`,
  `/p/${U.toUpperCase()}/meta.json`,
  `/p/prj_${U}/meta.json`,
  `/project/${U}/meta.json`,
  `/project/pg_${U}/meta.json`,
  `/project/prj_${U.toUpperCase()}/card.json`,
  `/project/prj_${U}/meta.json/`,
  `/project/prj_${U}/other.json`,
  `/projects/prj_${U}/meta.json`,
  `/s/sp_${U}/meta.json`,
  `/s/prj_${U}/card.json`,
  // Card images: exact hash length, lowercase hex, a known theme and
  // extension, nothing after the file.
  `/api/pages/${U}/card-image/`,
  `/api/pages/${U}/card-image/${HASH.slice(1)}-light.webp`,
  `/api/pages/${U}/card-image/${HASH}0-light.webp`,
  `/api/pages/${U}/card-image/${HASH.toUpperCase()}-light.webp`,
  `/api/pages/${U}/card-image/${HASH}-sepia.webp`,
  `/api/pages/${U}/card-image/${HASH}-Light.webp`,
  `/api/pages/${U}/card-image/${HASH}-light.gif`,
  `/api/pages/${U}/card-image/${HASH}-light.svg`,
  `/api/pages/${U}/card-image/${HASH}.webp`,
  `/api/pages/${U}/card-image/${HASH}-light.webp/private`,
  `/api/pages/${U}/card-image/latest`,
  `/api/pages/${U.toUpperCase()}/card-image`,
  `/api/pages/prj_${U}/card-image`,
  `/api/projects/prj_${U}/card-image`,
  // Project assets: a Project ID, an exact sha256, nothing after it.
  `/api/projects/${U}/assets`,
  `/api/projects/pg_${U}/assets`,
  `/api/projects/prj_${U.toUpperCase()}/assets`,
  `/api/projects/prj_${U}/assets/`,
  `/api/projects/prj_${U}/assets/private`,
  `/api/projects/prj_${U}/assets/${HASH.slice(1)}`,
  `/api/projects/prj_${U}/assets/${HASH}/private`,
  // Page assets and account routes keep their exact shapes.
  `/api/pages/${U}/assets/${HASH.slice(1)}`,
  `/api/pages/${U}/assets/private`,
  `/api/auth/grants/${HANDLE}`,
  `/api/auth/grants/${HANDLE.slice(1)}/revoke`,
  "/api/auth/logout-all/",
];

const pathname = (path) => new URL(path, origin).pathname;
const ingress = (target) => new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);

// The gateway's dispatch, as source: the `gateway` object in worker/index.mjs.
const indexSource = readFileSync(new URL("../worker/index.mjs", import.meta.url), "utf8");
const gatewaySource = (() => {
  const start = indexSource.indexOf("\nconst gateway = {");
  const end = indexSource.indexOf("\n};\n", start);
  assert.ok(start >= 0 && end > start, "worker/index.mjs defines `const gateway = { ... };`");
  return indexSource.slice(start, end);
})();
const matches = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);
// A JavaScript regex literal, character classes included.
const REGEX_LITERAL = String.raw`\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])+)\/([dgimsuvy]*)`;

test("the supported targets include the isolated Page11 experiment", () => {
  assert.deepEqual(QUALIFIED_TARGETS, ["page10", "pages", "pages2", "page11"]);
});

for (const target of QUALIFIED_TARGETS)
  test(`${target} admits every route the gateway serves and nothing it keeps off`, () => {
    const route = ingress(target);
    for (const [name, method, path] of GATEWAY)
      assert.equal(route.test(pathname(path)), true, `${target} ${name}: ${method} ${path}`);
    for (const path of APP)
      assert.equal(route.test(pathname(path)), true, `${target} app: ${path}`);
    const internal = matches(indexSource, /"(\/internal\/[^"]*)"/g);
    assert.ok(internal.length > 10, "index.mjs names its host-internal routes");
    for (const path of [...OFF_TUNNEL, ...internal])
      assert.equal(route.test(pathname(path)), false, `${target} off the tunnel: ${path}`);
    for (const path of NEAR_MISSES)
      assert.equal(route.test(pathname(path)), false, `${target} near miss: ${path}`);
  });

test("every exact path, path regex and route handler in the gateway has a sample", () => {
  const samples = new Set(GATEWAY.map(([, , path]) => pathname(path)));
  // `url.pathname === "/..."`: each exact path is a sample.
  const exact = matches(gatewaySource, /url\.pathname === "([^"]+)"/g);
  assert.ok(exact.length >= 10, "the scan finds the gateway's exact paths");
  for (const path of exact)
    assert.ok(
      samples.has(path),
      `gateway path ${path} has no GATEWAY sample; admit it in routes.mjs`,
    );
  // The only prefixes are the gateway's own catch-all 404.
  assert.deepEqual(
    [...new Set(matches(gatewaySource, /url\.pathname\.startsWith\("([^"]+)"\)/g))].sort(),
    ["/api/", "/internal/"],
  );
  // `url.pathname.match(/.../)`: pinned, and each matches a sample. A new or
  // changed route regex fails here until its samples and allowlist entry are
  // decided.
  const regexes = [
    ...gatewaySource.matchAll(
      new RegExp(String.raw`url\.pathname\.match\(\s*` + REGEX_LITERAL, "g"),
    ),
  ].map(([, source, flags]) => new RegExp(source, flags));
  assert.deepEqual(
    regexes.map((regex) => regex.source),
    [
      String.raw`^\/api\/(pages|projects)\/([^/]+)\/assets(?:\/([^/]+))?$`,
      String.raw`^\/api\/pages\/([^/]+)\/card-image(?:\/([^/]+))?$`,
    ],
    "a gateway route regex changed; update GATEWAY and routes.mjs with it",
  );
  for (const regex of regexes)
    assert.ok(
      [...samples].some((path) => regex.test(path)),
      `gateway route ${regex} has no GATEWAY sample`,
    );
  // Handlers that answer a set of paths. A new one fails until its paths
  // have samples here and entries in routes.mjs.
  assert.deepEqual(
    [...new Set(matches(gatewaySource, /\b(handle[A-Z]\w*|read[A-Z]\w*Route)\(/g))].sort(),
    [
      "handleAccountAuth",
      "handleCardImage",
      "handleImageAssets",
      // Answers only where the deployment signs in with Kilo (OFF_TUNNEL).
      "handleKiloSignIn",
      "handleLinkPreview",
      // Mounted only on localhost (OFF_TUNNEL).
      // Mounted only on localhost (OFF_TUNNEL).
      "handleLocalApiKeyRequest",
      "handleLocalOidcRequest",
      "handleMcp",
      "handleOAuth",
      "readLinkRoute",
    ],
    "the gateway dispatches to a new handler; add its paths to GATEWAY and routes.mjs",
  );
  assert.match(gatewaySource, /ADMISSION_ROUTES\.includes\(url\.pathname\)/);
  for (const path of ADMISSION_ROUTES)
    assert.ok(samples.has(path), `admission route ${path} has no GATEWAY sample`);
});

test("the gateway's own parsers accept every sample", async () => {
  const of = (name) => GATEWAY.filter(([route]) => route === name);
  // Link previews. The Project forms parse once #4908 lands.
  for (const [, , path, { ahead } = {}] of of("link preview")) {
    const route = readLinkRoute(path);
    if (!ahead) assert.ok(route, path);
    if (route) assert.ok(["meta", "card"].includes(route.file), path);
  }
  for (const path of [
    `/p/${U}/meta.json/`,
    `/p/${U}/other.json`,
    `/p/${U}/meta.json/private`,
    `/s/sp_${U}/meta.json`,
    `/p/${U}`,
  ])
    assert.equal(readLinkRoute(path), null, path);
  // The viewer opens none of the JSON routes as a Page or a Project.
  for (const [, , path] of of("link preview"))
    assert.equal(readPageRoute(path).kind, "missing", path);
  // Card images: CARD_IMAGE_FILE is exactly the shape cardImagePaths admits.
  assert.equal(
    CARD_IMAGE_FILE.source,
    String.raw`^([0-9a-f]{64})-(light|dark)\.(webp|png|jpg)$`,
    "card-images.mjs changed its file names; update cardImagePaths in routes.mjs",
  );
  assert.deepEqual(CARD_IMAGE_THEMES, ["light", "dark"]);
  for (const [, , path] of of("card image")) {
    const file = /\/card-image\/([^/]+)$/.exec(pathname(path))?.[1];
    if (file) assert.match(file, CARD_IMAGE_FILE, path);
  }
  // OAuth and account routes: each sample is a route its handler answers.
  assert.deepEqual(new Set(of("oauth").map(([, , path]) => path)), OAUTH_ROUTES);
  for (const [, , path] of of("oauth")) {
    const response = await handleOAuth(new Request(origin + path, { method: "PUT" }), {});
    assert.equal(response?.status, 405, path);
  }
  for (const [, , path] of of("account")) {
    const response = await handleAccountAuth(new Request(origin + path, { method: "PUT" }), {});
    assert.equal(response?.status, 405, path);
  }
  assert.equal(await handleAccountAuth(new Request(`${origin}/api/auth/other`), {}), null);
  // Admission routes.
  for (const [, , path] of of("admission")) assert.ok(ADMISSION_ROUTES.includes(pathname(path)));
  // Viewer routes and shell files.
  for (const path of VIEWER_ROUTES) assert.notEqual(readPageRoute(path).kind, "missing", path);
  assert.match("public/chunks/ABCDEFGH.js", VIEWER_CHUNK);
});

test("the gateway answers every GATEWAY request itself and serves APP from the shell", async (t) => {
  // No request leaves the process; quiet the gateway's own log lines.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network disabled in tunnel route tests");
  });
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, () => {});
  const shell = [];
  const host = {
    getByName: () => ({
      fetch: async () => Response.json({ error: "stub host" }, { status: 418 }),
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
  const send = async (method, path) => {
    const before = shell.length;
    const response = await worker.fetch(new Request(origin + path, { method }), env);
    const text = method === "HEAD" ? "" : await response.text();
    return {
      status: response.status,
      shell: shell.length > before,
      catchAll: response.status === 404 && text === JSON.stringify({ error: "Not found" }),
    };
  };
  for (const [name, method, path, { ahead } = {}] of GATEWAY) {
    const answer = await send(method, path);
    // An `ahead` sample the gateway doesn't parse yet is the app's for now.
    if (ahead && !readLinkRoute(path)) {
      assert.equal(answer.shell, true, `${path} reaches the shell until ${ahead}`);
      continue;
    }
    assert.equal(answer.shell, false, `${name}: ${method} ${path} fell through to the shell`);
    assert.equal(answer.catchAll, false, `${name}: ${method} ${path} hit the catch-all 404`);
  }
  for (const path of APP) {
    const answer = await send("GET", path);
    assert.equal(answer.shell, true, `${path} is served from the shell`);
  }
  // The catch-all answers what the gateway doesn't serve.
  for (const path of ["/api/nope", LINK_PREVIEW_PATH, "/internal/create"])
    assert.equal((await send("GET", path)).catchAll, true, path);
});

test("every target's ingress pattern refuses private routes, extra segments and malformed Page IDs", () => {
  const page = "/p/12345678-1234-4123-8123-123456789abc";
  for (const target of QUALIFIED_TARGETS) {
    const pattern = new RegExp(/^    path: (.+)$/m.exec(routesFor(target))[1]);
    for (const pathname of [page, page + "/", "/api/pages/register", "/llms.txt"])
      assert.equal(pattern.test(pathname), true, target + " admits " + pathname);
    for (const pathname of [
      "/state",
      "/internal/create",
      "/internal/register",
      "/dev/oidc/authorize",
      "/api/pages",
      "/api/pages/register/extra",
      "/api/other",
      "/api/auth/other",
      "/llms.txt/extra",
      "/llmsXtxt",
      "/p/not-a-page",
      page + "/private",
      page + "x",
      // A Page ID is a v4 UUID: the version and variant digits are checked.
      page.replace("-4123-", "-5123-"),
      page.replace("-8123-", "-7123-"),
    ])
      assert.equal(pattern.test(pathname), false, target + " refuses " + pathname);
  }
});
