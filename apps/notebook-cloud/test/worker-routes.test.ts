import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.ts";
import { NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME } from "../src/app-session.ts";
import {
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  TRUSTED_SCOPE_HEADER,
  TRUSTED_WEBSOCKET_PROTOCOL_HEADER,
  authenticateDevRequest,
} from "../src/identity.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  DurableObjectNamespace,
  Env,
  ExecutionContext,
  R2Bucket,
  R2HTTPMetadata,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "../src/cloudflare-types.ts";
import { initializeRuntimedWasm, RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import {
  blobKey,
  commsDocSnapshotKey,
  createNotebookWithOwnerAcl,
  getNotebookAclRows,
  getNotebookAclRowsForPrincipal,
  runtimeStateSnapshotKey,
  snapshotKey,
} from "../src/storage.ts";
import type { PendingNotebookInviteRow, PrincipalProfileRow } from "../src/sharing-storage.ts";
import { canonicalAccountPrincipalForProfile } from "../src/sharing-storage.ts";
import type { PrincipalAccountLinkRow } from "../src/storage.ts";
import { oidcTokenFixture } from "./oidc-jwt-fixture.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);
const APP_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

before(async () => {
  await initializeRuntimedWasm(wasmBytes);
});

describe("Worker artifact routes", () => {
  it("reports direct OIDC readiness without exposing configured values", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_OIDC_AUDIENCE: "aud-secret-ish-value",
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "client-secret-ish-value",
      NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
      NOTEBOOK_CLOUD_OIDC_JWKS_JSON: '{"keys":[]}',
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/health"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      auth: {
        oidc: {
          audience: string;
          jwks: string;
          principal_namespace: string;
          status: string;
        };
      };
    };
    assert.deepEqual(body.auth.oidc, {
      status: "configured",
      jwks: "pinned",
      audience: "explicit",
      principal_namespace: "configured",
    });
    assert.doesNotMatch(
      JSON.stringify(body),
      /auth\.stage\.anaconda\.com|client-secret-ish-value|aud-secret-ish-value|user:anaconda/,
    );
  });

  it("reports Anaconda API key readiness without exposing configured values", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "user:anaconda",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL:
        "https://auth.stage.anaconda.com/api/auth/sessions/whoami",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/health"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      auth: {
        anaconda_api_key: {
          principal_namespace: string;
          status: string;
        };
      };
    };
    assert.deepEqual(body.auth.anaconda_api_key, {
      status: "configured",
      principal_namespace: "configured",
    });
    assert.doesNotMatch(JSON.stringify(body), /anaconda\.com|user:anaconda/);
  });

  it("reports partial direct OIDC readiness for incomplete deployments", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/health"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      auth: { oidc: { audience: string; jwks: string; status: string } };
    };
    assert.deepEqual(body.auth.oidc, {
      status: "partial",
      jwks: "none",
      audience: "none",
      principal_namespace: "default",
    });
  });

  it("reports app session readiness without exposing the signing secret", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/health"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      auth: { app_session: { status: string } };
    };
    assert.deepEqual(body.auth.app_session, { status: "configured" });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(APP_SESSION_SECRET));
  });

  it("serves viewer bundle assets through the Worker assets binding", async () => {
    const env = fakeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("console.log('viewer')", {
            headers: { "Content-Type": "application/javascript" },
          }),
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/assets/notebook-cloud-viewer.js"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await response.text(), "console.log('viewer')");
  });

  it("serves vanity viewer paths against the notebook id", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/n/notebook-123/topic-viz"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /nteract cloud notebook notebook-123/);
    assert.match(html, /"notebookId":"notebook-123"/);
    assert.doesNotMatch(html, /topic-viz.*render/);
  });

  it("uses catalog-safe metadata for public published notebook viewers", async () => {
    const env = fakeEnv();
    seedNotebook(env, "public-meta-demo");
    const notebook = env.DB.notebooks.get("public-meta-demo");
    assert.ok(notebook);
    notebook.title = "Public & Safe <Notebook>";
    notebook.latest_revision_id = "revision-public-metadata";
    seedAcl(env, {
      notebookId: "public-meta-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/public-meta-demo/public-title"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>nteract notebook: Public &amp; Safe &lt;Notebook&gt;<\/title>/);
    assert.match(
      html,
      /<meta property="og:title" content="nteract notebook: Public &amp; Safe &lt;Notebook&gt;" \/>/,
    );
    assert.match(html, /published revision revision-pub/);
  });

  it("keeps private notebook titles out of server-rendered viewer metadata", async () => {
    const env = fakeEnv();
    seedNotebook(env, "private-meta-demo");
    const notebook = env.DB.notebooks.get("private-meta-demo");
    assert.ok(notebook);
    notebook.title = "Secret Research Plan";
    notebook.latest_revision_id = "revision-private-metadata";

    const response = await worker.fetch(
      new Request("http://localhost/n/private-meta-demo/secret-plan"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>nteract cloud notebook private-meta-demo<\/title>/);
    assert.match(html, /Private notebook metadata is shown after access is verified\./);
    assert.doesNotMatch(html, /Secret Research Plan|revision-private-metadata/);
  });

  it("serves the notebook list page at /n", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(new Request("http://localhost/n"), env, fakeContext());

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>nteract cloud notebooks<\/title>/);
    assert.match(html, /notebook-cloud-viewer\.js/);
    assert.doesNotMatch(html, /nteract-cloud-viewer-config/);
    assert.doesNotMatch(html, /nteract-cloud-bootstrap/);
  });

  it("exchanges OIDC bearer auth for a secure app session cookie", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "session-user",
      email: "session@example.test",
      extraPayload: { email_verified: true },
      name: "Session User",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/auth/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://cloud.test",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    assert.match(cookie, new RegExp(`^${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(cookie, /session@example\.test/);
    assert.deepEqual(await response.json(), { ok: true, expires_in: 21_600 });
  });

  it("rejects cross-origin app session exchange attempts", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "session-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/auth/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://outside.example",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Set-Cookie"), null);
  });

  it("bootstraps the notebook home from a valid app session cookie", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "bootstrap-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "bootstrap-visible");
    const notebook = env.DB.notebooks.get("bootstrap-visible");
    assert.ok(notebook);
    notebook.title = "Bootstrap Visible";
    seedAcl(env, {
      notebookId: "bootstrap-visible",
      subject: "user:anaconda:bootstrap-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n", {
        headers: { Cookie: cookie },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    const bootstrap = notebookHomeBootstrap(html);
    assert.equal(bootstrap.kind, "notebook-list");
    assert.equal(bootstrap.notebooks.length, 1);
    assert.equal(bootstrap.notebooks[0]?.notebook_id, "bootstrap-visible");
    assert.equal(bootstrap.notebooks[0]?.title, "Bootstrap Visible");
    assert.doesNotMatch(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("keeps private notebook bootstrap out of anonymous notebook home HTML", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "anonymous-hidden");
    const notebook = env.DB.notebooks.get("anonymous-hidden");
    assert.ok(notebook);
    notebook.title = "Hidden Private Title";
    seedAcl(env, {
      notebookId: "anonymous-hidden",
      subject: "user:anaconda:hidden-user",
      scope: "owner",
    });

    const response = await worker.fetch(new Request("https://cloud.test/n"), env, fakeContext());

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, /nteract-cloud-bootstrap|Hidden Private Title/);
  });

  it("uses app session cookies only for read-only catalog listing", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-list-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "cookie-list-visible");
    seedAcl(env, {
      notebookId: "cookie-list-visible",
      subject: "user:anaconda:cookie-list-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const listResponse = await worker.fetch(
      new Request("https://cloud.test/api/n", {
        headers: { Cookie: cookie },
      }),
      env,
      fakeContext(),
    );
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as { notebooks: Array<{ notebook_id: string }> };
    assert.deepEqual(
      listBody.notebooks.map((notebook) => notebook.notebook_id),
      ["cookie-list-visible"],
    );

    const patchResponse = await worker.fetch(
      new Request("https://cloud.test/api/n/cookie-list-visible", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://cloud.test",
        },
        body: JSON.stringify({ title: "Should Not Change" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(patchResponse.status, 403);
    assert.equal(env.DB.notebooks.get("cookie-list-visible")?.title, null);
  });

  it("does not use app session cookies as room WebSocket credentials", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-ws-user" });
    let roomFetches = 0;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("unexpected room fetch", { status: 500 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "cookie-ws-private");
    seedAcl(env, {
      notebookId: "cookie-ws-private",
      subject: "user:anaconda:cookie-ws-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-ws-private/sync?scope=owner", {
        headers: {
          Cookie: cookie,
          Origin: "https://cloud.test",
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.equal(roomFetches, 0);
  });

  it("clears app session cookies on logout", async () => {
    const env = fakeEnv({ NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/auth/session", {
        method: "DELETE",
        headers: { Origin: "https://cloud.test" },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    assert.match(cookie, new RegExp(`^${NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME}=`));
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
  });

  it("serves the viewer runtimed WASM asset through the Worker assets binding", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/assets/runtimed_wasm_bg.wasm"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/assets/runtimed_wasm_bg.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });

  it("serves hashed viewer runtimed WASM assets through the Worker assets binding", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/assets/runtimed_wasm_bg.0123456789abcdef.wasm"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/assets/runtimed_wasm_bg.0123456789abcdef.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });

  it("serves the viewer runtimed WASM module through the Worker assets binding", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("export default async function init() {}", {
            headers: { "Content-Type": "application/javascript" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/assets/runtimed_wasm.js"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/assets/runtimed_wasm.js"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/javascript");
  });

  it("adds CORS when plugin assets are routed through the Worker", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/plugins/sift_wasm.wasm?v=test"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/plugins/sift_wasm.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
    assert.equal(await response.text(), "wasm");
  });

  it("serves renderer sidecar assets through a Worker-owned route", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/renderer-assets/sift_wasm.wasm?v=test"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/plugins/sift_wasm.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });

  it("supports HEAD requests for Worker-owned renderer sidecars", async () => {
    const seenRequests: Array<{ method: string; pathname: string }> = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenRequests.push({
            method: request.method,
            pathname: new URL(request.url).pathname,
          });
          return new Response(null, {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/renderer-assets/sift_wasm.wasm?v=test", { method: "HEAD" }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenRequests, [{ method: "HEAD", pathname: "/plugins/sift_wasm.wasm" }]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });

  it("rejects non-read asset requests before the assets binding", async () => {
    const env = fakeEnv({
      ASSETS: {
        fetch: async () => new Response("should not be reached"),
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/renderer-assets/sift_wasm.wasm", { method: "POST" }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(await response.json(), { error: "method not allowed" });
  });

  it("rejects traversal-shaped renderer sidecar aliases before asset lookup", async () => {
    const requests = [
      "http://localhost/renderer-assets/%2e%2e%2fassets%2fnotebook-cloud-viewer.js",
      "http://localhost/renderer-assets/nested/sift_wasm.wasm",
      "http://localhost/plugins/%2e%2e%5csift_wasm.wasm",
      "http://localhost/api/plugins/nested/sift_wasm.wasm",
    ];

    for (const request of requests) {
      const env = fakeEnv({
        ASSETS: {
          fetch: async () => new Response("should not be reached"),
        },
      });

      const response = await worker.fetch(new Request(request), env, fakeContext());

      assert.equal(response.status, 404, request);
      assert.deepEqual(await response.json(), { error: "not found" }, request);
    }
  });

  it("keeps the api plugin path as a compatibility alias for older viewers", async () => {
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request: Request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("wasm", {
            headers: { "Content-Type": "application/wasm" },
          });
        },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/plugins/sift_wasm.wasm?v=test"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/plugins/sift_wasm.wasm"]);
  });

  it("does not expose prototype room event observability", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/events"),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
  });

  it("keeps anonymous viewer requests read-only on publish and upload routes", async () => {
    const env = fakeEnv({ DEPLOYMENT_ENV: "prototype" });
    const body = new TextEncoder().encode("viewer cannot write this");
    const routes = [
      {
        pathname: "/api/n/readonly-demo/runtime-snapshots/runtime-viewer",
        error: "viewer cannot publish runtime snapshots",
      },
      {
        pathname: "/api/n/readonly-demo/snapshots/heads-viewer",
        error: "viewer cannot publish snapshots",
      },
      {
        pathname: "/api/n/readonly-demo/blobs/sha256-viewer",
        error: "viewer cannot upload blobs",
      },
    ];

    for (const route of routes) {
      const response = await worker.fetch(
        new Request(
          new URL(`${route.pathname}?scope=owner&viewer_session=anon`, "https://cloud.test"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body,
          },
        ),
        env,
        fakeContext(),
      );

      assert.equal(response.status, 403, route.pathname);
      assert.deepEqual(await response.json(), { error: route.error });
    }

    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
    assert.equal(env.DB.revisions.length, 0);
  });

  it("does not expose materialized render-cache routes", async () => {
    const env = fakeEnv();
    const response = await ownerPut(
      env,
      "/api/n/readonly-demo/renders/heads-viewer",
      new TextEncoder().encode(JSON.stringify({ cells: [] })),
      {
        "Content-Type": "application/json",
      },
    );

    assert.equal(response.status, 404);
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
    assert.equal(env.DB.notebooks.size, 0);
  });

  it("keeps explicit dev viewer scope read-only even with a valid dev token", async () => {
    const env = fakeEnv({
      DEPLOYMENT_ENV: "prototype",
      NOTEBOOK_CLOUD_DEV_TOKEN: "secret-token",
    });
    const response = await worker.fetch(
      new Request("https://cloud.test/api/n/readonly-demo/blobs/sha256-viewer", {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Notebook-Cloud-Dev-Token": "secret-token",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
          "X-User": "alice",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "viewer cannot upload blobs" });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
  });

  it("keeps editor scope from uploading runtime output blobs", async () => {
    const env = fakeEnv();
    seedNotebook(env, "editor-blob-demo");
    seedAcl(env, {
      notebookId: "editor-blob-demo",
      subject: "user:dev:alice",
      scope: "editor",
    });
    const body = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(body);

    const response = await scopedPut(env, `/api/n/editor-blob-demo/blobs/${hash}`, body, {
      "X-Scope": "editor",
      "X-User": "alice",
      "X-Operator": "desktop:a",
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "editor cannot upload blobs" });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
    assert.equal(env.DB.blobs.size, 0);
  });

  it("allows no-Origin CLI Anaconda API key artifact mutations", async (t) => {
    const token = anacondaApiKeyToken();
    const env = fakeEnv(anacondaApiKeyEnv());
    const body = new Uint8Array([1, 2, 3, 4]);
    const seenAuthorizations: string[] = [];

    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seenAuthorizations.push(request.headers.get("authorization") ?? "");
      return jsonResponse(
        anacondaWhoami({
          email: "rgbkrk@gmail.com",
          firstName: "Kyle",
          lastName: "Kelley",
          userId: "fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
          scopes: ["cloud:write"],
        }),
      );
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/n/api-key-artifact-demo/runtime-snapshots/api-key", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "X-Operator": "agent:runt-publish",
          "X-Runtime-State-Doc-Id": "runtime:api-key-artifact-demo",
          "X-Scope": "owner",
        },
        body,
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      ok: true,
      key: runtimeStateSnapshotKey("runtime:api-key-artifact-demo", "api-key"),
      runtime_state_doc_id: "runtime:api-key-artifact-demo",
      size: body.byteLength,
    });
    assert.deepEqual(seenAuthorizations, [`Bearer ${token}`]);
    const accountPrincipal = await canonicalAccountPrincipalForProfile({
      provider: "anaconda-api-key",
      principalNamespace: "user:anaconda",
      email: "rgbkrk@gmail.com",
      emailVerified: true,
    });
    assert.ok(accountPrincipal);
    assert.equal(env.DB.notebooks.get("api-key-artifact-demo")?.owner_principal, accountPrincipal);
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "api-key-artifact-demo" &&
          row.subject === accountPrincipal &&
          row.scope === "owner",
      ),
      true,
    );
    assert.equal(
      env.DB.accountLinks.get("user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0")
        ?.canonical_principal,
      accountPrincipal,
    );
    const profile = env.DB.profiles.get("user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0");
    assert.deepEqual(profile, {
      principal: "user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
      provider: "anaconda-api-key",
      provider_subject: null,
      email_normalized: "rgbkrk@gmail.com",
      email_verified: 1,
      display_name: "Kyle Kelley",
      avatar_url: null,
      first_seen_at: profile?.first_seen_at,
      last_seen_at: profile?.last_seen_at,
      raw_claims_json: null,
    });
  });

  it("creates a hosted publish target with a generated notebook id", async (t) => {
    const token = anacondaApiKeyToken();
    const env = fakeEnv(anacondaApiKeyEnv());

    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          email: "rgbkrk@gmail.com",
          firstName: "Kyle",
          lastName: "Kelley",
          userId: "fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
          scopes: ["cloud:write"],
        }),
      ),
    );

    const response = await worker.fetch(
      new Request("https://cloud.test/api/n", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
          "X-Operator": "agent:runt-publish",
          "X-Scope": "owner",
        },
        body: JSON.stringify({
          vanity_name: "markdown-harness",
          source_notebook_id: "332dd3e3-b1d5-4d16-8ad6-16919b3157d1",
          source_notebook_name: "Markdown Harness",
        }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      endpoints: Record<string, string>;
      notebook_id: string;
      source_notebook_id: string;
      source_notebook_name: string;
      title: string;
      vanity_name: string;
      viewer_url: string;
    };
    assert.match(body.notebook_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(body.title, "Markdown Harness");
    assert.equal(body.vanity_name, "markdown-harness");
    assert.equal(body.source_notebook_id, "332dd3e3-b1d5-4d16-8ad6-16919b3157d1");
    assert.equal(body.source_notebook_name, "Markdown Harness");
    assert.equal(body.viewer_url, `https://cloud.test/n/${body.notebook_id}/markdown-harness`);
    assert.equal(body.endpoints.catalog, `/api/n/${body.notebook_id}`);

    const accountPrincipal = await canonicalAccountPrincipalForProfile({
      provider: "anaconda-api-key",
      principalNamespace: "user:anaconda",
      email: "rgbkrk@gmail.com",
      emailVerified: true,
    });
    assert.ok(accountPrincipal);
    assert.equal(env.DB.notebooks.get(body.notebook_id)?.owner_principal, accountPrincipal);
    assert.equal(env.DB.notebooks.get(body.notebook_id)?.title, "Markdown Harness");
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === body.notebook_id &&
          row.subject === accountPrincipal &&
          row.scope === "owner",
      ),
      true,
    );
  });

  it("uses a notebook title as the initial vanity URL when creating from the cloud home", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/api/n", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ title: "Exploration Notes" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      notebook_id: string;
      title: string;
      vanity_name: string | null;
      viewer_url: string;
    };
    assert.equal(body.title, "Exploration Notes");
    assert.equal(body.vanity_name, null);
    assert.equal(env.DB.notebooks.get(body.notebook_id)?.title, "Exploration Notes");
    assert.equal(body.viewer_url, `http://localhost/n/${body.notebook_id}/Exploration%20Notes`);
  });

  it("renames notebook titles for editors", async () => {
    const env = fakeEnv();
    seedNotebook(env, "rename-demo");
    seedAcl(env, { notebookId: "rename-demo", subject: "user:dev:alice", scope: "editor" });

    const response = await worker.fetch(
      new Request("http://localhost/api/n/rename-demo", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "editor",
          "X-User": "alice",
        },
        body: JSON.stringify({ title: "Renamed Notebook" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      notebook_id: string;
      ok: boolean;
      title: string | null;
      updated_at: string;
      viewer_url: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.notebook_id, "rename-demo");
    assert.equal(body.title, "Renamed Notebook");
    assert.equal(env.DB.notebooks.get("rename-demo")?.title, "Renamed Notebook");
    assert.equal(env.DB.notebooks.get("rename-demo")?.updated_at, body.updated_at);
    assert.equal(body.viewer_url, "http://localhost/n/rename-demo/Renamed%20Notebook");
  });

  it("rejects notebook title updates from viewers", async () => {
    const env = fakeEnv();
    seedNotebook(env, "viewer-rename-demo");
    seedAcl(env, {
      notebookId: "viewer-rename-demo",
      subject: "user:dev:alice",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/n/viewer-rename-demo", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "viewer",
          "X-User": "alice",
        },
        body: JSON.stringify({ title: "Not Allowed" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.equal(env.DB.notebooks.get("viewer-rename-demo")?.title, null);
  });

  it("lists notebooks visible to the authenticated principal", async () => {
    const env = fakeEnv();
    seedNotebook(env, "old-owned");
    seedNotebook(env, "new-owned");
    seedNotebook(env, "editor-shared");
    seedNotebook(env, "hidden");
    const newOwned = env.DB.notebooks.get("new-owned");
    const editorShared = env.DB.notebooks.get("editor-shared");
    assert.ok(newOwned);
    assert.ok(editorShared);
    newOwned.updated_at = "2026-05-24T00:00:00.000Z";
    editorShared.title = "Editor Shared";
    editorShared.updated_at = "2026-05-23T00:00:00.000Z";
    seedAcl(env, { notebookId: "old-owned", subject: "user:dev:alice", scope: "viewer" });
    seedAcl(env, { notebookId: "old-owned", subject: "user:dev:alice", scope: "owner" });
    seedAcl(env, { notebookId: "new-owned", subject: "user:dev:alice", scope: "owner" });
    seedAcl(env, { notebookId: "editor-shared", subject: "user:dev:alice", scope: "editor" });
    seedAcl(env, { notebookId: "hidden", subject: "user:dev:bob", scope: "owner" });

    const response = await worker.fetch(
      new Request("http://localhost/api/n?limit=2", {
        headers: {
          "X-User": "alice",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      notebooks: Array<{
        endpoints: Record<string, string>;
        notebook_id: string;
        scope: NotebookAclRow["scope"];
        title: string | null;
        viewer_url: string;
      }>;
      ok: boolean;
    };
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.notebooks.map((notebook) => [notebook.notebook_id, notebook.scope]),
      [
        ["new-owned", "owner"],
        ["editor-shared", "editor"],
      ],
    );
    assert.equal(body.notebooks[1]?.title, "Editor Shared");
    assert.equal(body.notebooks[1]?.viewer_url, "http://localhost/n/editor-shared/Editor%20Shared");
    assert.equal(body.notebooks[1]?.endpoints.catalog, "/api/n/editor-shared");
  });

  it("requires sign-in before listing notebooks", async () => {
    const env = fakeEnv();
    seedNotebook(env, "public-demo");
    seedAcl(env, {
      notebookId: "public-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/n?viewer_session=anon-a"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "sign in to list notebooks" });
  });

  it("registers and lists user-owned workstations", async () => {
    const env = fakeEnv();

    const register = await worker.fetch(
      new Request("http://localhost/api/workstations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({
          workstation_id: "ws-lab2",
          display_name: "Lab2",
          provider: "runtime_peer",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          working_directory: "/home/ubuntu/project",
          cpu_count: 8,
          memory_bytes: 16_000_000_000,
          environments: [
            {
              id: "current-python",
              label: "Current Python",
              policy: "current_python",
              is_default: true,
            },
          ],
        }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(register.status, 201);
    const registered = (await register.json()) as {
      workstation: Record<string, unknown>;
    };
    assert.equal(registered.workstation.workstation_id, "ws-lab2");
    assert.equal(registered.workstation.status, "online");
    assert.doesNotMatch(JSON.stringify(registered), /secret|token/i);

    const list = await worker.fetch(
      new Request("http://localhost/api/workstations", {
        headers: {
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(list.status, 200);
    const body = (await list.json()) as {
      default_workstation_id: string | null;
      workstations: Array<Record<string, unknown>>;
    };
    assert.equal(body.default_workstation_id, null);
    assert.equal(body.workstations.length, 1);
    assert.equal(body.workstations[0]?.display_name, "Lab2");
    assert.equal(body.workstations[0]?.is_default, false);
  });

  it("lets users select a default workstation", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/default", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab2" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      default_workstation_id: "ws-lab2",
    });
    assert.equal(env.DB.workstationDefaults.get("user:dev:alice"), "ws-lab2");
  });

  it("does not let users select another principal's workstation as their default", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:bob", workstationId: "ws-lab2" });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/default", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab2" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "workstation not found" });
    assert.equal(env.DB.workstationDefaults.get("user:dev:alice"), undefined);
  });

  it("creates workstation attach jobs through notebook owner authority", async () => {
    const env = fakeEnv();
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    env.DB.workstationDefaults.set("user:dev:alice", "ws-lab2");

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({}),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as {
      job: { job_id: string; notebook_id: string; status: string };
    };
    assert.equal(body.job.notebook_id, "attach-demo");
    assert.equal(body.job.status, "pending");
    assert.equal(env.DB.workstationAttachJobs.get(body.job.job_id)?.workstation_id, "ws-lab2");
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "attach-demo" &&
          row.subject === "user:dev:alice" &&
          row.scope === "runtime_peer",
      ),
      true,
    );

    const poll = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs", {
        headers: {
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(poll.status, 200);
    const polled = (await poll.json()) as { jobs: Array<{ job_id: string }> };
    assert.deepEqual(
      polled.jobs.map((job) => job.job_id),
      [body.job.job_id],
    );
  });

  it("does not attach another principal's workstation to an owned notebook", async () => {
    const env = fakeEnv();
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:bob", workstationId: "ws-lab2" });

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab2" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 404);
    assert.deepEqual(await attach.json(), { error: "workstation not found" });
    assert.equal(env.DB.workstationAttachJobs.size, 0);
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "attach-demo" &&
          row.subject === "user:dev:alice" &&
          row.scope === "runtime_peer",
      ),
      false,
    );
  });

  it("reuses the active workstation attach job for repeated owner requests", async () => {
    const env = fakeEnv();
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });

    async function attach() {
      return worker.fetch(
        new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Operator": "browser:tab",
            "X-Scope": "owner",
            "X-User": "alice",
          },
          body: JSON.stringify({ workstation_id: "ws-lab2" }),
        }),
        env,
        fakeContext(),
      );
    }

    const first = await attach();
    const second = await attach();

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const firstBody = (await first.json()) as { job: { job_id: string } };
    const secondBody = (await second.json()) as { job: { job_id: string } };
    assert.equal(secondBody.job.job_id, firstBody.job.job_id);
    assert.equal(env.DB.workstationAttachJobs.size, 1);
  });

  it("only lists attach jobs for the authenticated workstation owner", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:bob", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-alice",
      notebookId: "nb-alice",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
    });
    seedWorkstationAttachJob(env, {
      id: "job-bob",
      notebookId: "nb-bob",
      ownerPrincipal: "user:dev:bob",
      workstationId: "ws-lab2",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs", {
        headers: {
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { jobs: Array<{ job_id: string }> };
    assert.deepEqual(
      body.jobs.map((job) => job.job_id),
      ["job-alice"],
    );
  });

  it("allows workstation owners to update attach job status", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-1",
      notebookId: "nb-1",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs/job-1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ status: "running" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { job: { job_id: string; status: string } };
    assert.deepEqual(body.job, {
      job_id: "job-1",
      notebook_id: "nb-1",
      workstation_id: "ws-lab2",
      status: "running",
      requested_at: "2026-05-22T00:00:00.000Z",
      updated_at: env.DB.workstationAttachJobs.get("job-1")?.updated_at,
      accepted_at: env.DB.workstationAttachJobs.get("job-1")?.accepted_at,
      finished_at: null,
      error_message: null,
      runtime_peer: {
        cloud_url: "http://localhost",
        notebook_id: "nb-1",
        scope: "runtime_peer",
      },
    });
    assert.equal(env.DB.workstationAttachJobs.get("job-1")?.status, "running");
    assert.ok(env.DB.workstationAttachJobs.get("job-1")?.accepted_at);
  });

  it("does not let workstation owners update another principal's attach job", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:bob", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-bob",
      notebookId: "nb-bob",
      ownerPrincipal: "user:dev:bob",
      workstationId: "ws-lab2",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs/job-bob", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ status: "running" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "workstation attach job not found" });
    assert.equal(env.DB.workstationAttachJobs.get("job-bob")?.status, "pending");
  });

  it("lists notebooks through canonical Anaconda account ACLs", async (t) => {
    const token = anacondaApiKeyToken({ jti: "list-notebooks-canonical-account" });
    const env = fakeEnv(anacondaApiKeyEnv());
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          email: "rgbkrk@gmail.com",
          firstName: "Kyle",
          lastName: "Kelley",
          userId: "fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
          scopes: ["cloud:read"],
        }),
      ),
    );
    const accountPrincipal = await canonicalAccountPrincipalForProfile({
      provider: "anaconda-api-key",
      principalNamespace: "user:anaconda",
      email: "rgbkrk@gmail.com",
      emailVerified: true,
    });
    assert.ok(accountPrincipal);
    seedNotebook(env, "canonical-list-demo");
    const notebook = env.DB.notebooks.get("canonical-list-demo");
    assert.ok(notebook);
    notebook.owner_principal = accountPrincipal;
    seedAcl(env, {
      notebookId: "canonical-list-demo",
      subject: accountPrincipal,
      scope: "owner",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/n", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
          "X-Operator": "browser:tab",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      notebooks: Array<{ notebook_id: string; scope: NotebookAclRow["scope"] }>;
    };
    assert.deepEqual(
      body.notebooks.map((listedNotebook) => [listedNotebook.notebook_id, listedNotebook.scope]),
      [["canonical-list-demo", "owner"]],
    );
    assert.equal(
      env.DB.accountLinks.get("user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0")
        ?.canonical_principal,
      accountPrincipal,
    );
  });

  it("rejects viewer publish target creation", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/api/n", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
          "X-User": "alice",
        },
        body: JSON.stringify({ vanity_name: "readonly" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "viewer cannot create notebooks" });
    assert.equal(env.DB.notebooks.size, 0);
  });

  it("authorizes OIDC and API-key transports through one canonical account ACL", async (t) => {
    const apiKeyToken = anacondaApiKeyToken();
    const { env: oidcEnv, token: oidcToken } = await oidcTokenFixture({
      subject: "fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      email: "rgbkrk@gmail.com",
      extraPayload: { email_verified: true },
      name: "Kyle Kelley",
    });
    const env = fakeEnv({
      ...oidcEnv,
      ...anacondaApiKeyEnv(),
    });

    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          email: "rgbkrk@gmail.com",
          firstName: "Kyle",
          lastName: "Kelley",
          userId: "fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
          scopes: ["cloud:write"],
        }),
      ),
    );

    const publish = await worker.fetch(
      new Request("https://cloud.test/api/n/canonical-account-demo/runtime-snapshots/api-key", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKeyToken}`,
          "Content-Type": "application/octet-stream",
          "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
          "X-Operator": "agent:runt-publish",
          "X-Runtime-State-Doc-Id": "runtime:canonical-account-demo",
          "X-Scope": "owner",
        },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      env,
      fakeContext(),
    );
    assert.equal(publish.status, 201);

    const accountPrincipal = await canonicalAccountPrincipalForProfile({
      provider: "oidc",
      principalNamespace: "user:anaconda",
      email: "rgbkrk@gmail.com",
      emailVerified: true,
    });
    assert.ok(accountPrincipal);
    const acl = await worker.fetch(
      new Request("https://cloud.test/api/n/canonical-account-demo/acl?scope=owner", {
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          "X-Operator": "browser:tab",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(acl.status, 200);
    const body = (await acl.json()) as { acl: NotebookAclRow[] };
    assert.deepEqual(
      body.acl.map((row) => [row.subject, row.scope]),
      [[accountPrincipal, "owner"]],
    );
    assert.equal(
      env.DB.accountLinks.get("user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0")
        ?.canonical_principal,
      accountPrincipal,
    );
    assert.equal(
      env.DB.accountLinks.get("user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375")
        ?.canonical_principal,
      accountPrincipal,
    );
  });

  it("requires RuntimeStateDoc ids for snapshot publishes", async () => {
    const env = fakeEnv();
    const body = new Uint8Array([1, 2, 3, 4]);

    const runtimePut = await ownerPut(
      env,
      "/api/n/runtime-id-required/runtime-snapshots/runtime-heads",
      body,
    );
    assert.equal(runtimePut.status, 400);
    assert.deepEqual(await runtimePut.json(), {
      error: "X-Runtime-State-Doc-Id header is required",
    });

    const notebookPut = await ownerPut(env, "/api/n/runtime-id-required/snapshots/heads", body);
    assert.equal(notebookPut.status, 400);
    assert.deepEqual(await notebookPut.json(), {
      error: "X-Runtime-State-Doc-Id header is required",
    });

    const notebookPutWithoutRuntimeHeads = await ownerPut(
      env,
      "/api/n/runtime-id-required/snapshots/heads",
      body,
      {
        "X-Runtime-State-Doc-Id": "runtime:runtime-id-required",
      },
    );
    assert.equal(notebookPutWithoutRuntimeHeads.status, 400);
    assert.deepEqual(await notebookPutWithoutRuntimeHeads.json(), {
      error: "X-Runtime-Heads-Hash header is required",
    });

    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.size, 0);
    assert.equal(env.DB.revisions.length, 0);
  });

  it("requires RuntimeStateDoc ids when reading runtime snapshots", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-read-demo");
    seedAcl(env, {
      notebookId: "runtime-read-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/n/runtime-read-demo/runtime-snapshots/runtime-heads", {
        headers: {
          "X-Operator": "desktop:test",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "X-Runtime-State-Doc-Id header is required",
    });
  });

  it("serves runtime snapshots from the RuntimeStateDoc namespace", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-read-demo");
    seedAcl(env, {
      notebookId: "runtime-read-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    const body = new Uint8Array([1, 2, 3, 4]);
    const key = runtimeStateSnapshotKey("runtime:runtime-read-demo", "runtime-heads");
    await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        artifact: "runtime-state-snapshot",
        notebook_id: "runtime-read-demo",
        runtime_heads_hash: "runtime-heads",
        runtime_state_doc_id: "runtime:runtime-read-demo",
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/n/runtime-read-demo/runtime-snapshots/runtime-heads", {
        headers: {
          "X-Operator": "desktop:test",
          "X-Runtime-State-Doc-Id": "runtime:runtime-read-demo",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  });

  it("does not serve runtime snapshots owned by another notebook", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-read-demo");
    seedAcl(env, {
      notebookId: "runtime-read-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(
      runtimeStateSnapshotKey("runtime:other-demo", "runtime-heads"),
      new Uint8Array([1, 2, 3, 4]),
      {
        customMetadata: {
          artifact: "runtime-state-snapshot",
          notebook_id: "other-demo",
          runtime_heads_hash: "runtime-heads",
          runtime_state_doc_id: "runtime:other-demo",
        },
      },
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/n/runtime-read-demo/runtime-snapshots/runtime-heads", {
        headers: {
          "X-Operator": "desktop:test",
          "X-Runtime-State-Doc-Id": "runtime:other-demo",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "runtime snapshot not found" });
  });

  it("does not replace runtime snapshots owned by another notebook", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-write-demo");
    seedAcl(env, {
      notebookId: "runtime-write-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(
      runtimeStateSnapshotKey("runtime:other-demo", "runtime-heads"),
      new Uint8Array([1, 2, 3, 4]),
      {
        customMetadata: {
          artifact: "runtime-state-snapshot",
          notebook_id: "other-demo",
          runtime_heads_hash: "runtime-heads",
          runtime_state_doc_id: "runtime:other-demo",
        },
      },
    );

    const response = await ownerPut(
      env,
      "/api/n/runtime-write-demo/runtime-snapshots/runtime-heads",
      new Uint8Array([5, 6, 7, 8]),
      {
        "X-Runtime-State-Doc-Id": "runtime:other-demo",
      },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "runtime snapshot belongs to another notebook",
    });
  });

  it("allows runtime peers to upload content-addressed output blobs", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-demo");
    seedAcl(env, {
      notebookId: "runtime-demo",
      subject: "user:dev:runtime-service",
      scope: "runtime_peer",
    });
    const body = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(body);

    const response = await scopedPut(env, `/api/n/runtime-demo/blobs/${hash}`, body, {
      "Content-Type": "application/vnd.apache.arrow.stream",
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      ok: true,
      key: blobKey("runtime-demo", hash),
      size: body.byteLength,
    });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.has(blobKey("runtime-demo", hash)), true);
    assert.deepEqual(env.DB.blobs.get(`runtime-demo:${hash}`), {
      notebook_id: "runtime-demo",
      hash,
      size: body.byteLength,
      content_type: "application/vnd.apache.arrow.stream",
      r2_key: blobKey("runtime-demo", hash),
      uploaded_at: env.DB.blobs.get(`runtime-demo:${hash}`)?.uploaded_at,
    });
  });

  it("caches authorized immutable blob reads at the Worker edge", async () => {
    const env = fakeEnv();
    seedNotebook(env, "blob-cache-demo");
    seedAcl(env, {
      notebookId: "blob-cache-demo",
      subject: "user:dev:alice",
      scope: "viewer",
    });
    const body = new Uint8Array([9, 8, 7, 6]);
    const hash = await sha256Hex(body);
    const key = blobKey("blob-cache-demo", hash);
    await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType: "application/vnd.apache.arrow.stream" },
    });
    const storedResponses = new Map<string, Response>();
    const restoreCaches = installGlobalCaches({
      default: {
        async match(request: Request) {
          return storedResponses.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          storedResponses.set(request.url, response.clone());
        },
      } as unknown as Cache,
    });
    const waitUntilPromises: Promise<unknown>[] = [];

    try {
      const first = await blobGet(
        env,
        `/api/n/blob-cache-demo/blobs/${hash}?viewer_session=first`,
        fakeContextWithWaitUntil(waitUntilPromises),
      );
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("X-Notebook-Cloud-Blob-Cache"), "miss");
      assert.deepEqual(new Uint8Array(await first.arrayBuffer()), body);
      await Promise.all(waitUntilPromises);

      const second = await blobGet(
        env,
        `/api/n/blob-cache-demo/blobs/${hash}?viewer_session=second`,
      );
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("X-Notebook-Cloud-Blob-Cache"), "hit");
      assert.deepEqual(new Uint8Array(await second.arrayBuffer()), body);
      assert.deepEqual(env.NOTEBOOK_SNAPSHOTS.getKeys, [key]);

      const anonymous = await worker.fetch(
        new Request(
          new URL(
            `/api/n/blob-cache-demo/blobs/${hash}?viewer_session=anonymous`,
            "http://localhost",
          ),
        ),
        env,
        fakeContext(),
      );
      assert.equal(anonymous.status, 404);
      assert.deepEqual(env.NOTEBOOK_SNAPSHOTS.getKeys, [key]);
    } finally {
      restoreCaches();
    }
  });

  it("falls back to R2 when the Worker edge cache match fails", async () => {
    const env = fakeEnv();
    seedNotebook(env, "blob-cache-fallback-demo");
    seedAcl(env, {
      notebookId: "blob-cache-fallback-demo",
      subject: "user:dev:alice",
      scope: "viewer",
    });
    const body = new Uint8Array([1, 3, 3, 7]);
    const hash = await sha256Hex(body);
    const key = blobKey("blob-cache-fallback-demo", hash);
    await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const restoreCaches = installGlobalCaches({
      default: {
        async match() {
          throw new Error("cache unavailable");
        },
        async put() {
          return undefined;
        },
      } as unknown as Cache,
    });
    const waitUntilPromises: Promise<unknown>[] = [];

    try {
      const response = await blobGet(
        env,
        `/api/n/blob-cache-fallback-demo/blobs/${hash}`,
        fakeContextWithWaitUntil(waitUntilPromises),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Notebook-Cloud-Blob-Cache"), "miss");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
      await Promise.all(waitUntilPromises);
      assert.deepEqual(env.NOTEBOOK_SNAPSHOTS.getKeys, [key]);
    } finally {
      restoreCaches();
    }
  });

  it("rejects blob uploads whose path hash does not match the bytes", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-demo");
    seedAcl(env, {
      notebookId: "runtime-demo",
      subject: "user:dev:runtime-service",
      scope: "runtime_peer",
    });
    const body = new Uint8Array([1, 2, 3, 4]);
    const actual = await sha256Hex(body);
    const expected = "0".repeat(64);

    const response = await scopedPut(env, `/api/n/runtime-demo/blobs/${expected}`, body, {
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "blob hash mismatch",
      expected,
      actual,
    });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.has(blobKey("runtime-demo", expected)), false);
    assert.equal(env.DB.blobs.size, 0);
    assert.equal(env.DB.notebooks.has("runtime-demo"), true);
  });

  it("keeps unpublished notebooks private to anonymous readers", async () => {
    const env = fakeEnv({ DEPLOYMENT_ENV: "prototype" });
    seedNotebook(env, "private-demo");

    const response = await worker.fetch(
      new Request("https://cloud.test/api/n/private-demo"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "notebook not found" });
  });

  it("lets authenticated principals read through public viewer ACL rows", async () => {
    const env = fakeEnv();
    seedNotebook(env, "public-demo");
    seedAcl(env, {
      notebookId: "public-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const anonymous = await worker.fetch(
      new Request("http://localhost/api/n/public-demo?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    assert.equal(anonymous.status, 200);

    const authenticated = await worker.fetch(
      new Request("http://localhost/api/n/public-demo?user=bob&operator=desktop:b&scope=viewer"),
      env,
      fakeContext(),
    );
    assert.equal(authenticated.status, 200);

    const ownerRoute = await worker.fetch(
      new Request("http://localhost/api/n/public-demo/acl?user=bob&operator=desktop:b&scope=owner"),
      env,
      fakeContext(),
    );
    assert.equal(ownerRoute.status, 403);
  });

  it("keeps sharing identity data behind owner-only routes for public viewers", async () => {
    const env = fakeEnv();
    seedNotebook(env, "public-sharing-demo");
    seedAcl(env, {
      notebookId: "public-sharing-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "public-sharing-demo",
      subject: "user:dev:bob",
      scope: "editor",
    });
    seedAcl(env, {
      notebookId: "public-sharing-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    seedPendingInvite(env, {
      id: "invite-private-email",
      notebookId: "public-sharing-demo",
      email: "carol@example.com",
      providerHint: "oidc",
      scope: "editor",
    });
    seedAccessRequest(env, {
      id: "request-private-profile",
      notebookId: "public-sharing-demo",
      requesterPrincipal: "user:dev:bob",
      status: "pending",
    });
    env.DB.profiles.set("user:dev:bob", {
      principal: "user:dev:bob",
      provider: "dev",
      provider_subject: "bob",
      email_normalized: "bob@example.com",
      email_verified: 1,
      display_name: "Bob Example",
      avatar_url: null,
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
      raw_claims_json: null,
    });

    const catalog = await worker.fetch(
      new Request("http://localhost/api/n/public-sharing-demo?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    assert.equal(catalog.status, 200);

    const acl = await worker.fetch(
      new Request("http://localhost/api/n/public-sharing-demo/acl?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    const invites = await worker.fetch(
      new Request("http://localhost/api/n/public-sharing-demo/invites?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    const accessRequests = await worker.fetch(
      new Request(
        "http://localhost/api/n/public-sharing-demo/access-requests?viewer_session=anon-a",
      ),
      env,
      fakeContext(),
    );

    assert.equal(acl.status, 403);
    assert.equal(invites.status, 403);
    assert.equal(accessRequests.status, 401);
    assert.doesNotMatch(await acl.text(), /bob@example\.com|carol@example\.com/);
    assert.doesNotMatch(await invites.text(), /bob@example\.com|carol@example\.com/);
    assert.doesNotMatch(await accessRequests.text(), /bob@example\.com|carol@example\.com/);
  });

  it("lets owners inspect and grant principal ACL rows", async () => {
    const env = fakeEnv();
    seedNotebook(env, "acl-demo");
    seedAcl(env, {
      notebookId: "acl-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });

    const before = await aclRequest(env, "GET", undefined);
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { notebook_id: string; acl: NotebookAclRow[] };
    assert.equal(beforeBody.notebook_id, "acl-demo");
    assert.deepEqual(
      beforeBody.acl.map((row) => [row.subject_kind, row.subject, row.scope]),
      [["principal", "user:dev:alice", "owner"]],
    );

    const grant = await aclRequest(env, "POST", {
      subject_kind: "principal",
      subject: "user:dev:bob",
      scope: "editor",
    });
    assert.equal(grant.status, 201);
    assert.deepEqual(
      (await getNotebookAclRowsForPrincipal(env, "acl-demo", "user:dev:bob")).map(
        (row) => row.scope,
      ),
      ["editor"],
    );

    const bobCatalog = await worker.fetch(
      new Request("http://localhost/api/n/acl-demo?user=bob&operator=desktop:b&scope=editor"),
      env,
      fakeContext(),
    );
    assert.equal(bobCatalog.status, 200);
  });

  it("lets owners grant and revoke explicit public viewer ACL rows", async () => {
    const env = fakeEnv();
    seedNotebook(env, "public-acl-demo");
    seedAcl(env, {
      notebookId: "public-acl-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });

    const hidden = await worker.fetch(
      new Request("http://localhost/api/n/public-acl-demo?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    assert.equal(hidden.status, 404);

    const grant = await aclRequest(
      env,
      "POST",
      {
        subject_kind: "public",
        subject: "anonymous",
        scope: "viewer",
      },
      "public-acl-demo",
    );
    assert.equal(grant.status, 201);

    const visible = await worker.fetch(
      new Request("http://localhost/api/n/public-acl-demo?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    assert.equal(visible.status, 200);

    const revoke = await aclRequest(
      env,
      "DELETE",
      {
        subject_kind: "public",
        subject: "anonymous",
        scope: "viewer",
      },
      "public-acl-demo",
    );
    assert.equal(revoke.status, 200);

    const hiddenAgain = await worker.fetch(
      new Request("http://localhost/api/n/public-acl-demo?viewer_session=anon-a"),
      env,
      fakeContext(),
    );
    assert.equal(hiddenAgain.status, 404);
  });

  it("returns display metadata for ACL sharing rows", async () => {
    const env = fakeEnv();
    seedNotebook(env, "acl-display-demo");
    seedAcl(env, {
      notebookId: "acl-display-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "acl-display-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    env.DB.profiles.set("user:dev:alice", {
      principal: "user:dev:alice",
      provider: "dev",
      provider_subject: "alice",
      email_normalized: "alice@example.com",
      email_verified: 1,
      display_name: "Alice Example",
      avatar_url: null,
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
      raw_claims_json: null,
    });

    const response = await aclRequest(env, "GET", undefined, "acl-display-demo");

    assert.equal(response.status, 200);
    const body = (await response.json()) as { acl: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.acl.map((row) => row.display),
      [
        {
          kind: "principal",
          label: "Alice Example",
          principal: "user:dev:alice",
          email: "alice@example.com",
        },
        {
          kind: "public_viewer",
          label: "Anyone with the link",
        },
      ],
    );
  });

  it("keeps ACL management owner-only and public grants viewer-only", async () => {
    const env = fakeEnv();
    seedNotebook(env, "acl-private-demo");
    seedAcl(env, {
      notebookId: "acl-private-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "acl-private-demo",
      subject: "user:dev:bob",
      scope: "editor",
    });

    const bobGrant = await aclRequest(
      env,
      "POST",
      {
        subject_kind: "principal",
        subject: "user:dev:mallory",
        scope: "viewer",
      },
      "acl-private-demo",
      {
        "X-User": "bob",
        "X-Scope": "editor",
      },
    );
    assert.equal(bobGrant.status, 403);

    const publicEditor = await aclRequest(
      env,
      "POST",
      {
        subject_kind: "public",
        subject: "anonymous",
        scope: "editor",
      },
      "acl-private-demo",
    );
    assert.equal(publicEditor.status, 400);
    assert.deepEqual(await publicEditor.json(), {
      error: "public ACL rows may only grant viewer scope",
    });
  });

  it("lets authenticated viewers create owner-visible edit access requests", async () => {
    const env = fakeEnv();
    seedNotebook(env, "access-request-demo");
    seedAcl(env, {
      notebookId: "access-request-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "access-request-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    env.DB.profiles.set("user:dev:bob", {
      principal: "user:dev:bob",
      provider: "dev",
      provider_subject: "bob",
      email_normalized: "bob@example.com",
      email_verified: 1,
      display_name: "Bob Example",
      avatar_url: null,
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
      raw_claims_json: null,
    });

    const create = await accessRequestsRequest(env, "POST", "access-request-demo", undefined, {
      "X-User": "bob",
      "X-Operator": "browser:tab",
      "X-Scope": "viewer",
    });

    assert.equal(create.status, 201);
    assert.equal(env.DB.accessRequests.size, 1);
    const createBody = (await create.json()) as {
      access_status: string;
      access_request: { status: string; requester_principal: string };
    };
    assert.equal(createBody.access_status, "pending");
    assert.equal(createBody.access_request.status, "pending");
    assert.equal(createBody.access_request.requester_principal, "user:dev:bob");

    const duplicate = await accessRequestsRequest(env, "POST", "access-request-demo", undefined, {
      "X-User": "bob",
      "X-Operator": "browser:tab",
      "X-Scope": "viewer",
    });
    assert.equal(duplicate.status, 200);
    assert.equal(env.DB.accessRequests.size, 1);

    const ownerList = await accessRequestsRequest(env, "GET", "access-request-demo");
    assert.equal(ownerList.status, 200);
    const ownerBody = (await ownerList.json()) as {
      access_requests: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      ownerBody.access_requests.map((row) => [row.status, row.display]),
      [
        [
          "pending",
          {
            kind: "principal",
            label: "Bob Example",
            principal: "user:dev:bob",
            email: "bob@example.com",
          },
        ],
      ],
    );
  });

  it("lets owners approve edit access requests through the ACL path", async () => {
    const env = fakeEnv();
    seedNotebook(env, "access-approve-demo");
    seedAcl(env, {
      notebookId: "access-approve-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAccessRequest(env, {
      id: "request-bob",
      notebookId: "access-approve-demo",
      requesterPrincipal: "user:dev:bob",
      status: "pending",
    });

    const approve = await accessRequestItemRequest(
      env,
      "POST",
      "access-approve-demo",
      "request-bob",
      "approve",
    );

    assert.equal(approve.status, 200);
    assert.equal(env.DB.accessRequests.get("request-bob")?.status, "approved");
    assert.equal(env.DB.batchSizes.at(-1), 2);
    assert.deepEqual(
      (await getNotebookAclRowsForPrincipal(env, "access-approve-demo", "user:dev:bob")).map(
        (row) => row.scope,
      ),
      ["editor"],
    );
  });

  it("lets owners deny edit access requests without granting ACL rows", async () => {
    const env = fakeEnv();
    seedNotebook(env, "access-deny-demo");
    seedAcl(env, {
      notebookId: "access-deny-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAccessRequest(env, {
      id: "request-bob-denied",
      notebookId: "access-deny-demo",
      requesterPrincipal: "user:dev:bob",
      status: "pending",
    });

    const deny = await accessRequestItemRequest(
      env,
      "POST",
      "access-deny-demo",
      "request-bob-denied",
      "deny",
    );

    assert.equal(deny.status, 200);
    assert.equal(env.DB.accessRequests.get("request-bob-denied")?.status, "denied");
    assert.deepEqual(
      (await getNotebookAclRowsForPrincipal(env, "access-deny-demo", "user:dev:bob")).map(
        (row) => row.scope,
      ),
      [],
    );
  });

  it("does not revoke pending invites through another notebook route", async () => {
    const env = fakeEnv();
    seedNotebook(env, "invite-demo-a");
    seedNotebook(env, "invite-demo-b");
    seedAcl(env, {
      notebookId: "invite-demo-a",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "invite-demo-b",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedPendingInvite(env, {
      id: "invite-b",
      notebookId: "invite-demo-b",
      email: "bob@example.com",
      providerHint: "oidc",
      scope: "editor",
    });

    const revoke = await inviteItemRequest(env, "DELETE", "invite-b", "invite-demo-a");

    assert.equal(revoke.status, 404);
    assert.deepEqual(await revoke.json(), { error: "pending invite not found" });
    assert.equal(env.DB.invites.get("invite-b")?.status, "pending");
  });

  it("keeps invite management owner-only and scope-limited", async () => {
    const env = fakeEnv();
    seedNotebook(env, "invite-private-demo");
    seedAcl(env, {
      notebookId: "invite-private-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "invite-private-demo",
      subject: "user:dev:bob",
      scope: "editor",
    });

    const bobCreate = await inviteRequest(
      env,
      "POST",
      {
        email: "mallory@example.com",
        scope: "viewer",
      },
      "invite-private-demo",
      {
        "X-User": "bob",
        "X-Scope": "editor",
      },
    );
    assert.equal(bobCreate.status, 403);

    const ownerInvite = await inviteRequest(
      env,
      "POST",
      {
        email: "new-owner@example.com",
        scope: "owner",
      },
      "invite-private-demo",
    );
    assert.equal(ownerInvite.status, 400);
    assert.deepEqual(await ownerInvite.json(), {
      error: "invite scope must be viewer or editor",
    });

    const invalidEmail = await inviteRequest(
      env,
      "POST",
      {
        email: "not an email",
        scope: "viewer",
      },
      "invite-private-demo",
    );
    assert.equal(invalidEmail.status, 400);
    assert.deepEqual(await invalidEmail.json(), { error: "invite email is invalid" });

    const invalidProvider = await inviteRequest(
      env,
      "POST",
      {
        email: "viewer@example.com",
        provider_hint: "bad/provider",
        scope: "viewer",
      },
      "invite-private-demo",
    );
    assert.equal(invalidProvider.status, 400);
    assert.deepEqual(await invalidProvider.json(), { error: "invite provider hint is invalid" });

    const expiredInvite = await inviteRequest(
      env,
      "POST",
      {
        email: "expired@example.com",
        scope: "viewer",
        expires_at: "2000-01-01T00:00:00.000Z",
      },
      "invite-private-demo",
    );
    assert.equal(expiredInvite.status, 400);
    assert.deepEqual(await expiredInvite.json(), {
      error: "invite expiry must be in the future",
    });
  });

  it("rejects deleting the last owner ACL row", async () => {
    const env = fakeEnv();
    seedNotebook(env, "last-owner-demo");
    seedAcl(env, {
      notebookId: "last-owner-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });

    const response = await aclRequest(
      env,
      "DELETE",
      {
        subject_kind: "principal",
        subject: "user:dev:alice",
        scope: "owner",
      },
      "last-owner-demo",
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "cannot remove the last owner ACL row" });
    assert.equal((await getNotebookAclRows(env, "last-owner-demo")).length, 1);
  });

  it("does not report success when a guarded owner delete leaves the row present", async () => {
    const env = fakeEnv();
    seedNotebook(env, "owner-delete-race-demo");
    seedAcl(env, {
      notebookId: "owner-delete-race-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    env.DB.afterBlockedOwnerDelete = () => {
      seedAcl(env, {
        notebookId: "owner-delete-race-demo",
        subject: "user:dev:bob",
        scope: "owner",
      });
    };

    const response = await aclRequest(
      env,
      "DELETE",
      {
        subject_kind: "principal",
        subject: "user:dev:alice",
        scope: "owner",
      },
      "owner-delete-race-demo",
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "owner ACL row was not removed; retry the request",
    });
    assert.deepEqual(
      (await getNotebookAclRows(env, "owner-delete-race-demo")).map((row) => row.subject).sort(),
      ["user:dev:alice", "user:dev:bob"],
    );
  });

  it("allows owner revocation only while another owner row remains", async () => {
    const env = fakeEnv();
    seedNotebook(env, "two-owner-demo");
    seedAcl(env, {
      notebookId: "two-owner-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "two-owner-demo",
      subject: "user:dev:bob",
      scope: "owner",
    });

    const removeBob = await aclRequest(
      env,
      "DELETE",
      {
        subject_kind: "principal",
        subject: "user:dev:bob",
        scope: "owner",
      },
      "two-owner-demo",
    );
    assert.equal(removeBob.status, 200);
    assert.deepEqual(
      (await getNotebookAclRows(env, "two-owner-demo")).map((row) => row.subject),
      ["user:dev:alice"],
    );

    const removeAlice = await aclRequest(
      env,
      "DELETE",
      {
        subject_kind: "principal",
        subject: "user:dev:alice",
        scope: "owner",
      },
      "two-owner-demo",
    );
    assert.equal(removeAlice.status, 409);
    assert.deepEqual(await removeAlice.json(), { error: "cannot remove the last owner ACL row" });
  });

  it("does not grant owner ACL to a principal that loses notebook creation", async () => {
    const env = fakeEnv();
    const alice = authenticateDevRequest(
      new Request("http://localhost/n/race-demo/sync?user=alice&operator=desktop:a&scope=owner"),
    );
    const bob = authenticateDevRequest(
      new Request("http://localhost/n/race-demo/sync?user=bob&operator=desktop:b&scope=owner"),
    );

    const aliceCreate = await createNotebookWithOwnerAcl(env, "race-demo", alice);
    const bobCreate = await createNotebookWithOwnerAcl(env, "race-demo", bob);

    assert.deepEqual(env.DB.batchSizes.slice(-2), [2, 2]);
    assert.deepEqual(aliceCreate, { ownerPrincipal: "user:dev:alice", created: true });
    assert.deepEqual(bobCreate, { ownerPrincipal: "user:dev:bob", created: false });
    assert.equal(env.DB.notebooks.get("race-demo")?.owner_principal, "user:dev:alice");
    assert.equal(
      (await getNotebookAclRowsForPrincipal(env, "race-demo", "user:dev:alice")).length,
      1,
    );
    assert.equal(
      (await getNotebookAclRowsForPrincipal(env, "race-demo", "user:dev:bob")).length,
      0,
    );
  });

  it("allows same-origin browser WebSocket upgrades and forwards only the app protocol", async () => {
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            forwardedRequest = request;
            return new Response("room ok");
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "origin-demo");
    seedAcl(env, {
      notebookId: "origin-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });

    const credentialProtocol = `${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url("local-dev-token")}`;
    const response = await worker.fetch(
      new Request("http://localhost/n/origin-demo/sync?user=alice&scope=owner", {
        headers: {
          Upgrade: "websocket",
          Origin: "http://localhost",
          "Sec-WebSocket-Protocol": `${credentialProtocol}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "room ok");
    assert.ok(forwardedRequest);
    assert.equal(
      forwardedRequest.headers.get("Sec-WebSocket-Protocol"),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
    assert.equal(
      forwardedRequest.headers.get(TRUSTED_WEBSOCKET_PROTOCOL_HEADER),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
  });

  it("allows configured browser WebSocket origins", async () => {
    let roomFetches = 0;
    const env = fakeEnv({
      NOTEBOOK_CLOUD_ALLOWED_ORIGINS: "https://app.example.test",
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("room ok");
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "allowed-origin-demo");
    seedAcl(env, {
      notebookId: "allowed-origin-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/allowed-origin-demo/sync?user=alice&scope=owner", {
        headers: {
          Upgrade: "websocket",
          Origin: "https://app.example.test",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(roomFetches, 1);
  });

  it("rejects WebSocket upgrades from origins outside the configured allowlist", async () => {
    let roomFetches = 0;
    const env = fakeEnv({
      NOTEBOOK_CLOUD_ALLOWED_ORIGINS: "https://notebooks.example.com",
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("unexpected room fetch", { status: 500 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/acl-demo/sync?viewer_session=blocked", {
        headers: {
          Origin: "https://evil.example",
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "websocket origin is not allowed" });
    assert.equal(roomFetches, 0);
  });

  it("rejects output-document origins at the room WebSocket gate", async () => {
    let roomFetches = 0;
    const env = fakeEnv({
      NOTEBOOK_CLOUD_ALLOWED_ORIGINS: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("unexpected room fetch", { status: 500 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://nteract-notebook-cloud.rgbkrk.workers.dev/n/acl-demo/sync", {
        headers: {
          Origin: "https://nteract-notebook-cloud-outputs.rgbkrk.workers.dev",
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "websocket origin is not allowed" });
    assert.equal(roomFetches, 0);
  });

  it("rejects malformed WebSocket Origin headers even without an allowlist", async () => {
    let roomFetches = 0;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("unexpected room fetch", { status: 500 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/acl-demo/sync?viewer_session=malformed", {
        headers: {
          Origin: "not-a-url",
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "websocket origin is not allowed" });
    assert.equal(roomFetches, 0);
  });

  it("allows same-origin OIDC bearer subprotocol WebSocket upgrades", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "alice" });
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            forwardedRequest = request;
            return new Response("room ok");
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "same-origin-oidc-demo");
    seedAcl(env, {
      notebookId: "same-origin-oidc-demo",
      subject: "user:anaconda:alice",
      scope: "owner",
    });

    const response = await worker.fetch(
      new Request(
        "https://cloud.test/n/same-origin-oidc-demo/sync?operator=browser:tab&scope=owner",
        {
          headers: {
            Origin: "https://cloud.test",
            "Sec-WebSocket-Protocol": `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(
              token,
            )}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
            Upgrade: "websocket",
          },
        },
      ),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.ok(forwardedRequest);
    assert.equal(
      forwardedRequest.headers.get("Sec-WebSocket-Protocol"),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
    assert.equal(
      forwardedRequest.headers.get(TRUSTED_WEBSOCKET_PROTOCOL_HEADER),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
  });

  it("downgrades OIDC editor WebSocket requests to public viewer access", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "anil" });
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            forwardedRequest = request;
            return new Response("room ok");
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "public-oidc-demo");
    seedAcl(env, {
      notebookId: "public-oidc-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/public-oidc-demo/sync?operator=browser:tab&scope=editor", {
        headers: {
          Origin: "https://cloud.test",
          "Sec-WebSocket-Protocol": `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(
            token,
          )}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.ok(forwardedRequest);
    assert.equal(forwardedRequest.headers.get(TRUSTED_SCOPE_HEADER), "viewer");
    assert.equal(
      forwardedRequest.headers.get(TRUSTED_WEBSOCKET_PROTOCOL_HEADER),
      NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
    );
  });

  it("stores OIDC profile labels even when there are no pending invites", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      email: "kkelley@anaconda.com",
      extraPayload: { email_verified: true },
      name: "Kyle Kelley",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => new Response("room ok"),
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "oidc-profile-demo");
    seedAcl(env, {
      notebookId: "oidc-profile-demo",
      subject: "user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/oidc-profile-demo/sync?operator=browser:tab&scope=viewer", {
        headers: {
          Origin: "https://cloud.test",
          "Sec-WebSocket-Protocol": `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(
            token,
          )}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const profile = env.DB.profiles.get("user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375");
    assert.equal(profile?.provider, "oidc");
    assert.equal(profile?.email_normalized, "kkelley@anaconda.com");
    assert.equal(profile?.email_verified, 1);
    assert.equal(profile?.display_name, "Kyle Kelley");
  });

  it("resolves pending email invites for OIDC editor WebSocket requests", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      email: "kkelley@anaconda.com",
      extraPayload: { email_verified: true },
      name: "Kyle Kelley",
    });
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            forwardedRequest = request;
            return new Response("room ok");
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "oidc-invite-demo");
    seedPendingInvite(env, {
      id: "invite-oidc-editor",
      notebookId: "oidc-invite-demo",
      email: "kkelley@anaconda.com",
      providerHint: null,
      scope: "editor",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/oidc-invite-demo/sync?operator=browser:tab&scope=editor", {
        headers: {
          Origin: "https://cloud.test",
          "Sec-WebSocket-Protocol": `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(
            token,
          )}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.ok(forwardedRequest);
    assert.equal(forwardedRequest.headers.get(TRUSTED_SCOPE_HEADER), "editor");
    const accountPrincipal = await canonicalAccountPrincipalForProfile({
      provider: "oidc",
      principalNamespace: "user:anaconda",
      email: "kkelley@anaconda.com",
      emailVerified: true,
    });
    assert.ok(accountPrincipal);
    assert.ok(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "oidc-invite-demo" &&
          row.subject_kind === "principal" &&
          row.subject === accountPrincipal &&
          row.scope === "editor",
      ),
    );
    assert.equal(env.DB.invites.get("invite-oidc-editor")?.status, "accepted");
  });

  it("does not resolve pending OIDC invites for unverified emails", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "unverified-oidc-user",
      email: "unverified@anaconda.com",
      extraPayload: { email_verified: false },
    });
    const env = fakeEnv(oidcEnv);
    seedNotebook(env, "oidc-unverified-invite-demo");
    seedPendingInvite(env, {
      id: "invite-unverified-oidc-editor",
      notebookId: "oidc-unverified-invite-demo",
      email: "unverified@anaconda.com",
      providerHint: null,
      scope: "editor",
    });

    const response = await worker.fetch(
      new Request(
        "https://cloud.test/n/oidc-unverified-invite-demo/sync?operator=browser:tab&scope=editor",
        {
          headers: {
            Origin: "https://cloud.test",
            "Sec-WebSocket-Protocol": `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(
              token,
            )}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
            Upgrade: "websocket",
          },
        },
      ),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.equal(env.DB.invites.get("invite-unverified-oidc-editor")?.status, "pending");
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "oidc-unverified-invite-demo" &&
          row.subject === "user:anaconda:unverified-oidc-user",
      ),
      false,
    );
  });

  it("requires Origin for OIDC bearer subprotocol WebSocket credentials", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "alice" });
    let roomFetches = 0;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("unexpected room fetch", { status: 500 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/oidc-origin-demo/sync?operator=browser:tab&scope=owner", {
        headers: {
          "Sec-WebSocket-Protocol": `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "websocket origin is required" });
    assert.equal(roomFetches, 0);
  });

  it("does not create notebook rows from unauthorized WebSocket opens", async () => {
    let roomFetches = 0;
    const env = fakeEnv({
      DEPLOYMENT_ENV: "prototype",
      NOTEBOOK_CLOUD_DEV_TOKEN: "secret-token",
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            roomFetches += 1;
            return new Response("unexpected room fetch", { status: 500 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request(
        "https://cloud.test/n/unclaimed-demo/sync?user=alice&operator=desktop:a&scope=editor",
        {
          headers: {
            Upgrade: "websocket",
            "X-Notebook-Cloud-Dev-Token": "secret-token",
          },
        },
      ),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "notebook not found" });
    assert.equal(roomFetches, 0);
    assert.equal(env.DB.notebooks.has("unclaimed-demo"), false);
  });

  it("logs deployed dev auth failures without token material", async () => {
    const env = fakeEnv({
      DEPLOYMENT_ENV: "prototype",
      NOTEBOOK_CLOUD_DEV_TOKEN: "secret-token",
    });
    const originalInfo = console.info;
    const logs: unknown[][] = [];
    console.info = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const response = await worker.fetch(
        new Request("https://cloud.test/n/unclaimed-demo/sync?user=alice&scope=editor", {
          headers: {
            Upgrade: "websocket",
            Origin: "https://cloud.test",
            "Sec-WebSocket-Protocol": `${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(
              "<NOTEBOOK_CLOUD_DEV_TOKEN>",
            )}`,
          },
        }),
        env,
        fakeContext(),
      );

      assert.equal(response.status, 401);
      const record = logs
        .filter((entry) => entry[0] === "[notebook-cloud]")
        .map((entry) => entry[1] as { event?: string; reason?: string; [key: string]: unknown })
        .find((entry) => entry.event === "auth.failed");
      assert.ok(record, "expected auth.failed log record");
      assert.equal(record.counter, "auth_failures");
      assert.equal(record.has_websocket_protocol, true);
      assert.doesNotMatch(JSON.stringify(record), /<NOTEBOOK_CLOUD_DEV_TOKEN>|secret-token/);
    } finally {
      console.info = originalInfo;
    }
  });

  it("publishes a snapshot pair and records revision metadata for snapshot loading", async () => {
    const env = fakeEnv();
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);
    const commsPeer = new RuntimeStatePeerHandle("runtime");
    commsPeer.put_comm_json(
      "widget-model",
      "jupyter.widget",
      "@jupyter-widgets/controls",
      "IntTextModel",
      JSON.stringify({ value: 7 }),
      1,
    );
    const commsDocBytes = commsPeer.save_comms_doc();
    commsPeer.free();

    const runtimePut = await ownerPut(
      env,
      "/api/n/route-demo/runtime-snapshots/runtime-fixture",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:output-streaming",
      },
    );
    assert.equal(runtimePut.status, 201);
    const commsPut = await ownerPut(
      env,
      "/api/n/route-demo/comms-snapshots/comms-fixture",
      commsDocBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:output-streaming",
      },
    );
    assert.equal(commsPut.status, 201);
    assert.deepEqual(
      env.DB.acl.map((row) => [row.notebook_id, row.subject_kind, row.subject, row.scope]),
      [["route-demo", "principal", "user:dev:alice", "owner"]],
    );

    const notebookPut = await ownerPut(
      env,
      "/api/n/route-demo/snapshots/heads-fixture",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-fixture",
        "X-Comms-Heads-Hash": "comms-fixture",
        "X-Runtime-State-Doc-Id": "runtime:output-streaming",
      },
    );
    assert.equal(notebookPut.status, 201);
    const notebookPutBody = (await notebookPut.json()) as {
      runtime_state_doc_id: string;
      comms_snapshot_key: string;
    };
    assert.equal(notebookPutBody.runtime_state_doc_id, "runtime:output-streaming");
    assert.equal(
      notebookPutBody.comms_snapshot_key,
      commsDocSnapshotKey("runtime:output-streaming", "comms-fixture"),
    );
    assert.equal(env.DB.revisions[0]?.runtime_state_doc_id, "runtime:output-streaming");
    assert.equal(
      env.DB.revisions[0]?.runtime_snapshot_key,
      runtimeStateSnapshotKey("runtime:output-streaming", "runtime-fixture"),
    );
    assert.equal(env.DB.revisions[0]?.comms_heads_hash, "comms-fixture");
    assert.equal(
      env.DB.revisions[0]?.comms_snapshot_key,
      commsDocSnapshotKey("runtime:output-streaming", "comms-fixture"),
    );
    assert.deepEqual(
      env.DB.acl.map((row) => [row.notebook_id, row.subject_kind, row.subject, row.scope]),
      [
        ["route-demo", "principal", "user:dev:alice", "owner"],
        ["route-demo", "public", "anonymous", "viewer"],
      ],
    );
    const response = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/snapshots/heads-fixture"),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await response.arrayBuffer()).byteLength,
      notebookBytes.byteLength,
      "snapshot route should return raw Automerge bytes",
    );

    const runtimeResponse = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/runtime-snapshots/runtime-fixture", {
        headers: { "X-Runtime-State-Doc-Id": "runtime:output-streaming" },
      }),
      env,
      fakeContext(),
    );
    assert.equal(runtimeResponse.status, 200);

    const commsResponse = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/comms-snapshots/comms-fixture", {
        headers: { "X-Runtime-State-Doc-Id": "runtime:output-streaming" },
      }),
      env,
      fakeContext(),
    );
    assert.equal(commsResponse.status, 200);

    const latestRenderRoute = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/render"),
      env,
      fakeContext(),
    );
    assert.equal(latestRenderRoute.status, 404);
    const renderCacheRoute = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/renders/heads-fixture"),
      env,
      fakeContext(),
    );
    assert.equal(renderCacheRoute.status, 404);
  });

  it("rejects snapshot publish when the header runtime id disagrees with the NotebookDoc pointer", async () => {
    const env = fakeEnv();
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);

    const runtimePut = await ownerPut(
      env,
      "/api/n/route-demo/runtime-snapshots/runtime-fixture",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:wrong-route-demo",
      },
    );
    assert.equal(runtimePut.status, 201);

    const response = await ownerPut(
      env,
      "/api/n/route-demo/snapshots/heads-fixture",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-fixture",
        "X-Runtime-State-Doc-Id": "runtime:wrong-route-demo",
      },
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "snapshot pair runtime_state_doc_id mismatch",
      expected_runtime_state_doc_id: "runtime:wrong-route-demo",
      actual_runtime_state_doc_id: "runtime:output-streaming",
    });
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("route-demo", "heads-fixture")),
      false,
      "rejected snapshot publish should not leave an orphan notebook snapshot",
    );
  });

  it("rejects snapshot publish when the referenced runtime snapshot is missing", async () => {
    const env = fakeEnv();
    const notebookBytes = await readFile(
      new URL(
        "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
        import.meta.url,
      ),
    );

    const response = await ownerPut(
      env,
      "/api/n/missing-runtime-demo/snapshots/heads-fixture",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-missing",
        "X-Runtime-State-Doc-Id": "runtime:missing-runtime-demo",
      },
    );

    assert.equal(response.status, 424);
    const body = (await response.json()) as { error: string; runtime_heads_hash: string };
    assert.equal(body.error, "snapshot publish missing runtime-state snapshot");
    assert.equal(body.runtime_heads_hash, "runtime-missing");
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("missing-runtime-demo", "heads-fixture")),
      false,
      "rejected snapshot publish should not leave an orphan notebook snapshot",
    );
  });

  it("rejects snapshot publish when the persisted pair cannot be materialized", async () => {
    const env = fakeEnv();
    const corruptBytes = new TextEncoder().encode("not an automerge document");

    const runtimePut = await ownerPut(
      env,
      "/api/n/corrupt-demo/runtime-snapshots/runtime-corrupt",
      corruptBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:corrupt-demo",
      },
    );
    assert.equal(runtimePut.status, 201);

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let response: Response;
    try {
      response = await ownerPut(env, "/api/n/corrupt-demo/snapshots/heads-corrupt", corruptBytes, {
        "X-Runtime-Heads-Hash": "runtime-corrupt",
        "X-Runtime-State-Doc-Id": "runtime:corrupt-demo",
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await response.json()) as { error: string; details: string };
    assert.equal(body.error, "snapshot pair validation failed");
    assert.match(body.details, /load|document|decode|automerge/i);
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("corrupt-demo", "heads-corrupt")),
      false,
      "rejected snapshot publish should not leave a corrupt notebook snapshot",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "[notebook-cloud]");
    assert.equal((warnings[0][1] as { event: string }).event, "snapshot_pair.validation.failed");
  });

  it("rejects snapshot publish when materialized blob refs are missing from R2", async () => {
    const env = fakeEnv();
    const [notebookBytes, runtimeStateBytes, manifestBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/state_doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const manifest = JSON.parse(manifestBytes) as { blobs: Array<{ hash: string }> };
    const missingHash = manifest.blobs[0]?.hash;
    assert.equal(typeof missingHash, "string");

    const runtimePut = await ownerPut(
      env,
      "/api/n/missing-blob-demo/runtime-snapshots/runtime-fixture",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:sift-arrow",
      },
    );
    assert.equal(runtimePut.status, 201);

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let response: Response;
    try {
      response = await ownerPut(
        env,
        "/api/n/missing-blob-demo/snapshots/heads-fixture",
        notebookBytes,
        {
          "X-Runtime-Heads-Hash": "runtime-fixture",
          "X-Runtime-State-Doc-Id": "runtime:sift-arrow",
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 424);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await response.json()) as {
      error: string;
      missing_blobs: Array<{ hash: string }>;
    };
    assert.equal(body.error, "snapshot pair validation missing blobs");
    assert.ok(
      body.missing_blobs.some((blob) => blob.hash === missingHash),
      "response should include the missing fixture blob hash",
    );
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("missing-blob-demo", "heads-fixture")),
      false,
      "rejected snapshot publish should not leave an orphan notebook snapshot",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "[notebook-cloud]");
    assert.equal(
      (warnings[0][1] as { event: string }).event,
      "snapshot_pair.validation.missing_blobs",
    );
  });
});

