// The app shell for /p/<id>/<slug>: the slug's words as the title a link
// unfurler sees, and nothing that depends on the Page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "./index.mjs";
import { titledShell } from "./page-shell.mjs";
import { withProductName } from "../scripts/viewer-chunks.mjs";

const origin = "https://pages.example";
const known = "1a160b47-6df1-4983-81eb-489ca5a26812";
const unknown = "2b160b47-6df1-4983-81eb-489ca5a26812";
// The shell as the build writes it (scripts/build.mjs withProductName).
const SHELL = withProductName(
  readFileSync(new URL("../viewer/index.html", import.meta.url), "utf8"),
);

function harness(t) {
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, () => {});
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("no request leaves the process");
  });
  const asked = [];
  // Any host lookup fails the test: the shell never asks about the Page.
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
    PAGES: host,
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
  return { send, asked };
}

test("a slugged Page link's shell carries the slug's words as its title and og:title", async (t) => {
  const { send } = harness(t);
  const answer = await send(`/p/${known}/My-Dashboard`);
  assert.equal(answer.status, 200);
  assert.ok(answer.body.includes("<title>My Dashboard · Pages</title>"), answer.body);
  assert.ok(answer.body.includes('<meta property="og:title" content="My Dashboard" />'));
  assert.equal(answer.body.match(/<title>/g).length, 1);
  // Only those two tags change: the rest of the shell is the asset's bytes.
  assert.equal(answer.body, titledShell(SHELL, "My-Dashboard"));
  assert.equal(
    answer.body.replace(/<title>.*?<meta property="og:title" content="[^"]*" \/>/, ""),
    SHELL.replace(/<title>[^<]*<\/title>/, ""),
  );
  // The slug reaches no script and no header.
  assert.equal(answer.body.split("My-Dashboard").length, 1);
  assert.equal(answer.body.split("My Dashboard").length, 3);
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
  const escaped = titledShell("<title>x</title>", `a"b<c>&d'e`);
  assert.equal(
    escaped,
    `<title>a&quot;b&lt;c&gt;&amp;d&#39;e · Pages</title><meta property="og:title" content="a&quot;b&lt;c&gt;&amp;d&#39;e" />`,
  );
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
    assert.equal(plain.body, SHELL, path);
    assert.equal(plain.headers.etag, '"shell"', path);
  }
});

test("a Page link without a slug is served exactly as before", async (t) => {
  const { send } = harness(t);
  for (const path of [`/p/${known}`, `/p/${known}/`, `/?page=${known}`]) {
    const answer = await send(path);
    assert.equal(answer.body, SHELL, path);
    assert.equal(answer.headers.etag, '"shell"', path);
    assert.equal(answer.headers["cache-control"], "public, max-age=0, must-revalidate", path);
  }
  // The caller's validators still reach the asset there.
  const revalidated = await send(`/p/${known}`, { headers: { "if-none-match": '"shell"' } });
  assert.equal(revalidated.status, 304);
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
