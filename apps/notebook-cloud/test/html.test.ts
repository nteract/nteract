import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { escapeHtml, scriptJsonForHtml } from "../src/index.ts";
import type { DurableObjectNamespace, Env, ExecutionContext } from "../src/cloudflare-types.ts";
import { viewerThemeBootstrapScript } from "../src/viewer-theme-bootstrap.ts";

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
    assert.match(html, /id="nteract-cloud-viewer-config"/);
    assert.match(html, /id="nteract-cloud-viewer-config" type="application\/json"/);
    assert.match(html, /href="\/assets\/notebook-cloud-viewer\.css"/);
    assert.match(html, /src="\/assets\/notebook-cloud-viewer\.js"/);
    assert.ok(
      html.indexOf(viewerThemeBootstrapScript()) <
        html.indexOf("/assets/notebook-cloud-viewer.css"),
      "theme bootstrap must run before the stylesheet to avoid dark-to-light first paint",
    );
    assert.match(html, /"renderEndpoint":"\/api\/n\/demo\/renders\/heads-123"/);
    assert.match(html, /"blobBasePath":"\/api\/n\/demo\/blobs\/"/);
    assert.match(html, /"rendererAssetsBasePath":"\/renderer-assets\/"/);
    assert.match(html, /"runtimedWasmModulePath":"\/assets\/runtimed_wasm\.js"/);
    assert.match(html, /"runtimedWasmPath":"\/assets\/runtimed_wasm_bg\.wasm"/);
    assert.doesNotMatch(html, /function renderNotebook/);
    assert.doesNotMatch(html, /id="notebook"/);
  });

  it("allows the host to place renderer assets on a separate origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo"),
      fakeEnv({
        RENDERER_ASSETS_BASE_URL: "https://outputs.example/plugins",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"rendererAssetsBasePath":"https:\/\/outputs\.example\/plugins\/"/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss: https:\/\/outputs\.example/,
    );
  });

  it("allows the host to place runtimed WASM assets on a separate origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo"),
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
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /connect-src 'self' ws: wss: https:\/\/wasm\.example/,
    );
  });

  it("allows the host to place output documents on a separate origin", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/n/demo"),
      fakeEnv({
        OUTPUT_DOCUMENT_BASE_URL: "https://outputs.example/frame",
      }),
      fakeContext(),
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /"outputDocumentBaseUrl":"https:\/\/outputs\.example\/frame\/"/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /frame-src 'self' blob: data: https:\/\/outputs\.example/,
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

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}
