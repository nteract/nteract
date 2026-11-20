// The app shell for /p/<id>/<slug>: the slug's words as the title a link
// unfurler sees when no approved snapshot has been published.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "./index.mjs";
import { titledShell } from "./page-shell.mjs";
import { siteShellResponse, siteTags, socialCardUrl } from "./site-tags.mjs";
import { SOCIAL_CARD_VERSION } from "../shared/social-card.mjs";
import { withProductName } from "../scripts/viewer-chunks.mjs";

const origin = "https://pages.example";
const known = "1a160b47-6df1-4983-81eb-489ca5a26812";
const unknown = "2b160b47-6df1-4983-81eb-489ca5a26812";
// The shell as the build writes it (scripts/build.mjs withProductName).
const SHELL = withProductName(
  readFileSync(new URL("../viewer/index.html", import.meta.url), "utf8"),
);

/** The shell as the Worker serves a route the app owns: the asset with the
 * product's preview tags, and a canonical URL only for `/`. */
const siteShell = (path) =>
  SHELL.replace(
    "</head>",
    () => `${siteTags(origin, { url: path ? origin + path : undefined })}\n</head>`,
  );

function harness(t) {
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, () => {});
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("no request leaves the process");
  });
  const asked = [];
  const previewLookups = [];
  const pages = {
    getByName: (name) => ({
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/internal/published-preview");
        previewLookups.push({ name, path: new URL(request.url).pathname });
        return new Response("null", { headers: { "content-type": "application/json" } });
      },
    }),
  };
  // Shells may check the Page's approved publication, never its catalog or Project.
  const host = {
    getByName: (name) => {
      throw new Error(`the shell looked up ${name}`);
    },
  };
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    ASSETS: {
      fetch: async (request) => {
        asked.push(request);
        if (request.headers.get("if-none-match") === '"shell"')
          return new Response(null, { status: 304, headers: { etag: '"shell"' } });
        return new Response(SHELL, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: '"shell"',
            "cache-control": "public, max-age=0, must-revalidate",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
    PAGES: pages,
    CATALOGS: host,
    PROJECTS: host,
  };
  const send = async (path, init = {}) => {
    const response = await worker.fetch(new Request(origin + path, init), env);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: init.method === "HEAD" ? "" : await response.text(),
    };
  };
  return { send, asked, previewLookups };
}

