import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { escapeHtml, scriptJsonForHtml } from "../src/index.ts";
import type { DurableObjectNamespace, Env, ExecutionContext } from "../src/cloudflare-types.ts";
import {
  viewerThemeBootstrapScript,
  viewerThemeFirstPaintStyle,
} from "../src/viewer-theme-bootstrap.ts";

describe("HTML script serialization", () => {
  it("escapes text and attribute metacharacters", () => {
    assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#x27;");
  });

  it("escapes script-breaking characters", () => {
    const serialized = scriptJsonForHtml("</script><img src=x onerror=alert(1)>");

    assert.equal(serialized.includes("</script>"), false);
    assert.equal(serialized.includes("<img"), false);
    assert.equal(serialized, '"\\u003c/script\\u003e\\u003cimg src=x onerror=alert(1)\\u003e"');
  });

  it("escapes script-breaking characters inside objects", () => {
    const serialized = scriptJsonForHtml({
      notebookId: "</script><img src=x onerror=alert(1)>",
    });

    assert.equal(serialized.includes("</script>"), false);
    assert.equal(serialized.includes("<img"), false);
    assert.match(serialized, /"notebookId":"\\u003c\/script\\u003e/);
  });

  it("serves the notebook viewer as a shell backed by the shared viewer bundle", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/r/heads-123"),
      fakeEnv(),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(response.headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
    assert.match(response.headers.get("Permissions-Policy") ?? "", /microphone=\(\)/);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /object-src 'none'/);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
    assert.doesNotMatch(response.headers.get("Content-Security-Policy") ?? "", /default-src/);
    assert.doesNotMatch(response.headers.get("Content-Security-Policy") ?? "", /script-src/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss:/,
    );
    assert.match(html, /id="root"/);
    assert.match(html, /id="nteract-cloud-auth-config"/);
    assert.match(html, /id="nteract-cloud-viewer-config"/);
    assert.match(html, /"oidc":null/);
    assert.match(html, /id="nteract-cloud-viewer-config" type="application\/json"/);
    assert.match(html, /href="\/assets\/notebook-cloud-viewer\.css"/);
    assert.match(html, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
    assert.match(html, /src="\/assets\/notebook-cloud-viewer\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/notebook-cloud-viewer\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/runtimed_wasm\.js" crossorigin/);
    assert.match(
      html,
      /rel="prefetch" href="\/assets\/runtimed_wasm_bg\.wasm" as="fetch" type="application\/wasm" crossorigin/,
    );
    assert.ok(
      html.indexOf(viewerThemeFirstPaintStyle()) < html.indexOf(viewerThemeBootstrapScript()),
      "theme first-paint style must apply before the bootstrap script resolves the final theme",
    );
    assert.ok(
      html.indexOf(viewerThemeBootstrapScript()) <
        html.indexOf('rel="modulepreload" href="/assets/notebook-cloud-viewer.js"'),
      "theme bootstrap must run before viewer bundle hints so first paint stays theme-safe",
    );
    assert.ok(
      html.indexOf('rel="modulepreload" href="/assets/notebook-cloud-viewer.js"') <
        html.indexOf('rel="modulepreload" href="/assets/runtimed_wasm.js"'),
      "viewer bundle modulepreload should be discoverable before runtime WASM hints",
    );
    assert.ok(
      html.indexOf('rel="modulepreload" href="/assets/runtimed_wasm.js"') <
        html.indexOf("/assets/notebook-cloud-viewer.css"),
      "runtime WASM modulepreload should be discoverable before the render-blocking stylesheet",
    );
    assert.ok(
      html.indexOf('rel="modulepreload" href="/assets/notebook-cloud-viewer.js"') <
        html.indexOf("/assets/notebook-cloud-viewer.css"),
      "viewer bundle modulepreload should be discoverable before the render-blocking stylesheet",
    );
    assert.doesNotMatch(html, /"renderEndpoint"/);
    assert.match(html, /"catalogEndpoint":"\/api\/n\/demo"/);
    assert.match(html, /"snapshotBasePath":"\/api\/n\/demo\/snapshots\/"/);
    assert.match(html, /"runtimeSnapshotBasePath":"\/api\/n\/demo\/runtime-snapshots\/"/);
    assert.match(html, /"commsSnapshotBasePath":"\/api\/n\/demo\/comms-snapshots\/"/);
    assert.match(html, /"aclEndpoint":"\/api\/n\/demo\/acl"/);
    assert.match(html, /"invitesEndpoint":"\/api\/n\/demo\/invites"/);
    assert.match(html, /"accessRequestsEndpoint":"\/api\/n\/demo\/access-requests"/);
    assert.match(html, /"hostCapabilities":\{"canManageSharing":true\}/);
    assert.doesNotMatch(html, /"canSubmitExecutionRequests":true/);
    assert.match(html, /"blobBasePath":"\/api\/n\/demo\/blobs\/"/);
    assert.match(html, /"rendererAssetsBasePath":"\/renderer-assets\/"/);
    assert.match(
      html,
      /"rendererAssets":\{"js":"isolated-renderer\.js","css":"isolated-renderer\.css","siftWasm":"sift_wasm\.wasm"\}/,
    );
    assert.match(html, /"runtimedWasmModulePath":"\/assets\/runtimed_wasm\.js"/);
    assert.match(html, /"runtimedWasmPath":"\/assets\/runtimed_wasm_bg\.wasm"/);
    assert.doesNotMatch(html, /function renderNotebook/);
    assert.doesNotMatch(html, /id="notebook"/);
  });

  it("preloads the lazy notebook route assets for direct notebook pages", async () => {
    const seenPaths: string[] = [];
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      fakeEnv({
        ASSETS: fakeViewerAssetManifests(
          {
            notebookRoute: {
              modulepreload: [
                "notebook-route.0123456789abcdef.js",
                "MarkdownText.0123456789abcdef.js",
                "markdown.0123456789abcdef.js",
                "katex.min.0123456789abcdef.js",
              ],
              stylepreload: ["notebook-route.0123456789abcdef.css", "katex.0123456789abcdef.css"],
            },
          },
          seenPaths,
        ),
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, [
      "/assets/runtime-wasm-assets.json",
      "/assets/renderer-sidecar-assets.json",
      "/assets/notebook-route-assets.json",
    ]);
    assert.match(html, /rel="modulepreload" href="\/assets\/notebook-route\.0123456789abcdef\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/MarkdownText\.0123456789abcdef\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/markdown\.0123456789abcdef\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/katex\.min\.0123456789abcdef\.js"/);
    assert.match(
      html,
      /rel="preload" href="\/assets\/notebook-route\.0123456789abcdef\.css" as="style"/,
    );
    assert.match(html, /rel="preload" href="\/assets\/katex\.0123456789abcdef\.css" as="style"/);
    assert.ok(
      html.indexOf('rel="modulepreload" href="/assets/notebook-cloud-viewer.js"') <
        html.indexOf('rel="modulepreload" href="/assets/notebook-route.0123456789abcdef.js"'),
      "viewer entry should stay ahead of lazy notebook-route hints",
    );
  });

  it("caches immutable viewer asset manifests across warm shell renders", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: fakeViewerAssetManifests(
        {
          notebookRoute: {
            modulepreload: ["notebook-route.0123456789abcdef.js"],
            stylepreload: ["notebook-route.0123456789abcdef.css"],
          },
          runtimeWasm: {
            module: "runtimed_wasm.0123456789abcdef.js",
            wasm: "runtimed_wasm_bg.fedcba9876543210.wasm",
          },
          rendererSidecar: {
            js: "isolated-renderer.0123456789abcdef.js",
            css: "isolated-renderer.0123456789abcdef.css",
            siftWasm: "sift_wasm.0123456789abcdef.wasm",
          },
        },
        seenPaths,
      ),
    });

    const firstResponse = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      env,
      fakeContext(),
    );
    const secondResponse = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      env,
      fakeContext(),
    );
    const secondHtml = await secondResponse.text();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(seenPaths, [
      "/assets/runtime-wasm-assets.json",
      "/assets/renderer-sidecar-assets.json",
      "/assets/notebook-route-assets.json",
    ]);
    assert.match(
      secondHtml,
      /rel="modulepreload" href="\/assets\/runtimed_wasm\.0123456789abcdef\.js" crossorigin/,
    );
    assert.match(
      secondHtml,
      /rel="modulepreload" href="\/assets\/notebook-route\.0123456789abcdef\.js"/,
    );
    assert.match(secondHtml, /isolated-renderer\.0123456789abcdef\.js/);
  });

  it("keeps notebook route asset hints out of the dashboard shell", async () => {
    const seenPaths: string[] = [];
    const response = await worker.fetch(
      new Request("https://cloud.test/n"),
      fakeEnv({
        ASSETS: fakeViewerAssetManifests(
          {
            notebookRoute: {
              modulepreload: ["notebook-route.0123456789abcdef.js"],
              stylepreload: ["notebook-route.0123456789abcdef.css"],
            },
          },
          seenPaths,
        ),
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, []);
    assert.match(html, /rel="modulepreload" href="\/assets\/notebook-cloud-viewer\.js"/);
    assert.doesNotMatch(html, /notebook-route\.0123456789abcdef/);
  });

  it("uses content-hashed runtime WASM assets from the viewer asset manifest", async () => {
    const seenPaths: string[] = [];
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/r/heads-123"),
      fakeEnv({
        ASSETS: fakeViewerAssetManifests(
          {
            runtimeWasm: {
              module: "runtimed_wasm.0123456789abcdef.js",
              wasm: "runtimed_wasm_bg.fedcba9876543210.wasm",
            },
          },
          seenPaths,
        ),
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, [
      "/assets/runtime-wasm-assets.json",
      "/assets/renderer-sidecar-assets.json",
      "/assets/notebook-route-assets.json",
    ]);
    assert.match(
      html,
      /rel="modulepreload" href="\/assets\/runtimed_wasm\.0123456789abcdef\.js" crossorigin/,
    );
    assert.match(
      html,
      /rel="prefetch" href="\/assets\/runtimed_wasm_bg\.fedcba9876543210\.wasm" as="fetch" type="application\/wasm" crossorigin/,
    );
    assert.match(html, /"runtimedWasmModulePath":"\/assets\/runtimed_wasm\.0123456789abcdef\.js"/);
    assert.match(html, /"runtimedWasmPath":"\/assets\/runtimed_wasm_bg\.fedcba9876543210\.wasm"/);
    // No sidecar manifest deployed: stable renderer asset names remain.
    assert.match(
      html,
      /"rendererAssets":\{"js":"isolated-renderer\.js","css":"isolated-renderer\.css","siftWasm":"sift_wasm\.wasm"\}/,
    );
  });

  it("uses content-hashed renderer sidecar assets from the deploy manifest", async () => {
    const seenPaths: string[] = [];
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/r/heads-123"),
      fakeEnv({
        ASSETS: fakeViewerAssetManifests(
          {
            rendererSidecar: {
              js: "isolated-renderer.0123456789abcdef.js",
              css: "isolated-renderer.fedcba9876543210.css",
              siftWasm: "sift_wasm.a1b2c3d4e5f60718.wasm",
            },
          },
          seenPaths,
        ),
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.ok(seenPaths.includes("/assets/renderer-sidecar-assets.json"));
    assert.match(
      html,
      /"rendererAssets":\{"js":"isolated-renderer\.0123456789abcdef\.js","css":"isolated-renderer\.fedcba9876543210\.css","siftWasm":"sift_wasm\.a1b2c3d4e5f60718\.wasm"\}/,
    );
  });

  it("falls back to stable renderer sidecar names when the manifest is invalid", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/r/heads-123"),
      fakeEnv({
        ASSETS: fakeViewerAssetManifests({
          // js is invalid while css is a VALID hashed name: the whole
          // manifest must be rejected (never a per-field mix of a stable
          // js with a hashed css from another deploy).
          rendererSidecar: {
            js: "../assets/notebook-cloud-viewer.js",
            css: "isolated-renderer.fedcba9876543210.css",
            siftWasm: "sift_wasm.wasm",
          },
        }),
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      html,
      /"rendererAssets":\{"js":"isolated-renderer\.js","css":"isolated-renderer\.css","siftWasm":"sift_wasm\.wasm"\}/,
    );
    assert.doesNotMatch(html, /fedcba9876543210/);
  });

  it("falls back to stable renderer sidecar names when the manifest body is not JSON", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/r/heads-123"),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname === "/assets/renderer-sidecar-assets.json") {
              return new Response("not json", {
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("not found", { status: 404 });
          },
        },
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      html,
      /"rendererAssets":\{"js":"isolated-renderer\.js","css":"isolated-renderer\.css","siftWasm":"sift_wasm\.wasm"\}/,
    );
  });

  it("serves the Markdown document list shell without notebook route config", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/m"),
      fakeEnv(),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>nteract Markdown documents<\/title>/);
    assert.match(html, /id="nteract-cloud-auth-config"/);
    assert.doesNotMatch(html, /id="nteract-cloud-viewer-config"/);
    assert.doesNotMatch(html, /notebookRoute/);
    assert.doesNotMatch(html, /"notebookId"/);
  });

  it("serves Markdown document viewers with Markdown config, not notebook config", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/m/doc-123/Research%20Plan"),
      fakeEnv(),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>nteract Markdown: Research Plan<\/title>/);
    assert.match(html, /"documentKind":"markdown"/);
    assert.match(html, /"documentId":"doc-123"/);
    assert.match(html, /"catalogEndpoint":"\/api\/m\/doc-123"/);
    assert.match(html, /"snapshotBasePath":"\/api\/m\/doc-123\/snapshots\/"/);
    assert.match(html, /"syncEndpoint":"\/m\/doc-123\/sync"/);
    assert.match(html, /"runtimedWasmModulePath":"\/assets\/runtimed_wasm\.js"/);
    assert.match(html, /"runtimedWasmPath":"\/assets\/runtimed_wasm_bg\.wasm"/);
    assert.doesNotMatch(html, /"notebookId"/);
    assert.doesNotMatch(html, /"workstationAttachEndpoint"/);
  });

  it("does not serve legacy one-segment notebook viewer URLs", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 404);
  });

  it("serves vanity notebook viewers as live-sync shells without a latest render endpoint", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      fakeEnv(),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="nteract-cloud-viewer-config"/);
    assert.match(html, /"headsHash":null/);
    assert.doesNotMatch(html, /"renderEndpoint"/);
    assert.doesNotMatch(html, /"pinnedRenderBasePath"/);
    assert.match(html, /"catalogEndpoint":"\/api\/n\/demo"/);
    assert.match(html, /"snapshotBasePath":"\/api\/n\/demo\/snapshots\/"/);
    assert.match(html, /"syncEndpoint":"\/n\/demo\/sync"/);
  });

  it("redirects the root path to the notebook list shell", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/?source=bookmark"),
      fakeEnv({
        NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-id",
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
        NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Anaconda",
        NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      }),
      fakeContext(),
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "https://preview.runt.run/n?source=bookmark");
  });

  it("redirects stale preview index requests to the notebook list shell", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/index.html?source=stale-bookmark"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("Location"),
      "https://preview.runt.run/n?source=stale-bookmark",
    );
  });

  it("injects OIDC runtime config without exposing it through health", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/n/demo/example"),
      fakeEnv({
        NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-id",
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
        NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Anaconda",
        NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"issuer":"https:\/\/auth\.stage\.anaconda\.com\/api\/auth"/);
    assert.match(html, /"clientId":"client-id"/);
    assert.match(html, /"providerLabel":"Anaconda"/);
    assert.match(html, /"redirectUri":"https:\/\/preview\.runt\.run\/oidc"/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss: https:\/\/auth\.stage\.anaconda\.com/,
    );
  });

  it("injects local auth config instead of OIDC provider chrome on loopback", async () => {
    const response = await worker.fetch(
      new Request("http://localhost:45316/n/demo/example?mode=view"),
      fakeEnv({
        NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-id",
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
        NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Anaconda",
        NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"oidc":null/);
    assert.match(
      html,
      /"localDev":\{"authUrl":"\/local-auth\?next=%2Fn%2Fdemo%2Fexample%3Fmode%3Dview"/,
    );
    assert.match(html, /"label":"Use local auth"/);
    assert.doesNotMatch(html, /"providerLabel":"Anaconda"/);
    assert.doesNotMatch(html, /"issuer":"https:\/\/auth\.stage\.anaconda\.com\/api\/auth"/);
  });

  it("serves the OIDC callback shell without a notebook runtime config", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/oidc?code=abc&state=def"),
      fakeEnv({
        NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-id",
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
        NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /nteract cloud notebook sign-in/);
    assert.match(html, /id="nteract-cloud-auth-config"/);
    assert.doesNotMatch(html, /id="nteract-cloud-viewer-config"/);
    assert.match(html, /src="\/assets\/notebook-cloud-viewer\.js"/);
  });

  it("allows the host to place renderer assets on a separate origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      fakeEnv({
        RENDERER_ASSETS_BASE_URL: "https://outputs.example/plugins",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"rendererAssetsBasePath":"https:\/\/outputs\.example\/plugins\/"/);
    assert.match(html, /rel="preconnect" href="https:\/\/outputs\.example" crossorigin/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss: https:\/\/outputs\.example/,
    );
  });

  it("allows the host to place runtimed WASM assets on a separate origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      fakeEnv({
        RUNTIMED_WASM_BASE_URL: "https://wasm.example/runtime",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      html,
      /"runtimedWasmModulePath":"https:\/\/wasm\.example\/runtime\/runtimed_wasm\.js"/,
    );
    assert.match(
      html,
      /"runtimedWasmPath":"https:\/\/wasm\.example\/runtime\/runtimed_wasm_bg\.wasm"/,
    );
    assert.match(html, /rel="preconnect" href="https:\/\/wasm\.example" crossorigin/);
    assert.match(
      html,
      /rel="modulepreload" href="https:\/\/wasm\.example\/runtime\/runtimed_wasm\.js" crossorigin/,
    );
    assert.match(
      html,
      /rel="prefetch" href="https:\/\/wasm\.example\/runtime\/runtimed_wasm_bg\.wasm" as="fetch" type="application\/wasm" crossorigin/,
    );
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss: https:\/\/wasm\.example/,
    );
  });

  it("allows the host to place output documents on a separate origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      fakeEnv({
        OUTPUT_DOCUMENT_BASE_URL: "https://outputs.example/frame",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"outputDocumentBaseUrl":"https:\/\/outputs\.example\/frame\/"/);
    assert.match(html, /rel="preconnect" href="https:\/\/outputs\.example" crossorigin/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /frame-src 'self' blob: data: https:\/\/outputs\.example/,
    );
  });

  it("deduplicates hosted sidecar preconnect hints by origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/example"),
      fakeEnv({
        OUTPUT_DOCUMENT_BASE_URL: "https://outputs.example/frame",
        RENDERER_ASSETS_BASE_URL: "https://outputs.example/renderer-assets",
        RUNTIMED_WASM_BASE_URL: "https://wasm.example/runtime",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(
      (html.match(/rel="preconnect" href="https:\/\/outputs\.example" crossorigin/g) ?? []).length,
      1,
    );
    assert.equal(
      (html.match(/rel="preconnect" href="https:\/\/wasm\.example" crossorigin/g) ?? []).length,
      1,
    );
    assert.ok(
      html.indexOf('rel="preconnect" href="https://outputs.example" crossorigin') <
        html.indexOf('rel="modulepreload" href="/assets/notebook-cloud-viewer.js"'),
      "hosted sidecar preconnect hints should be emitted before module fetches",
    );
  });

  it("serves the debug shell with browser hardening headers but no broad page CSP", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/debug"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(response.headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
    assert.equal(response.headers.get("Content-Security-Policy"), null);
  });
});

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    } satisfies DurableObjectNamespace,
    ...overrides,
  };
}

function fakeViewerAssetManifests(
  manifests: {
    notebookRoute?: { modulepreload: string[]; stylepreload: string[] } | Record<string, unknown>;
    runtimeWasm?: { module: string; wasm: string };
    rendererSidecar?: { js: string; css: string; siftWasm: string } | Record<string, unknown>;
  },
  seenPaths: string[] = [],
): Env["ASSETS"] {
  return {
    fetch: async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      seenPaths.push(pathname);
      if (manifests.runtimeWasm && pathname === "/assets/runtime-wasm-assets.json") {
        return new Response(JSON.stringify(manifests.runtimeWasm), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (manifests.rendererSidecar && pathname === "/assets/renderer-sidecar-assets.json") {
        return new Response(JSON.stringify(manifests.rendererSidecar), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (manifests.notebookRoute && pathname === "/assets/notebook-route-assets.json") {
        return new Response(JSON.stringify(manifests.notebookRoute), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}