async function ownerPut(
  env: FakeEnv,
  pathname: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return scopedPut(env, pathname, body, {
    "X-Scope": "owner",
    ...headers,
  });
}

async function aclRequest(
  env: FakeEnv,
  method: "GET" | "POST" | "DELETE",
  body: Record<string, unknown> | undefined,
  notebookId = "acl-demo",
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User": "alice",
      "X-Operator": "desktop:test",
      "X-Scope": "owner",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return worker.fetch(
    new Request(new URL(`/api/n/${notebookId}/acl`, "http://localhost"), init),
    env,
    fakeContext(),
  );
}

async function inviteRequest(
  env: FakeEnv,
  method: "GET" | "POST",
  body: Record<string, unknown> | undefined,
  notebookId = "invite-demo",
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User": "alice",
      "X-Operator": "desktop:test",
      "X-Scope": "owner",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return worker.fetch(
    new Request(new URL(`/api/n/${notebookId}/invites`, "http://localhost"), init),
    env,
    fakeContext(),
  );
}

async function inviteItemRequest(
  env: FakeEnv,
  method: "DELETE",
  inviteId: string,
  notebookId = "invite-demo",
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(new URL(`/api/n/${notebookId}/invites/${inviteId}`, "http://localhost"), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-User": "alice",
        "X-Operator": "desktop:test",
        "X-Scope": "owner",
        ...headers,
      },
    }),
    env,
    fakeContext(),
  );
}

