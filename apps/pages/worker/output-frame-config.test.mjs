import test from "node:test";
import assert from "node:assert/strict";
import { outputFrameAssets, outputFrameLocalNetwork } from "./output-frame-config.mjs";
import { outputFrameUrl } from "../shared/output-frame-config.mjs";
import { OUTPUT_FRAME_URL } from "../shared/anywidget-view.mjs";
import { VIEWER_CSP } from "../scripts/viewer-chunks.mjs";
import worker from "./index.mjs";

const origin = "https://pages.example";
const frame = "https://widgets.example/frame/v2/";
const html = "<html><head><title>Pages</title></head><body></body></html>";
const asset = () =>
  new Response(html, {
    headers: {
      "content-type": "text/html",
      "content-security-policy": VIEWER_CSP,
      etag: '"old"',
      "content-length": String(html.length),
    },
  });

test("source audio previews allow blob media without allowing blob scripts", () => {
  const directives = Object.fromEntries(
    VIEWER_CSP.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
  assert.deepEqual(directives["media-src"], ["'self'", "blob:"]);
  assert.equal(directives["script-src"].includes("blob:"), false);
});

test("runtime iframe URLs refuse credentials, opaque URLs, same-origin endpoints and ambient parameters", () => {
  for (const value of [
    "/frame/",
    "http://widgets.example/",
    "data:text/html,x",
    "https://u:p@widgets.example/",
    `${origin}/frame/`,
    `${frame}?token=x`,
    `${frame}#nonce`,
  ])
    assert.throws(() => outputFrameUrl(value, origin), /PAGES_OUTPUT_FRAME_URL/);
  assert.equal(outputFrameUrl(frame, origin), frame);
});

test("local celld can use a separate loopback hostname for its catalog frame", () => {
  const output = "http://127.0.0.1:9446/frame/v2/";
  assert.equal(outputFrameUrl(output, "http://localhost:9916"), output);
  for (const page of [origin, "http://127.0.0.1:9916", "https://localhost"]) {
    assert.throws(() => outputFrameUrl(output, page), /PAGES_OUTPUT_FRAME_URL/);
  }
});

test("a configured shell delivers one URL and matching CSP without stale validators", async () => {
  let inbound;
  const assets = outputFrameAssets(
    {
      fetch: async (request) => {
        inbound = request;
        return asset();
      },
    },
    frame,
    origin,
  );
  const response = await assets.fetch(
    new Request(origin, { headers: { "if-none-match": '"old"', range: "bytes=0-9" } }),
  );
  assert.equal(inbound.headers.has("if-none-match"), false);
  assert.equal(inbound.headers.has("range"), false);
  assert.match(
    await response.text(),
    /name="pages-output-frame-url" content="https:\/\/widgets.example\/frame\/v2\/"/,
  );
  assert.equal(
    response.headers.get("content-security-policy"),
    VIEWER_CSP.replace("https://pages.kilousercontent.com", "https://widgets.example"),
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("content-length"), null);
  const head = await assets.fetch(new Request(origin, { method: "HEAD" }));
  assert.equal(await head.text(), "");
  assert.equal(
    head.headers.get("content-security-policy"),
    response.headers.get("content-security-policy"),
  );
});

test("configuration preserves hashed assets and the unset default", async () => {
  const response = new Response("js", { headers: { etag: '"hash"' } });
  const base = { fetch: async () => response };
  assert.equal(outputFrameAssets(base, undefined, origin), base);
  assert.equal(
    await outputFrameAssets(base, frame, origin).fetch(new Request(`${origin}/chunk-1234.js`)),
    response,
  );
});

test("gateway applies runtime frame configuration to root, bare and slugged Page shells", async (t) => {
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, () => {});
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    PAGES_OUTPUT_FRAME_URL: frame,
    ASSETS: { fetch: async () => asset() },
    PAGES: { getByName: () => ({ fetch: async () => Response.json(null) }) },
  };
  for (const path of [
    "/",
    "/p/1a160b47-6df1-4983-81eb-489ca5a26812",
    "/p/1a160b47-6df1-4983-81eb-489ca5a26812/Some-Page",
  ]) {
    const response = await worker.fetch(new Request(origin + path), env);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert.match(body, /pages-output-frame-url/, path);
    assert.match(
      response.headers.get("content-security-policy"),
      /frame-src https:\/\/widgets.example/,
      path,
    );
  }
});

