import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.ts";
import {
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
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
import { initializeRuntimedWasm } from "../src/runtimed-wasm.ts";
import {
  blobKey,
  createNotebookWithOwnerAcl,
  getNotebookAclRows,
  getNotebookAclRowsForPrincipal,
  renderKey,
  snapshotKey,
} from "../src/storage.ts";
import { accessTokenFixture } from "./access-jwt-fixture.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);

before(async () => {
  await initializeRuntimedWasm(wasmBytes);
});

describe("Worker artifact routes", () => {
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

  it("keeps render caches derived from snapshot pairs instead of accepting uploads", async () => {
    const env = fakeEnv();
    const response = await ownerPut(
      env,
      "/api/n/readonly-demo/renders/heads-viewer",
      new TextEncoder().encode(JSON.stringify({ cells: [] })),
      {
        "Content-Type": "application/json",
      },
    );

    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: "method not allowed" });
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

  it("does not let authenticated principals fall back to public ACL rows", async () => {
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
    assert.equal(authenticated.status, 403);
    assert.deepEqual(await authenticated.json(), {
      error: "user:dev:bob cannot access public-demo",
    });
  });

  it("authorizes Cloudflare Access principals through notebook ACL rows", async () => {
    const { env: accessEnv, token } = await accessTokenFixture({ subject: "alice" });
    const env = fakeEnv(accessEnv);
    seedNotebook(env, "access-demo");
    seedAcl(env, {
      notebookId: "access-demo",
      subject: "user:cloudflare-access:alice",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/n/access-demo?scope=viewer", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const catalog = (await response.json()) as { notebook: { id: string } };
    assert.equal(catalog.notebook.id, "access-demo");
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

    await createNotebookWithOwnerAcl(env, "race-demo", alice);
    await createNotebookWithOwnerAcl(env, "race-demo", bob);

    assert.deepEqual(env.DB.batchSizes.slice(-2), [2, 2]);
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

  it("allows same-origin cookie-backed Access WebSocket upgrades by default", async () => {
    const { env: accessEnv, token } = await accessTokenFixture({ subject: "alice" });
    let roomFetches = 0;
    const env = fakeEnv({
      ...accessEnv,
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
    seedNotebook(env, "cookie-origin-demo");
    seedAcl(env, {
      notebookId: "cookie-origin-demo",
      subject: "user:cloudflare-access:alice",
      scope: "owner",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-origin-demo/sync?operator=browser:tab&scope=owner", {
        headers: {
          Cookie: `CF_Authorization=${token}`,
          Origin: "https://cloud.test",
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(roomFetches, 1);
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

  it("rejects cookie-backed WebSocket upgrades with no Origin before room dispatch", async () => {
    const { env: accessEnv, token } = await accessTokenFixture({ subject: "alice" });
    let roomFetches = 0;
    const env = fakeEnv({
      ...accessEnv,
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
      new Request("https://cloud.test/n/cookie-origin-demo/sync?operator=browser:tab&scope=owner", {
        headers: {
          Cookie: `CF_Authorization=${token}`,
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

  it("rejects cookie-backed WebSocket upgrades from untrusted origins by default", async () => {
    const { env: accessEnv, token } = await accessTokenFixture({ subject: "alice" });
    let roomFetches = 0;
    const env = fakeEnv({
      ...accessEnv,
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
      new Request("https://cloud.test/n/cookie-origin-demo/sync?operator=browser:tab&scope=owner", {
        headers: {
          Cookie: `CF_Authorization=${token}`,
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

  it("rejects allowlisted WebSocket upgrades when the browser sends no Origin", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_ALLOWED_ORIGINS: "https://notebooks.example.com",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/acl-demo/sync?viewer_session=missing", {
        headers: {
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "websocket origin is required" });
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

  it("publishes a snapshot pair and materializes render JSON through the route layer", async () => {
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
    );
    assert.equal(runtimePut.status, 201);
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
      },
    );
    assert.equal(notebookPut.status, 201);
    assert.deepEqual(
      env.DB.acl.map((row) => [row.notebook_id, row.subject_kind, row.subject, row.scope]),
      [
        ["route-demo", "principal", "user:dev:alice", "owner"],
        ["route-demo", "public", "anonymous", "viewer"],
      ],
    );
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("route-demo", "heads-fixture")),
      true,
      "snapshot publish should pre-materialize a render cache for complete snapshot pairs",
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/n/route-demo/render"),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 200);
    const render = (await response.json()) as {
      source: string;
      cells: Array<{ id: string; outputs: Array<{ output_id: string }> }>;
    };

    assert.equal(render.source, "snapshot-pair");
    assert.equal(render.cells[0].id, "cell-1");
    assert.deepEqual(
      render.cells[0].outputs.map((output) => output.output_id),
      [
        "c8b09c2d-a456-5186-b875-441a5fadf374",
        "58af4526-9a90-5bca-98de-d8d0e36718b2",
        "cad63e3f-42e3-542b-b28b-5d3acde7906d",
      ],
    );
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("route-demo", "heads-fixture")),
      true,
      "materialized render should be cached back into R2",
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
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await response.json()) as { error: string; details: string };
    assert.equal(body.error, "render materialization failed");
    assert.match(body.details, /load|document|decode|automerge/i);
    assert.equal(env.DB.revisions.length, 0);
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(snapshotKey("corrupt-demo", "heads-corrupt")),
      false,
      "rejected snapshot publish should not leave a corrupt notebook snapshot",
    );
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("corrupt-demo", "heads-corrupt")),
      false,
      "failed publish materialization should not cache a render object",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "[notebook-cloud]");
    assert.equal((warnings[0][1] as { event: string }).event, "render.materialization.failed");
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
    assert.equal(body.error, "render materialization missing blobs");
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
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.has(renderKey("missing-blob-demo", "heads-fixture")),
      false,
      "failed blob validation should not cache a render object",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "[notebook-cloud]");
    assert.equal(
      (warnings[0][1] as { event: string }).event,
      "render.materialization.missing_blobs",
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

interface RevisionRow {
  id: string;
  notebook_id: string;
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  snapshot_key: string;
  runtime_snapshot_key: string | null;
  actor_label: string;
  created_at: string;
}

class FakeD1 implements D1Database {
  readonly notebooks = new Map<string, NotebookRow>();
  readonly revisions: RevisionRow[] = [];
  readonly blobs = new Map<string, BlobRow>();
  readonly acl: NotebookAclRow[] = [];
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
    } else if (this.query.includes("INSERT INTO notebooks")) {
      const [id, ownerPrincipal, createdAtOrUpdatedAt, maybeUpdatedAt] = this.values as [
        string,
        string,
        string,
        string | undefined,
      ];
      const createdAt = maybeUpdatedAt ? createdAtOrUpdatedAt : undefined;
      const updatedAt = maybeUpdatedAt ?? createdAtOrUpdatedAt;
      const existing = this.db.notebooks.get(id);
      if (existing && this.query.includes("DO NOTHING")) {
        return okResult();
      }
      this.db.notebooks.set(id, {
        id,
        owner_principal: existing?.owner_principal ?? ownerPrincipal,
        title: existing?.title ?? null,
        created_at: existing?.created_at ?? createdAt ?? updatedAt,
        updated_at: updatedAt,
        latest_revision_id: existing?.latest_revision_id ?? null,
      });
    } else if (this.query.includes("INSERT INTO notebook_revisions")) {
      const [
        id,
        notebookId,
        notebookHeadsHash,
        runtimeHeadsHash,
        snapshotKey,
        runtimeSnapshotKey,
        actorLabel,
      ] = this.values as [string, string, string, string | null, string, string | null, string];
      this.db.revisions.push({
        id,
        notebook_id: notebookId,
        notebook_heads_hash: notebookHeadsHash,
        runtime_heads_hash: runtimeHeadsHash,
        snapshot_key: snapshotKey,
        runtime_snapshot_key: runtimeSnapshotKey,
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
    if (this.query.includes("FROM notebooks")) {
      return (this.db.notebooks.get(this.values[0] as string) as T | undefined) ?? null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
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
        return okResult(
          this.db.acl.filter(
            (row) =>
              row.notebook_id === notebookId &&
              row.subject_kind === "principal" &&
              row.subject === principal,
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
    return okResult([]);
  }
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

  async get(key: string): Promise<R2ObjectBody | null> {
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
    const object = new FakeR2Object(key, await toBytes(value), options?.httpMetadata);
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
  readonly customMetadata = {};

  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly httpMetadata?: R2HTTPMetadata,
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