async function accessRequestsRequest(
  env: FakeEnv,
  method: "GET" | "POST",
  notebookId: string,
  body: Record<string, unknown> | undefined = undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User": "alice",
      "X-Operator": "desktop:test",
      "X-Scope": "owner",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return worker.fetch(
    new Request(new URL(`/api/n/${notebookId}/access-requests`, "http://localhost"), init),
    env,
    fakeContext(),
  );
}

async function accessRequestItemRequest(
  env: FakeEnv,
  method: "POST",
  notebookId: string,
  requestId: string,
  action: "approve" | "deny" | "dismiss",
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(new URL(`/api/n/${notebookId}/access-requests/${requestId}`, "http://localhost"), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-User": "alice",
        "X-Operator": "desktop:test",
        "X-Scope": "owner",
        ...headers,
      },
      body: JSON.stringify({ action }),
    }),
    env,
    fakeContext(),
  );
}

async function blobGet(
  env: FakeEnv,
  pathname: string,
  ctx: ExecutionContext = fakeContext(),
): Promise<Response> {
  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      headers: {
        "X-User": "alice",
        "X-Operator": "desktop:test",
        "X-Scope": "viewer",
      },
    }),
    env,
    ctx,
  );
}

async function scopedPut(
  env: FakeEnv,
  pathname: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-User": "alice",
        "X-Operator": "desktop:test",
        ...headers,
      },
      body,
    }),
    env,
    fakeContext(),
  );
}