test("PAGES_OUTPUT_FRAME_LOCAL_NETWORK is true, false or unset", () => {
  for (const value of [undefined, "", "false"]) assert.equal(outputFrameLocalNetwork(value), false);
  assert.equal(outputFrameLocalNetwork("true"), true);
  for (const value of ["1", "yes", "TRUE", " true"])
    assert.throws(() => outputFrameLocalNetwork(value), /PAGES_OUTPUT_FRAME_LOCAL_NETWORK/);
});

test("a private deployment's shell asks views to delegate local-network to the default frame", async () => {
  const tailnet = "https://pages.tailnet.example:8443";
  const assets = outputFrameAssets({ fetch: async () => asset() }, undefined, tailnet, true);
  const response = await assets.fetch(new Request(tailnet + "/"));
  const body = await response.text();
  assert.match(body, /name="pages-output-frame-local-network" content="true"/);
  assert.ok(body.includes(`name="pages-output-frame-url" content="${OUTPUT_FRAME_URL}"`));
  // The default frame keeps the build's own CSP.
  assert.equal(response.headers.get("content-security-policy"), VIEWER_CSP);
  // A configured frame URL alone never marks the shell.
  const plain = await outputFrameAssets({ fetch: async () => asset() }, frame, origin)
    .fetch(new Request(origin))
    .then((r) => r.text());
  assert.doesNotMatch(plain, /pages-output-frame-local-network/);
});

test("gateway marks Page shells when PAGES_OUTPUT_FRAME_LOCAL_NETWORK is true", async (t) => {
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, () => {});
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    PAGES_OUTPUT_FRAME_LOCAL_NETWORK: "true",
    ASSETS: { fetch: async () => asset() },
    PAGES: { getByName: () => ({ fetch: async () => Response.json(null) }) },
  };
  const path = "/p/1a160b47-6df1-4983-81eb-489ca5a26812";
  const marked = await worker.fetch(new Request(origin + path), env);
  assert.equal(marked.status, 200);
  assert.match(await marked.text(), /pages-output-frame-local-network/);
  const unmarked = await worker.fetch(new Request(origin + path), {
    ...env,
    PAGES_OUTPUT_FRAME_LOCAL_NETWORK: undefined,
  });
  assert.doesNotMatch(await unmarked.text(), /pages-output-frame-local-network/);
  const misconfigured = await worker.fetch(new Request(origin + path), {
    ...env,
    PAGES_OUTPUT_FRAME_LOCAL_NETWORK: "yes",
  });
  assert.equal(misconfigured.status, 500);
});

test("non-reading asset requests retain their method and body", async () => {
  let inbound;
  const denied = new Response("Use GET", { status: 405 });
  const assets = outputFrameAssets(
    {
      fetch: async (request) => {
        inbound = request;
        return denied;
      },
    },
    frame,
    origin,
  );
  const request = new Request(origin, { method: "POST", body: "unchanged" });
  assert.equal(await assets.fetch(request), denied);
  assert.equal(inbound, request);
  assert.equal(await inbound.text(), "unchanged");
});

test("a host without asset headers still gets the complete viewer CSP", async () => {
  const assets = outputFrameAssets(
    { fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }) },
    frame,
    origin,
  );
  const response = await assets.fetch(new Request(origin));
  assert.equal(
    response.headers.get("content-security-policy"),
    VIEWER_CSP.replace("https://pages.kilousercontent.com", "https://widgets.example"),
  );
});

test("configured URL dollar sequences remain literal in the meta attribute", async () => {
  const url = "https://widgets.example/$&/$'/$1/frame/v2/";
  const assets = outputFrameAssets({ fetch: async () => asset() }, url, origin);
  const body = await (await assets.fetch(new Request(origin))).text();
  assert.ok(body.includes('content="https://widgets.example/$&amp;/$\'/$1/frame/v2/"'));
  assert.equal(body.match(/<body>/g).length, 1);
});

// The frame URL is the one host setting the shell carries. The viewer bundle
// carries its own library catalog revision (shared/library-catalog.mjs).
test("a configured shell is the build's HTML with one meta, the frame URL", async () => {
  const assets = outputFrameAssets({ fetch: async () => asset() }, frame, origin);
  const body = await (await assets.fetch(new Request(origin))).text();
  const meta = `<meta name="pages-output-frame-url" content="${frame}" />`;
  assert.equal(body, html.replace("</head>", `${meta}</head>`));
});