test("a slugged Page link's shell carries the slug's words as its title and og:title", async (t) => {
  const { send } = harness(t);
  const answer = await send(`/p/${known}/My-Dashboard`);
  assert.equal(answer.status, 200);
  assert.ok(answer.body.includes("<title>My Dashboard · Pages</title>"), answer.body);
  assert.ok(answer.body.includes('<meta property="og:title" content="My Dashboard">'));
  assert.ok(answer.body.includes('<meta name="twitter:title" content="My Dashboard">'));
  assert.ok(answer.body.includes(`<meta property="og:image" content="${socialCardUrl(origin)}">`));
  assert.equal(answer.body.match(/<title>/g).length, 1);
  // Only the title and the preview tags change: the rest of the shell is the
  // asset's bytes.
  assert.equal(answer.body, titledShell(SHELL, "My-Dashboard", origin));
  assert.equal(
    answer.body.replace(
      `<title>My Dashboard · Pages</title>${siteTags(origin, { title: "My Dashboard", type: "article" })}`,
      "",
    ),
    SHELL.replace(/<title>[^<]*<\/title>/, ""),
  );
  // The slug reaches no script and no header.
  assert.equal(answer.body.split("My-Dashboard").length, 1);
  assert.equal(answer.body.split("My Dashboard").length, 4);
  assert.equal(answer.body.split("<script").length, SHELL.split("<script").length);
  assert.ok(!JSON.stringify(answer.headers).includes("Dashboard"));
  // A rewritten body has no validator and is never cached.
  assert.equal(answer.headers.etag, undefined);
  assert.equal(answer.headers["cache-control"], "no-store");
  assert.equal(answer.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(answer.headers["x-content-type-options"], "nosniff");
});

test("the shell is the same bytes for a Page that exists and one that doesn't", async (t) => {
  const { send } = harness(t);
  for (const slug of ["My-Dashboard", "q3_plan--v2", "x"]) {
    const a = await send(`/p/${known}/${slug}`);
    const b = await send(`/p/${unknown}/${slug}`);
    assert.deepEqual(a, b, slug);
  }
  // Signed in or not: a session cookie changes nothing the shell writes.
  const anonymous = await send(`/p/${known}/Plan`);
  const signedIn = await send(`/p/${known}/Plan`, { headers: { cookie: "session=fixture" } });
  assert.deepEqual(anonymous, signedIn);
});

test("a slug's words are escaped, and its grammar admits no markup", async (t) => {
  const { send } = harness(t);
  // Allowed characters that spell markup words still read as plain words.
  const answer = await send(`/p/${known}/script-alert-1`);
  assert.ok(answer.body.includes("<title>script alert 1 · Pages</title>"));
  assert.equal(answer.body.split("<script").length, SHELL.split("<script").length);
  // titledShell escapes whatever reaches it.
  const escaped = titledShell("<title>x</title>", `a"b<c>&d'e`, origin);
  assert.ok(escaped.startsWith("<title>a&quot;b&lt;c&gt;&amp;d&#39;e · Pages</title>"));
  assert.ok(escaped.includes(`<meta property="og:title" content="a&quot;b&lt;c&gt;&amp;d&#39;e">`));
  assert.ok(!/[<>"']/.test(escaped.match(/og:title" content="([^"]*)"/)[1]));
  // Encoded or out-of-grammar input is not a slug: the plain shell, as for
  // any path the app doesn't route.
  for (const path of [
    `/p/${known}/%3Cscript%3E`,
    `/p/${known}/%22onload%3D%22x`,
    `/p/${known}/a%20b`,
    `/p/${known}/caf%C3%A9`,
    `/p/${known}/My.Dashboard`,
    `/p/${known}/view`,
    `/p/${known}/View`,
    `/p/${known}/${"a".repeat(81)}`,
    `/p/${known}/My-Dashboard/more`,
    `/p/${known}/<script>`,
  ]) {
    const plain = await send(path);
    assert.equal(plain.body, siteShell(), path);
    assert.equal(plain.headers.etag, undefined, path);
  }
});

test("an unpublished canonical Page link carries only generic OG with no cache validator", async (t) => {
  const { send, previewLookups } = harness(t);
  for (const path of [`/p/${known}`, `/p/${known}/`]) {
    const answer = await send(path);
    assert.equal(answer.status, 200);
    assert.match(answer.body, /<meta property="og:title" content="Pages">/);
    assert.match(answer.body, /Sign in to check your access/);
    // No Page image: the product icon stands in.
    assert.ok(answer.body.includes(`og:image" content="${socialCardUrl(origin)}"`));
    assert.match(answer.body, /twitter:card" content="summary_large_image"/);
    assert.equal(answer.headers.etag, undefined, path);
    assert.equal(answer.headers["cache-control"], "no-store", path);
  }
  assert.equal(previewLookups.length, 2);
  // A cached shell cannot hide a newly published or removed snapshot.
  const revalidated = await send(`/p/${known}`, { headers: { "if-none-match": '"shell"' } });
  assert.equal(revalidated.status, 200);
  assert.equal(revalidated.headers.etag, undefined);
  // The old query route remains the plain app shell.
  const query = await send(`/?page=${known}`);
  assert.equal(query.body, siteShell("/"));
});

test("a slugged shell always answers in full, and HEAD answers its headers", async (t) => {
  const { send, asked } = harness(t);
  const answer = await send(`/p/${known}/Plan`, {
    headers: { "if-none-match": '"shell"', "if-modified-since": new Date(0).toUTCString() },
  });
  assert.equal(answer.status, 200);
  assert.ok(answer.body.includes("<title>Plan · Pages</title>"));
  const request = asked.at(-1);
  assert.equal(request.headers.has("if-none-match"), false);
  assert.equal(request.headers.has("if-modified-since"), false);
  const head = await send(`/p/${known}/Plan`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["cache-control"], "no-store");
  // Other methods are not shell requests.
  const post = await send(`/p/${known}/Plan`, { method: "POST" });
  assert.equal(post.body, SHELL);
});

test("no log line carries the slug of a Page link it served", async (t) => {
  const { send } = harness(t);
  const slug = "Quarterly-Secret-Plan";
  for (const [path, init] of [
    [`/p/${known}/${slug}`, {}],
    [`/p/${unknown}/${slug}`, {}],
    [`/p/${known}/${slug}`, { method: "HEAD" }],
    [`/p/${known}/${slug}`, { method: "POST" }],
    [`/p/${known}/${slug}/extra`, {}],
    [`/p/${known}/${slug}.json`, {}],
  ])
    await send(path, init);
  const lines = ["log", "info", "warn", "error"].flatMap((level) =>
    console[level].mock.calls.map((call) => JSON.stringify(call.arguments)),
  );
  for (const line of lines) assert.ok(!line.includes("Secret"), line);
});

test("the home page and every other app route carry the product's link-preview tags", async (t) => {
  const { send, asked } = harness(t);
  const home = await send("/");
  assert.equal(home.status, 200);
  assert.equal(home.body, siteShell("/"));
  assert.match(home.body, /<meta property="og:url" content="https:\/\/pages.example\/">/);
  assert.match(home.body, /<meta property="og:title" content="Pages">/);
  assert.match(home.body, /<meta name="twitter:card" content="summary_large_image">/);
  assert.equal(home.headers.etag, undefined);
  assert.equal(home.headers["cache-control"], "no-cache");
  assert.equal(asked.length, 1);
  // A Project or Project-less route names nothing about what it opens: the
  // same tags, with no canonical URL, whatever the ID.
  for (const path of ["/project/prj_abc", "/s/sp_abc", "/trash", `/p/${known}/view`]) {
    const answer = await send(path);
    assert.equal(answer.body, siteShell(), path);
    assert.doesNotMatch(answer.body, /og:url/, path);
  }
  // HEAD answers the headers, other methods the asset's own answer.
  const head = await send("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["cache-control"], "no-cache");
  assert.equal((await send("/", { method: "POST" })).body, SHELL);
});

test("a response that is not the HTML shell passes through unchanged", async () => {
  const redirect = new Response(null, {
    status: 308,
    headers: { location: "/" },
  });
  const answer = await siteShellResponse(
    new Request(`${origin}/index.html`),
    {
      fetch: async () => redirect,
    },
    origin,
  );
  assert.equal(answer, redirect);
  const script = new Response("export {}", {
    headers: { "content-type": "text/javascript" },
  });
  assert.equal(
    await siteShellResponse(new Request(`${origin}/app.js`), { fetch: async () => script }, origin),
    script,
  );
});

test("the product's card is served at the URL the tags name", async (t) => {
  const { send } = harness(t);
  const url = socialCardUrl(origin);
  assert.equal(url, `${origin}/social-card.png?v=${SOCIAL_CARD_VERSION}`);
  const response = await worker.fetch(new Request(url), { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  // The versioned URL never changes its bytes.
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(1, 4)), "PNG");
  // 1200 x 630, as the tags say.
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(16), 1200);
  assert.equal(view.getUint32(20), 630);
  assert.match(
    siteTags(origin),
    /og:image:width" content="1200">\n.*og:image:height" content="630"/,
  );
  // Another build's URL still shows the card, but is not kept for good.
  for (const path of ["/social-card.png", "/social-card.png?v=000000000000"]) {
    const other = await send(path);
    assert.equal(other.status, 200, path);
    assert.equal(other.headers["cache-control"], "public, max-age=300", path);
  }
  assert.equal((await worker.fetch(new Request(url, { method: "POST" }), {})).status, 405);
  const head = await send("/social-card.png", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "image/png");
});