function seedNotebook(env: FakeEnv, notebookId: string): void {
  env.DB.notebooks.set(notebookId, {
    id: notebookId,
    owner_principal: "user:dev:alice",
    title: null,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    latest_revision_id: null,
  });
}

function seedAcl(
  env: FakeEnv,
  row: {
    notebookId: string;
    subject: string;
    scope: NotebookAclRow["scope"];
    subjectKind?: NotebookAclRow["subject_kind"];
  },
): void {
  env.DB.acl.push({
    notebook_id: row.notebookId,
    subject_kind: row.subjectKind ?? "principal",
    subject: row.subject,
    scope: row.scope,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    created_by_actor_label: "user:dev:alice/desktop:test",
  });
}

function seedWorkstation(
  env: FakeEnv,
  input: {
    ownerPrincipal: string;
    workstationId: string;
    status?: WorkstationRow["status"];
  },
): void {
  env.DB.workstations.set(workstationKey(input.ownerPrincipal, input.workstationId), {
    owner_principal: input.ownerPrincipal,
    workstation_id: input.workstationId,
    display_name: "Lab2",
    provider: "runtime_peer",
    provider_label: null,
    status: input.status ?? "online",
    status_message: null,
    default_environment_label: "Current Python",
    environment_policy: "current_python",
    working_directory: "/home/ubuntu/project",
    cpu_count: 8,
    memory_bytes: 16_000_000_000,
    environments_json: null,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    last_seen_at: new Date().toISOString(),
  });
}

