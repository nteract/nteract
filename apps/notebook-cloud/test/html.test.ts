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
    assert.match(html, /src="\/assets\/notebook-cloud-viewer\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/notebook-cloud-viewer\.js"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/runtimed_wasm\.js" crossorigin/);
    assert.match(
      html,
      /rel="preload" href="\/assets\/runtimed_wasm_bg\.wasm" as="fetch" type="application\/wasm" crossorigin/,
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
    assert.match(html, /"blobBasePath":"\/api\/n\/demo\/blobs\/"/);
    assert.match(html, /"rendererAssetsBasePath":"\/renderer-assets\/"/);
    assert.match(html, /"runtimedWasmModulePath":"\/assets\/runtimed_wasm\.js"/);
    assert.match(html, /"runtimedWasmPath":"\/assets\/runtimed_wasm_bg\.wasm"/);
    assert.doesNotMatch(html, /function renderNotebook/);
    assert.doesNotMatch(html, /id="notebook"/);
  });

  it("uses content-hashed runtime WASM assets from the viewer asset manifest", async () => {
    const seenPaths: string[] = [];
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo/r/heads-123"),
      fakeEnv({
        ASSETS: fakeRuntimeWasmManifestAssets(
          {
            module: "runtimed_wasm.0123456789abcdef.js",
            wasm: "runtimed_wasm_bg.fedcba9876543210.wasm",
          },
          seenPaths,
        ),
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/assets/runtime-wasm-assets.json"]);
    assert.match(
      html,
      /rel="modulepreload" href="\/assets\/runtimed_wasm\.0123456789abcdef\.js" crossorigin/,
    );
    assert.match(
      html,
      /rel="preload" href="\/assets\/runtimed_wasm_bg\.fedcba9876543210\.wasm" as="fetch" type="application\/wasm" crossorigin/,
    );
    assert.match(html, /"runtimedWasmModulePath":"\/assets\/runtimed_wasm\.0123456789abcdef\.js"/);
    assert.match(html, /"runtimedWasmPath":"\/assets\/runtimed_wasm_bg\.fedcba9876543210\.wasm"/);
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

  it("serves the root path as the notebook-cloud sign-in shell", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/"),
      fakeEnv({
        NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-id",
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
        NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(html, /<title>nteract<\/title>/);
    assert.match(html, /id="nteract-cloud-auth-config"/);
    assert.doesNotMatch(html, /id="nteract-cloud-viewer-config"/);
    assert.match(html, /rel="modulepreload" href="\/assets\/notebook-cloud-viewer\.js"/);
    assert.doesNotMatch(html, /rel="modulepreload" href="[^"]*runtimed_wasm\.js/);
    assert.doesNotMatch(html, /rel="preload" href="[^"]*runtimed_wasm_bg\.wasm/);
    assert.doesNotMatch(html, /In the Loop - Collaborative Notebooks/);
  });

  it("serves stale preview index requests as the notebook-cloud sign-in shell", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/index.html"),
      fakeEnv(),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>nteract<\/title>/);
    assert.doesNotMatch(html, /In the Loop - Collaborative Notebooks/);
  });

  it("injects OIDC runtime config without exposing it through health", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/n/demo/example"),
      fakeEnv({
        NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-id",
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
        NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"issuer":"https:\/\/auth\.stage\.anaconda\.com\/api\/auth"/);
    assert.match(html, /"clientId":"client-id"/);
    assert.match(html, /"redirectUri":"https:\/\/preview\.runt\.run\/oidc"/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss: https:\/\/auth\.stage\.anaconda\.com/,
    );
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
      /rel="preload" href="https:\/\/wasm\.example\/runtime\/runtimed_wasm_bg\.wasm" as="fetch" type="application\/wasm" crossorigin/,
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

function fakeRuntimeWasmManifestAssets(
  manifest: { module: string; wasm: string },
  seenPaths: string[] = [],
): Env["ASSETS"] {
  return {
    fetch: async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      seenPaths.push(pathname);
      if (pathname === "/assets/runtime-wasm-assets.json") {
        return new Response(JSON.stringify(manifest), {
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
