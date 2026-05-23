import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { escapeHtml, scriptJsonForHtml } from "../src/index.ts";
import type { DurableObjectNamespace, Env, ExecutionContext } from "../src/cloudflare-types.ts";

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
    assert.match(html, /id="nteract-cloud-viewer-config"/);
    assert.match(html, /src="\/assets\/notebook-cloud-viewer\.js"/);
    assert.match(html, /"renderEndpoint":"\/api\/n\/demo\/renders\/heads-123"/);
    assert.match(html, /"blobBasePath":"\/api\/n\/demo\/blobs\/"/);
    assert.match(html, /"rendererAssetsBasePath":"\/plugins\/"/);
    assert.doesNotMatch(html, /"rendererAssetsBasePath":"\/api\/plugins\/"/);
    assert.doesNotMatch(html, /function renderNotebook/);
  });
});

function fakeEnv(): Env {
  return {
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    } satisfies DurableObjectNamespace,
  };
}

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}