function seedWorkstationAttachJob(
  env: FakeEnv,
  input: {
    id: string;
    notebookId: string;
    ownerPrincipal: string;
    workstationId: string;
    status?: WorkstationAttachJobRow["status"];
  },
): void {
  env.DB.workstationAttachJobs.set(input.id, {
    id: input.id,
    notebook_id: input.notebookId,
    owner_principal: input.ownerPrincipal,
    workstation_id: input.workstationId,
    status: input.status ?? "pending",
    requested_by_actor_label: "user:dev:alice/browser:tab",
    requested_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    accepted_at: null,
    finished_at: null,
    error_message: null,
  });
}

function seedPendingInvite(
  env: FakeEnv,
  input: {
    id: string;
    notebookId: string;
    email: string;
    providerHint: string | null;
    scope: PendingNotebookInviteRow["scope"];
  },
): void {
  env.DB.invites.set(input.id, {
    id: input.id,
    notebook_id: input.notebookId,
    email_normalized: input.email,
    provider_hint: input.providerHint,
    scope: input.scope,
    status: "pending",
    invited_by_actor_label: "user:oidc:alice/browser:tab",
    accepted_by_principal: null,
    token_hash: null,
    created_at: "2026-05-22T00:00:00.000Z",
    expires_at: null,
    accepted_at: null,
    revoked_at: null,
    revoked_by_actor_label: null,
  });
}

function seedAccessRequest(
  env: FakeEnv,
  input: {
    id: string;
    notebookId: string;
    requesterPrincipal: string;
    status: NotebookAccessRequestRow["status"];
  },
): void {
  env.DB.accessRequests.set(input.id, {
    id: input.id,
    notebook_id: input.notebookId,
    requester_principal: input.requesterPrincipal,
    scope: "editor",
    status: input.status,
    requested_by_actor_label: `${input.requesterPrincipal}/browser:tab`,
    resolved_by_actor_label: null,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    resolved_at: null,
  });
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface FakeEnv extends Env {
  DB: FakeD1;
  NOTEBOOK_SNAPSHOTS: FakeR2Bucket;
}

function fakeEnv(overrides: Partial<Env> = {}): FakeEnv {
  const env: FakeEnv = {
    DEPLOYMENT_ENV: "development",
    DB: new FakeD1(),
    NOTEBOOK_SNAPSHOTS: new FakeR2Bucket(),
    NOTEBOOK_ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response("not implemented", { status: 501 }),
      }),
    } satisfies DurableObjectNamespace,
  };
  Object.assign(env, overrides);
  return env;
}

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}

function fakeContextWithWaitUntil(promises: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (promise) => {
      promises.push(promise);
    },
    passThroughOnException: () => undefined,
  };
}

function installGlobalCaches(cachesValue: { default: Cache }): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: cachesValue,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "caches", descriptor);
    } else {
      delete (globalThis as { caches?: unknown }).caches;
    }
  };
}

function anacondaApiKeyEnv(): {
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: string;
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: string;
} {
  return {
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL:
      "https://auth.stage.anaconda.com/api/auth/sessions/whoami",
  };
}

function anacondaApiKeyToken(payload: Record<string, unknown> = {}): string {
  return [
    base64Url(JSON.stringify({ alg: "RS256", kid: "api-key-test", typ: "JWT" })),
    base64Url(JSON.stringify({ kid: "api-key-test", ver: "api:1", ...payload })),
    "signature",
  ].join(".");
}

function anacondaWhoami(options: {
  email?: string;
  firstName?: string;
  lastName?: string;
  scopes: string[];
  source?: string;
  userId: string;
}): unknown {
  return {
    passport: {
      user_id: options.userId,
      profile: {
        email: options.email ?? "user@example.com",
        first_name: options.firstName ?? "",
        last_name: options.lastName ?? "",
      },
      scopes: options.scopes,
      source: options.source ?? "api_key",
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function oidcAppSessionCookie(env: Env, token: string): Promise<string> {
  const response = await worker.fetch(
    new Request("https://cloud.test/api/auth/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://cloud.test",
      },
    }),
    env,
    fakeContext(),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("Set-Cookie");
  assert.ok(cookie);
  return cookie;
}

function notebookHomeBootstrap(html: string): {
  kind: string;
  notebooks: Array<{
    notebook_id: string;
    title: string | null;
  }>;
} {
  const match = html.match(
    /<script id="nteract-cloud-bootstrap" type="application\/json">([^<]+)<\/script>/,
  );
  assert.ok(match?.[1], "expected notebook home bootstrap script");
  return JSON.parse(match[1]) as {
    kind: string;
    notebooks: Array<{
      notebook_id: string;
      title: string | null;
    }>;
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

interface NotebookRow {
  id: string;
  owner_principal: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
}

interface NotebookAclRow {
  notebook_id: string;
  subject_kind: "principal" | "public";
  subject: string;
  scope: "viewer" | "editor" | "runtime_peer" | "owner";
  created_at: string;
  updated_at: string;
  created_by_actor_label: string;
}

interface NotebookAccessRequestRow {
  id: string;
  notebook_id: string;
  requester_principal: string;
  scope: "editor";
  status: "pending" | "approved" | "denied" | "dismissed";
  requested_by_actor_label: string;
  resolved_by_actor_label: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface RevisionRow {
  id: string;
  notebook_id: string;
  runtime_state_doc_id: string | null;
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  comms_heads_hash: string | null;
  snapshot_key: string;
  runtime_snapshot_key: string | null;
  comms_snapshot_key: string | null;
  actor_label: string;
  created_at: string;
}

interface WorkstationRow {
  owner_principal: string;
  workstation_id: string;
  display_name: string;
  provider: string;
  provider_label: string | null;
  status: "online" | "offline" | "connecting" | "attention" | "unknown";
  status_message: string | null;
  default_environment_label: string | null;
  environment_policy: string | null;
  working_directory: string | null;
  cpu_count: number | null;
  memory_bytes: number | null;
  environments_json: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

interface WorkstationAttachJobRow {
  id: string;
  notebook_id: string;
  owner_principal: string;
  workstation_id: string;
  status: "pending" | "accepted" | "running" | "failed" | "completed" | "cancelled";
  requested_by_actor_label: string;
  requested_at: string;
  updated_at: string;
  accepted_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

class FakeD1 implements D1Database {
  readonly notebooks = new Map<string, NotebookRow>();
  readonly revisions: RevisionRow[] = [];
  readonly blobs = new Map<string, BlobRow>();
  readonly acl: NotebookAclRow[] = [];
  readonly profiles = new Map<string, PrincipalProfileRow>();
  readonly accountLinks = new Map<string, PrincipalAccountLinkRow>();
  readonly invites = new Map<string, PendingNotebookInviteRow>();
  readonly accessRequests = new Map<string, NotebookAccessRequestRow>();
  readonly workstations = new Map<string, WorkstationRow>();
  readonly workstationDefaults = new Map<string, string>();
  readonly workstationAttachJobs = new Map<string, WorkstationAttachJobRow>();
  readonly batchSizes: number[] = [];
  afterBlockedOwnerDelete?: () => void;

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return okResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batchSizes.push(statements.length);
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class FakeD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("INSERT OR IGNORE INTO notebook_acl")) {
      if (this.query.includes("'principal'") && this.query.includes("owner_principal")) {
        for (const notebook of this.db.notebooks.values()) {
          this.insertAclIfMissing({
            notebook_id: notebook.id,
            subject_kind: "principal",
            subject: notebook.owner_principal,
            scope: "owner",
            created_at: notebook.created_at,
            updated_at: notebook.updated_at,
            created_by_actor_label: "system/schema:notebook-cloud-owner-acl-backfill",
          });
        }
      } else if (this.query.includes("'public'")) {
        for (const notebook of this.db.notebooks.values()) {
          if (notebook.latest_revision_id === null) continue;
          this.insertAclIfMissing({
            notebook_id: notebook.id,
            subject_kind: "public",
            subject: "anonymous",
            scope: "viewer",
            created_at: notebook.created_at,
            updated_at: notebook.updated_at,
            created_by_actor_label: "system/schema:notebook-cloud-public-acl-backfill",
          });
        }
      }
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("WHERE EXISTS")
    ) {
      const [notebookId, subject, createdAt, updatedAt, actorLabel, expectedNotebookId, owner] =
        this.values as [string, string, string, string, string, string, string];
      if (this.db.notebooks.get(expectedNotebookId)?.owner_principal === owner) {
        this.insertAclIfMissing({
          notebook_id: notebookId,
          subject_kind: "principal",
          subject,
          scope: "owner",
          created_at: createdAt,
          updated_at: updatedAt,
          created_by_actor_label: actorLabel,
        });
      }
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("FROM notebook_invites")
    ) {
      const [
        subject,
        createdAt,
        updatedAt,
        actorLabel,
        inviteId,
        acceptedByPrincipal,
        acceptedAt,
        email,
        providerHint,
        now,
      ] = this.values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      const invite = this.db.invites.get(inviteId);
      if (
        invite &&
        invite.status === "accepted" &&
        invite.accepted_by_principal === acceptedByPrincipal &&
        invite.accepted_at === acceptedAt &&
        invite.email_normalized === email &&
        (invite.provider_hint === providerHint || invite.provider_hint === null) &&
        (!invite.expires_at || Date.parse(invite.expires_at) > Date.parse(now)) &&
        this.db.notebooks.has(invite.notebook_id)
      ) {
        this.insertAclIfMissing({
          notebook_id: invite.notebook_id,
          subject_kind: "principal",
          subject,
          scope: invite.scope,
          created_at: createdAt,
          updated_at: updatedAt,
          created_by_actor_label: actorLabel,
        });
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("FROM notebook_access_requests")
    ) {
      const [createdAt, updatedAt, actorLabel, notebookId, requestId] = this.values as [
        string,
        string,
        string,
        string,
        string,
      ];
      const accessRequest = this.db.accessRequests.get(requestId);
      if (
        accessRequest &&
        accessRequest.notebook_id === notebookId &&
        accessRequest.status === "pending"
      ) {
        this.insertAclIfMissing({
          notebook_id: notebookId,
          subject_kind: "principal",
          subject: accessRequest.requester_principal,
          scope: accessRequest.scope,
          created_at: createdAt,
          updated_at: updatedAt,
          created_by_actor_label: actorLabel,
        });
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("FROM notebook_acl")
    ) {
      const [canonicalPrincipal, updatedAt, transportPrincipal] = this.values as [
        string,
        string,
        string,
      ];
      const rows = this.db.acl.filter(
        (row) => row.subject_kind === "principal" && row.subject === transportPrincipal,
      );
      for (const row of rows) {
        this.insertAclIfMissing({
          ...row,
          subject: canonicalPrincipal,
          updated_at: updatedAt,
        });
      }
    } else if (this.query.includes("INSERT INTO notebook_acl")) {
      const [notebookId, subjectKind, subject, scope, createdAt, updatedAt, actorLabel] = this
        .values as [
        string,
        NotebookAclRow["subject_kind"],
        string,
        NotebookAclRow["scope"],
        string,
        string,
        string,
      ];
      this.insertAclIfMissing({
        notebook_id: notebookId,
        subject_kind: subjectKind,
        subject,
        scope,
        created_at: createdAt,
        updated_at: updatedAt,
        created_by_actor_label: actorLabel,
      });
    } else if (
      this.query.includes("DELETE FROM notebook_acl") &&
      this.query.includes("subject_kind = 'principal'") &&
      !this.query.includes("notebook_id = ?")
    ) {
      const [transportPrincipal, canonicalPrincipal] = this.values as [string, string];
      const retained = this.db.acl.filter(
        (row) =>
          !(
            row.subject_kind === "principal" &&
            row.subject === transportPrincipal &&
            this.db.acl.some(
              (target) =>
                target.notebook_id === row.notebook_id &&
                target.subject_kind === "principal" &&
                target.subject === canonicalPrincipal &&
                target.scope === row.scope,
            )
          ),
      );
      this.db.acl.splice(0, this.db.acl.length, ...retained);
    } else if (this.query.includes("DELETE FROM notebook_acl")) {
      const [notebookId, subjectKind, subject, scope] = this.values as [
        string,
        NotebookAclRow["subject_kind"],
        string,
        NotebookAclRow["scope"],
      ];
      if (
        subjectKind === "principal" &&
        scope === "owner" &&
        !this.db.acl.some(
          (row) =>
            row.notebook_id === notebookId &&
            row.subject_kind === "principal" &&
            row.scope === "owner" &&
            row.subject !== subject,
        )
      ) {
        this.db.afterBlockedOwnerDelete?.();
        this.db.afterBlockedOwnerDelete = undefined;
        return okResult(undefined, { changes: 0 });
      }

      const countBefore = this.db.acl.length;
      const retained = this.db.acl.filter(
        (row) =>
          !(
            row.notebook_id === notebookId &&
            row.subject_kind === subjectKind &&
            row.subject === subject &&
            row.scope === scope
          ),
      );
      this.db.acl.splice(0, this.db.acl.length, ...retained);
      return okResult(undefined, { changes: countBefore - retained.length });
    } else if (this.query.includes("INSERT INTO notebook_invites")) {
      const [
        id,
        notebookId,
        emailNormalized,
        providerHint,
        scope,
        actorLabel,
        tokenHash,
        createdAt,
        expiresAt,
      ] = this.values as [
        string,
        string,
        string,
        string | null,
        PendingNotebookInviteRow["scope"],
        string,
        string | null,
        string,
        string | null,
      ];
      const duplicate = [...this.db.invites.values()].find(
        (invite) =>
          invite.notebook_id === notebookId &&
          invite.email_normalized === emailNormalized &&
          invite.provider_hint === providerHint &&
          invite.scope === scope &&
          invite.status === "pending",
      );
      if (duplicate) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: notebook_invites pending invite");
      }
      this.db.invites.set(id, {
        id,
        notebook_id: notebookId,
        email_normalized: emailNormalized,
        provider_hint: providerHint,
        scope,
        status: "pending",
        invited_by_actor_label: actorLabel,
        accepted_by_principal: null,
        token_hash: tokenHash,
        created_at: createdAt,
        expires_at: expiresAt,
        accepted_at: null,
        revoked_at: null,
        revoked_by_actor_label: null,
      });
    } else if (
      this.query.includes("UPDATE notebook_invites") &&
      this.query.includes("revoked_by_actor_label")
    ) {
      const [revokedAt, revokedByActorLabel, notebookId, inviteId] = this.values as [
        string,
        string,
        string,
        string,
      ];
      const invite = this.db.invites.get(inviteId);
      if (invite && invite.notebook_id === notebookId && invite.status === "pending") {
        invite.status = "revoked";
        invite.revoked_at = revokedAt;
        invite.revoked_by_actor_label = revokedByActorLabel;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (this.query.includes("INSERT INTO notebook_access_requests")) {
      const [id, notebookId, requesterPrincipal, actorLabel, createdAt, updatedAt] = this
        .values as [string, string, string, string, string, string];
      const duplicate = [...this.db.accessRequests.values()].find(
        (accessRequest) =>
          accessRequest.notebook_id === notebookId &&
          accessRequest.requester_principal === requesterPrincipal &&
          accessRequest.scope === "editor" &&
          accessRequest.status === "pending",
      );
      if (duplicate) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: notebook_access_requests pending request",
        );
      }
      this.db.accessRequests.set(id, {
        id,
        notebook_id: notebookId,
        requester_principal: requesterPrincipal,
        scope: "editor",
        status: "pending",
        requested_by_actor_label: actorLabel,
        resolved_by_actor_label: null,
        created_at: createdAt,
        updated_at: updatedAt,
        resolved_at: null,
      });
    } else if (this.query.includes("UPDATE notebook_access_requests")) {
      const [status, actorLabel, resolvedAt, updatedAt, notebookId, requestId] = this.values as [
        NotebookAccessRequestRow["status"],
        string,
        string,
        string,
        string,
        string,
      ];
      const accessRequest = this.db.accessRequests.get(requestId);
      if (
        accessRequest &&
        accessRequest.notebook_id === notebookId &&
        accessRequest.status === "pending"
      ) {
        accessRequest.status = status;
        accessRequest.resolved_by_actor_label = actorLabel;
        accessRequest.resolved_at = resolvedAt;
        accessRequest.updated_at = updatedAt;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (this.query.includes("INSERT INTO workstations")) {
      const [
        ownerPrincipal,
        workstationId,
        displayName,
        provider,
        providerLabel,
        statusMessage,
        defaultEnvironmentLabel,
        environmentPolicy,
        workingDirectory,
        cpuCount,
        memoryBytes,
        environmentsJson,
        createdAt,
        updatedAt,
        lastSeenAt,
      ] = this.values as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        string | null,
        string,
        string,
        string,
      ];
      const key = workstationKey(ownerPrincipal, workstationId);
      const existing = this.db.workstations.get(key);
      this.db.workstations.set(key, {
        owner_principal: ownerPrincipal,
        workstation_id: workstationId,
        display_name: displayName,
        provider,
        provider_label: providerLabel,
        status: "online",
        status_message: statusMessage,
        default_environment_label: defaultEnvironmentLabel,
        environment_policy: environmentPolicy,
        working_directory: workingDirectory,
        cpu_count: cpuCount,
        memory_bytes: memoryBytes,
        environments_json: environmentsJson,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
        last_seen_at: lastSeenAt,
      });
      return okResult(undefined, { changes: existing ? 0 : 1 });
    } else if (this.query.includes("INSERT INTO workstation_defaults")) {
      const [ownerPrincipal, workstationId] = this.values as [string, string, string];
      this.db.workstationDefaults.set(ownerPrincipal, workstationId);
      return okResult(undefined, { changes: 1 });
    } else if (this.query.includes("INSERT INTO workstation_attach_jobs")) {
      const [id, notebookId, ownerPrincipal, workstationId, actorLabel, requestedAt, updatedAt] =
        this.values as [string, string, string, string, string, string, string];
      this.db.workstationAttachJobs.set(id, {
        id,
        notebook_id: notebookId,
        owner_principal: ownerPrincipal,
        workstation_id: workstationId,
        status: "pending",
        requested_by_actor_label: actorLabel,
        requested_at: requestedAt,
        updated_at: updatedAt,
        accepted_at: null,
        finished_at: null,
        error_message: null,
      });
      return okResult(undefined, { changes: 1 });
    } else if (this.query.includes("UPDATE workstation_attach_jobs")) {
      const [
        status,
        updatedAt,
        statusForAcceptedAt,
        acceptedAt,
        statusForFinishedAt,
        finishedAt,
        errorMessage,
        jobId,
        ownerPrincipal,
        workstationId,
      ] = this.values as [
        WorkstationAttachJobRow["status"],
        string,
        WorkstationAttachJobRow["status"],
        string,
        WorkstationAttachJobRow["status"],
        string,
        string | null,
        string,
        string,
        string,
      ];
      const job = this.db.workstationAttachJobs.get(jobId);
      if (job && job.owner_principal === ownerPrincipal && job.workstation_id === workstationId) {
        job.status = status;
        job.updated_at = updatedAt;
        if (
          (statusForAcceptedAt === "accepted" || statusForAcceptedAt === "running") &&
          job.accepted_at === null
        ) {
          job.accepted_at = acceptedAt;
        }
        if (
          statusForFinishedAt === "failed" ||
          statusForFinishedAt === "completed" ||
          statusForFinishedAt === "cancelled"
        ) {
          job.finished_at = finishedAt;
        }
        job.error_message = errorMessage;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (this.query.includes("INSERT INTO notebooks")) {
      const [id, ownerPrincipal, maybeTitleOrCreatedAt, createdAtOrUpdatedAt, maybeUpdatedAt] = this
        .values as [string, string, string | null, string | undefined, string | undefined];
      const hasTitleColumn = this.query.includes(" title,");
      const title = hasTitleColumn ? maybeTitleOrCreatedAt : null;
      const createdAtSource = hasTitleColumn ? createdAtOrUpdatedAt : maybeTitleOrCreatedAt;
      const updatedAtSource = hasTitleColumn ? maybeUpdatedAt : createdAtOrUpdatedAt;
      const createdAt = updatedAtSource ? createdAtSource : undefined;
      const updatedAt = updatedAtSource ?? createdAtSource;
      if (!updatedAt) {
        throw new Error("fake notebook insert did not receive an updated_at value");
      }
      const existing = this.db.notebooks.get(id);
      if (existing && this.query.includes("DO NOTHING")) {
        return okResult(undefined, { changes: 0 });
      }
      this.db.notebooks.set(id, {
        id,
        owner_principal: existing?.owner_principal ?? ownerPrincipal,
        title: existing?.title ?? title,
        created_at: existing?.created_at ?? createdAt ?? updatedAt,
        updated_at: updatedAt,
        latest_revision_id: existing?.latest_revision_id ?? null,
      });
      return okResult(undefined, { changes: 1 });
    } else if (this.query.includes("INSERT INTO notebook_revisions")) {
      const [
        id,
        notebookId,
        runtimeStateDocId,
        notebookHeadsHash,
        runtimeHeadsHash,
        commsHeadsHash,
        snapshotKey,
        runtimeSnapshotKey,
        commsSnapshotKey,
        actorLabel,
      ] = this.values as [
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
      ];
      this.db.revisions.push({
        id,
        notebook_id: notebookId,
        runtime_state_doc_id: runtimeStateDocId,
        notebook_heads_hash: notebookHeadsHash,
        runtime_heads_hash: runtimeHeadsHash,
        comms_heads_hash: commsHeadsHash,
        snapshot_key: snapshotKey,
        runtime_snapshot_key: runtimeSnapshotKey,
        comms_snapshot_key: commsSnapshotKey,
        actor_label: actorLabel,
        created_at: new Date().toISOString(),
      });
    } else if (
      this.query.includes("UPDATE notebooks") &&
      this.query.includes("latest_revision_id")
    ) {
      const [revisionId, updatedAt, notebookId] = this.values as [string, string, string];
      const existing = this.db.notebooks.get(notebookId);
      if (existing) {
        existing.latest_revision_id = revisionId;
        existing.updated_at = updatedAt;
      }
    } else if (this.query.includes("UPDATE notebooks") && this.query.includes("SET title")) {
      const [title, updatedAt, notebookId] = this.values as [string | null, string, string];
      const existing = this.db.notebooks.get(notebookId);
      if (!existing) {
        return okResult(undefined, { changes: 0 });
      }
      existing.title = title;
      existing.updated_at = updatedAt;
      return okResult(undefined, { changes: 1 });
    } else if (this.query.includes("UPDATE notebooks") && this.query.includes("owner_principal")) {
      const [canonicalPrincipal, updatedAt, transportPrincipal] = this.values as [
        string,
        string,
        string,
      ];
      for (const notebook of this.db.notebooks.values()) {
        if (notebook.owner_principal !== transportPrincipal) continue;
        notebook.owner_principal = canonicalPrincipal;
        notebook.updated_at = updatedAt;
      }
    } else if (this.query.includes("UPDATE notebooks")) {
      const [updatedAt, notebookId] = this.values as [string, string];
      const existing = this.db.notebooks.get(notebookId);
      if (existing) {
        existing.updated_at = updatedAt;
      }
    } else if (this.query.includes("INSERT INTO notebook_blobs")) {
      const [notebookId, hash, size, contentType, r2Key] = this.values as [
        string,
        string,
        number,
        string | null,
        string,
      ];
      this.db.blobs.set(`${notebookId}:${hash}`, {
        notebook_id: notebookId,
        hash,
        size,
        content_type: contentType,
        r2_key: r2Key,
        uploaded_at: new Date().toISOString(),
      });
    } else if (this.query.includes("INSERT INTO principal_profiles")) {
      const [
        principal,
        provider,
        providerSubject,
        emailNormalized,
        emailVerified,
        displayName,
        avatarUrl,
        firstSeenAt,
        lastSeenAt,
        rawClaimsJson,
      ] = this.values as [
        string,
        string,
        string | null,
        string | null,
        number,
        string | null,
        string | null,
        string,
        string,
        string | null,
      ];
      const existing = this.db.profiles.get(principal);
      this.db.profiles.set(principal, {
        principal,
        provider,
        provider_subject: existing?.provider_subject ?? providerSubject,
        email_normalized: emailNormalized,
        email_verified: emailVerified,
        display_name: displayName,
        avatar_url: avatarUrl,
        first_seen_at: existing?.first_seen_at ?? firstSeenAt,
        last_seen_at: lastSeenAt,
        raw_claims_json: rawClaimsJson,
      });
    } else if (this.query.includes("INSERT INTO principal_account_links")) {
      const [
        transportPrincipal,
        canonicalPrincipal,
        provider,
        emailNormalized,
        firstSeenAt,
        lastSeenAt,
      ] = this.values as [string, string, string, string | null, string, string];
      const existing = this.db.accountLinks.get(transportPrincipal);
      this.db.accountLinks.set(transportPrincipal, {
        transport_principal: transportPrincipal,
        canonical_principal: canonicalPrincipal,
        provider,
        email_normalized: emailNormalized,
        first_seen_at: existing?.first_seen_at ?? firstSeenAt,
        last_seen_at: lastSeenAt,
      });
    } else if (this.query.includes("UPDATE notebook_invites")) {
      const [principal, acceptedAt, inviteId, email, providerHint, now] = this.values as [
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      const invite = this.db.invites.get(inviteId);
      if (
        invite &&
        invite.status === "pending" &&
        invite.email_normalized === email &&
        (invite.provider_hint === providerHint || invite.provider_hint === null) &&
        (!invite.expires_at || Date.parse(invite.expires_at) > Date.parse(now)) &&
        this.db.notebooks.has(invite.notebook_id)
      ) {
        invite.status = "accepted";
        invite.accepted_by_principal = principal;
        invite.accepted_at = acceptedAt;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    }
    return okResult();
  }

  private insertAclIfMissing(row: NotebookAclRow): void {
    const existing = this.db.acl.find(
      (candidate) =>
        candidate.notebook_id === row.notebook_id &&
        candidate.subject_kind === row.subject_kind &&
        candidate.subject === row.subject &&
        candidate.scope === row.scope,
    );
    if (existing) {
      existing.updated_at = row.updated_at;
      return;
    }
    this.db.acl.push(row);
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM notebook_access_requests")) {
      if (this.query.includes("requester_principal = ?")) {
        const [notebookId, requesterPrincipal] = this.values as [string, string];
        return (
          ([...this.db.accessRequests.values()]
            .filter(
              (accessRequest) =>
                accessRequest.notebook_id === notebookId &&
                accessRequest.requester_principal === requesterPrincipal &&
                (!this.query.includes("status = 'pending'") || accessRequest.status === "pending"),
            )
            .sort(
              (left, right) =>
                right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
            )[0] as T | undefined) ?? null
        );
      }
      const [notebookId, requestId] = this.values as [string, string];
      return (
        ([...this.db.accessRequests.values()].find(
          (accessRequest) =>
            accessRequest.notebook_id === notebookId && accessRequest.id === requestId,
        ) as T | undefined) ?? null
      );
    }
    if (this.query.includes("FROM principal_account_links")) {
      if (this.query.includes("canonical_principal = ?")) {
        const [canonicalPrincipal, exceptTransportPrincipal] = this.values as [string, string];
        return (
          ([...this.db.accountLinks.values()].find(
            (link) =>
              link.canonical_principal === canonicalPrincipal &&
              link.transport_principal !== exceptTransportPrincipal,
          ) as T | undefined) ?? null
        );
      }
      return (this.db.accountLinks.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (this.query.includes("FROM workstations")) {
      const [ownerPrincipal, workstationId] = this.values as [string, string];
      return (
        (this.db.workstations.get(workstationKey(ownerPrincipal, workstationId)) as
          | T
          | undefined) ?? null
      );
    }
    if (this.query.includes("FROM workstation_defaults")) {
      const ownerPrincipal = this.values[0] as string;
      const workstationId = this.db.workstationDefaults.get(ownerPrincipal);
      return workstationId ? ({ workstation_id: workstationId } as T) : null;
    }
    if (this.query.includes("FROM workstation_attach_jobs")) {
      if (this.query.includes("notebook_id = ?")) {
        const [notebookId, ownerPrincipal, workstationId] = this.values as [string, string, string];
        return (
          ([...this.db.workstationAttachJobs.values()]
            .filter(
              (job) =>
                job.notebook_id === notebookId &&
                job.owner_principal === ownerPrincipal &&
                job.workstation_id === workstationId &&
                (job.status === "pending" || job.status === "accepted" || job.status === "running"),
            )
            .sort((left, right) => right.requested_at.localeCompare(left.requested_at))[0] as
            | T
            | undefined) ?? null
        );
      }
      const [jobId, ownerPrincipal, workstationId] = this.values as [string, string, string];
      const job = this.db.workstationAttachJobs.get(jobId);
      return job?.owner_principal === ownerPrincipal && job.workstation_id === workstationId
        ? (job as T)
        : null;
    }
    if (this.query.includes("FROM notebook_invites")) {
      if (this.query.includes("WHERE notebook_id = ?")) {
        const [notebookId, email, scope, providerHint] = this.values as [
          string,
          string,
          PendingNotebookInviteRow["scope"],
          string | null,
          string | null,
        ];
        return (
          ([...this.db.invites.values()].find(
            (invite) =>
              invite.notebook_id === notebookId &&
              invite.email_normalized === email &&
              invite.scope === scope &&
              invite.status === "pending" &&
              invite.provider_hint === providerHint,
          ) as T | undefined) ?? null
        );
      }
      return (this.db.invites.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (
      this.query.includes("FROM notebooks n") &&
      this.query.includes("JOIN notebook_acl a") &&
      this.query.includes("a.subject_kind = 'public'")
    ) {
      const notebookId = this.values[0] as string;
      const notebook = this.db.notebooks.get(notebookId);
      const publicViewer = this.db.acl.some(
        (row) =>
          row.notebook_id === notebookId &&
          row.subject_kind === "public" &&
          row.subject === "anonymous" &&
          row.scope === "viewer",
      );
      return (notebook?.latest_revision_id && publicViewer ? notebook : null) as T | null;
    }
    if (this.query.includes("FROM notebooks")) {
      return (this.db.notebooks.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (this.query.includes("FROM principal_profiles")) {
      return (this.db.profiles.get(this.values[0] as string) as T | undefined) ?? null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM notebook_access_requests")) {
      const notebookId = this.values[0] as string;
      const limit = typeof this.values[1] === "number" ? this.values[1] : Number.POSITIVE_INFINITY;
      return okResult(
        [...this.db.accessRequests.values()]
          .filter((accessRequest) => accessRequest.notebook_id === notebookId)
          .sort(
            (left, right) =>
              right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
          )
          .slice(0, limit) as T[],
      );
    }
    if (this.query.includes("FROM principal_profiles")) {
      if (this.query.includes("email_normalized = ?")) {
        const [email] = this.values as [string];
        return okResult(
          [...this.db.profiles.values()].filter(
            (profile) => profile.email_normalized === email && profile.email_verified === 1,
          ) as T[],
        );
      }
      const principals = new Set(this.values as string[]);
      if (this.values.length > 100) {
        throw new Error("D1_ERROR: too many SQL variables");
      }
      return okResult(
        [...this.db.profiles.values()].filter((profile) =>
          principals.has(profile.principal),
        ) as T[],
      );
    }
    if (
      this.query.includes("FROM notebook_invites") &&
      this.query.includes("WHERE notebook_id = ?")
    ) {
      const notebookId = this.values[0] as string;
      const limit = typeof this.values[1] === "number" ? this.values[1] : Number.POSITIVE_INFINITY;
      return okResult(
        [...this.db.invites.values()]
          .filter((invite) => invite.notebook_id === notebookId)
          .sort(
            (left, right) =>
              right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
          )
          .slice(0, limit) as T[],
      );
    }
    if (this.query.includes("FROM workstations")) {
      const ownerPrincipal = this.values[0] as string;
      return okResult(
        [...this.db.workstations.values()]
          .filter((workstation) => workstation.owner_principal === ownerPrincipal)
          .sort(
            (left, right) =>
              (right.last_seen_at ?? right.updated_at).localeCompare(
                left.last_seen_at ?? left.updated_at,
              ) || right.workstation_id.localeCompare(left.workstation_id),
          ) as T[],
      );
    }
    if (this.query.includes("FROM workstation_attach_jobs")) {
      const [ownerPrincipal, workstationId, limitValue] = this.values as [string, string, number];
      const limit = Number.isFinite(limitValue) ? limitValue : Number.POSITIVE_INFINITY;
      return okResult(
        [...this.db.workstationAttachJobs.values()]
          .filter(
            (job) =>
              job.owner_principal === ownerPrincipal &&
              job.workstation_id === workstationId &&
              job.status === "pending",
          )
          .sort((left, right) => left.requested_at.localeCompare(right.requested_at))
          .slice(0, limit) as T[],
      );
    }
    if (this.query.includes("FROM notebooks n") && this.query.includes("JOIN notebook_acl a")) {
      const [principal, linkedPrincipal, limitValue] = this.values as [string, string, number];
      const linked = this.db.accountLinks.get(linkedPrincipal)?.canonical_principal;
      const subjects = new Set([principal, ...(linked ? [linked] : [])]);
      const byNotebook = new Map<
        string,
        NotebookRow & { scope: NotebookAclRow["scope"]; scopeRank: number }
      >();

      for (const row of this.db.acl) {
        if (row.subject_kind !== "principal" || !subjects.has(row.subject)) {
          continue;
        }
        const notebook = this.db.notebooks.get(row.notebook_id);
        if (!notebook) {
          continue;
        }
        const rank = scopeRank(row.scope);
        const existing = byNotebook.get(notebook.id);
        if (!existing || rank > existing.scopeRank) {
          byNotebook.set(notebook.id, {
            ...notebook,
            scope: row.scope,
            scopeRank: rank,
          });
        }
      }

      const limit = Number.isFinite(limitValue) ? limitValue : Number.POSITIVE_INFINITY;
      return okResult(
        [...byNotebook.values()]
          .sort(
            (left, right) =>
              right.updated_at.localeCompare(left.updated_at) ||
              right.created_at.localeCompare(left.created_at) ||
              right.id.localeCompare(left.id),
          )
          .slice(0, limit)
          .map(({ scopeRank: _scopeRank, ...row }) => row) as T[],
      );
    }
    if (this.query.includes("FROM notebook_acl")) {
      const notebookId = this.values[0] as string;
      if (
        !this.query.includes("subject_kind = 'principal'") &&
        !this.query.includes("subject_kind = 'public'")
      ) {
        return okResult(this.db.acl.filter((row) => row.notebook_id === notebookId) as T[]);
      }
      if (this.query.includes("subject_kind = 'principal'")) {
        const principal = this.values[1] as string;
        const linked = this.db.accountLinks.get(principal)?.canonical_principal;
        const subjects = new Set([principal, ...(linked ? [linked] : [])]);
        return okResult(
          this.db.acl.filter(
            (row) =>
              row.notebook_id === notebookId &&
              row.subject_kind === "principal" &&
              subjects.has(row.subject),
          ) as T[],
        );
      }
      if (this.query.includes("subject_kind = 'public'")) {
        return okResult(
          this.db.acl.filter(
            (row) =>
              row.notebook_id === notebookId &&
              row.subject_kind === "public" &&
              row.subject === "anonymous",
          ) as T[],
        );
      }
    }
    if (this.query.includes("FROM notebook_revisions")) {
      const notebookId = this.values[0] as string;
      return okResult(
        this.db.revisions.filter((revision) => revision.notebook_id === notebookId) as T[],
      );
    }
    if (this.query.includes("FROM notebook_blobs")) {
      const notebookId = this.values[0] as string;
      return okResult(
        Array.from(this.db.blobs.values()).filter((blob) => blob.notebook_id === notebookId) as T[],
      );
    }
    if (this.query.includes("FROM notebook_invites")) {
      const [email, provider, now] = this.values as [string, string, string];
      return okResult(
        Array.from(this.db.invites.values()).filter(
          (invite) =>
            invite.email_normalized === email &&
            invite.status === "pending" &&
            (invite.provider_hint === provider || invite.provider_hint === null) &&
            (!invite.expires_at || Date.parse(invite.expires_at) > Date.parse(now)),
        ) as T[],
      );
    }
    return okResult([]);
  }
}

function scopeRank(scope: NotebookAclRow["scope"]): number {
  switch (scope) {
    case "owner":
      return 4;
    case "editor":
      return 3;
    case "runtime_peer":
      return 2;
    case "viewer":
      return 1;
  }
}

function workstationKey(ownerPrincipal: string, workstationId: string): string {
  return `${ownerPrincipal}\0${workstationId}`;
}

interface BlobRow {
  notebook_id: string;
  hash: string;
  size: number;
  content_type: string | null;
  r2_key: string;
  uploaded_at: string;
}

function okResult<T = unknown>(results?: T[], meta: Record<string, unknown> = {}): D1Result<T> {
  return {
    results,
    success: true,
    meta,
  };
}

class FakeR2Bucket implements R2Bucket {
  readonly objects = new Map<string, FakeR2Object>();
  readonly getKeys: string[] = [];

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getKeys.push(key);
    return this.objects.get(key) ?? null;
  }

  async head(key: string): Promise<R2Object | null> {
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const object = new FakeR2Object(
      key,
      await toBytes(value),
      options?.httpMetadata,
      options?.customMetadata,
    );
    this.objects.set(key, object);
    return object;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeR2Object implements R2ObjectBody {
  readonly version = "fake-version";
  readonly etag = "fake-etag";
  readonly httpEtag = '"fake-etag"';
  readonly uploaded = new Date("2026-05-22T00:00:00.000Z");

  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly httpMetadata?: R2HTTPMetadata,
    readonly customMetadata?: Record<string, string>,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  get body(): ReadableStream {
    return new Response(this.bytes).body!;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    );
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) {
      headers.set("Content-Type", this.httpMetadata.contentType);
    }
  }
}

async function toBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) {
    return new Uint8Array();
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}
