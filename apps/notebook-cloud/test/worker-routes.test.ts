import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { snapshotBlobRefsOverCap } from "../src/index.ts";
import { NOTEBOOK_CLOUD_APP_SESSION_COOKIE_NAME } from "../src/app-session.ts";
import {
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  TRUSTED_SCOPE_HEADER,
  TRUSTED_WEBSOCKET_PROTOCOL_HEADER,
  authenticateDevRequest,
} from "../src/identity.ts";
import {
  NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY,
  NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
  NOTEBOOK_CLOUD_USER_STORAGE_KEY,
} from "../src/dev-auth-storage.ts";
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
import type { NotebookComputeSessionSummary } from "runtimed";
import type { WorkstationLeaseRecord } from "../src/compute-session-index.ts";
import { NotebookHandle, RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import {
  WORKSTATION_ATTACH_PENDING_STALE_MS,
  WORKSTATION_ATTACH_JOB_STALE_MS,
  blobKey,
  commsDocSnapshotKey,
  createNotebookWithOwnerAcl,
  getNotebookAclRows,
  getNotebookAclRowsForPrincipal,
  roomSummaryKey,
  runtimeStateSnapshotKey,
  runCatalogMigrations,
  snapshotKey,
} from "../src/storage.ts";
import type { PendingNotebookInviteRow, PrincipalProfileRow } from "../src/sharing-storage.ts";
import { canonicalAccountPrincipalForProfile } from "../src/sharing-storage.ts";
import type { PrincipalAccountLinkRow } from "../src/storage.ts";
import type {
  WorkstationCredentialRow,
  WorkstationPairingCodeRow,
} from "../src/workstation-credentials.ts";
import { workstationEventsObjectName } from "../src/workstation-events.ts";
import { oidcTokenFixture } from "./oidc-jwt-fixture.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";

const APP_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

before(async () => {
  await initializeTestRuntimedWasm();
});

describe("Worker artifact routes", () => {
  it("reports direct OIDC readiness without exposing configured values", async () => {
    const env = fakeEnv({
      NOTEBOOK_CLOUD_BUILD_SHA: "9C0CE3594ED68F773A40E1A8FD9352A46BE48F69",
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
      build: {
        sha: string;
      };
      auth: {
        oidc: {
          audience: string;
          jwks: string;
          principal_namespace: string;
          status: string;
        };
      };
    };
    assert.deepEqual(body.build, {
      sha: "9c0ce3594ed68f773a40e1a8fd9352a46be48f69",
    });
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

  it("reports an unknown build SHA when deployment metadata is absent", async () => {
    const response = await worker.fetch(
      new Request("https://cloud.test/api/health"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { build: { sha: string | null } };
    assert.deepEqual(body.build, { sha: null });
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
    const seenPaths: string[] = [];
    const env = fakeEnv({
      ASSETS: {
        fetch: async (request) => {
          seenPaths.push(new URL(request.url).pathname);
          return new Response("console.log('viewer')", {
            headers: { "Content-Type": "application/javascript" },
          });
        },
      },
    });

    for (const asset of ["notebook-cloud-viewer.js", "notebook-cloud-oidc.js"]) {
      const response = await worker.fetch(
        new Request(`http://localhost/assets/${asset}`),
        env,
        fakeContext(),
      );

      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", asset);
      assert.equal(await response.text(), "console.log('viewer')", asset);
    }
    assert.deepEqual(seenPaths, [
      "/assets/notebook-cloud-viewer.js",
      "/assets/notebook-cloud-oidc.js",
    ]);
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
    assert.match(html, /<title>nteract notebook: Topic Viz<\/title>/);
    assert.match(html, /"notebookId":"notebook-123"/);
    assert.doesNotMatch(html, /topic-viz.*render/);
  });

  it("preserves acronym-looking words in route-derived viewer titles", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/n/notebook-123/Quill%20HF%20workstation%20smoke"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>nteract notebook: Quill HF Workstation Smoke<\/title>/);
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

  it("emits public OG image metadata for raster revision covers", async () => {
    const env = fakeEnv();
    const coverHash = "public-meta-cover-hash";
    seedNotebook(env, "public-meta-cover");
    const notebook = env.DB.notebooks.get("public-meta-cover");
    assert.ok(notebook);
    notebook.title = "Public Cover";
    seedRevision(env, {
      id: "revision-public-cover",
      notebookId: "public-meta-cover",
      coverBlobHash: coverHash,
      coverMime: "image/jpeg",
    });
    seedAcl(env, {
      notebookId: "public-meta-cover",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(blobKey("public-meta-cover", coverHash), new Uint8Array([1]), {
      httpMetadata: { contentType: "image/jpeg" },
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/public-meta-cover/public-cover"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(
      html,
      /<meta property="og:image" content="http:\/\/localhost\/n\/public-meta-cover\/r\/latest\/ogImage\.png" \/>/,
    );
    assert.match(html, /<meta property="og:image:type" content="image\/jpeg" \/>/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  });

  it("does not attach latest OG image metadata to pinned revision shells", async () => {
    const env = fakeEnv();
    seedNotebook(env, "pinned-meta-cover");
    const notebook = env.DB.notebooks.get("pinned-meta-cover");
    assert.ok(notebook);
    notebook.title = "Pinned Cover";
    seedRevision(env, {
      id: "revision-old-cover",
      notebookId: "pinned-meta-cover",
      coverBlobHash: "old-cover",
      coverMime: "image/png",
    });
    seedRevision(env, {
      id: "revision-latest-cover",
      notebookId: "pinned-meta-cover",
      coverBlobHash: "latest-cover",
      coverMime: "image/png",
    });
    seedAcl(env, {
      notebookId: "pinned-meta-cover",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(
      blobKey("pinned-meta-cover", "latest-cover"),
      new Uint8Array([1]),
      { httpMetadata: { contentType: "image/png" } },
    );

    const response = await worker.fetch(
      new Request(
        `http://localhost/n/pinned-meta-cover/r/${encodeURIComponent("heads:revision-old-cover")}`,
      ),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Pinned Cover is a public nteract notebook at revision heads:revisi/);
    assert.doesNotMatch(html, /\/n\/pinned-meta-cover\/r\/latest\/ogImage\.png/);
    assert.match(html, /<meta name="twitter:card" content="summary" \/>/);
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
    assert.match(html, /<title>nteract notebook: Secret Plan<\/title>/);
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

  it("supports HEAD requests for hosted app shell routes", async () => {
    const env = fakeEnv();

    for (const pathname of ["/n", "/oidc", "/n/head-demo/debug"]) {
      const response = await worker.fetch(
        new Request(`http://localhost${pathname}`, { method: "HEAD" }),
        env,
        fakeContext(),
      );

      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get("Content-Type") ?? "", /text\/html/, pathname);
      assert.equal(await response.text(), "", pathname);
    }
  });

  it("short-circuits notebook shell HEAD requests before asset bootstrap", async () => {
    const seenAssetPaths: string[] = [];
    const response = await worker.fetch(
      new Request("http://localhost/n/head-demo/Example", { method: "HEAD" }),
      fakeEnv({ ASSETS: fakeNotebookRouteAssets(seenAssetPaths) }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    assert.equal(await response.text(), "");
    assert.deepEqual(seenAssetPaths, []);
  });

  it("serves loopback local dev auth bootstrap without exposing external credentials", async () => {
    const response = await worker.fetch(
      new Request("http://127.0.0.1/local-auth?user=alice&scope=owner&next=/n"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
    const html = await response.text();
    assert.match(html, /Preparing local cloud auth/);
    assert.match(html, new RegExp(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY));
    assert.match(html, new RegExp(NOTEBOOK_CLOUD_USER_STORAGE_KEY));
    assert.match(html, new RegExp(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY));
    assert.match(html, /"local-loopback-dev-token"/);
    assert.match(html, /"alice"/);
    assert.match(html, /"owner"/);
    assert.match(html, /"next":"\/n"/);
    assert.doesNotMatch(html, /NOTEBOOK_CLOUD_DEV_TOKEN|NTERACT_API_KEY|Authorization/);
  });

  it("rejects local dev auth bootstrap on non-loopback hosts", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/local-auth?user=alice&scope=owner"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 403);
  });

  it("accepts local dev auth bootstrap when Wrangler preserves a loopback Host header", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/local-auth?user=alice&scope=owner", {
        headers: { Host: "localhost:45316" },
      }),
      fakeEnv({ NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS: "true" }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
  });

  it("rejects local dev auth bootstrap when loopback Host headers are not trusted", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/local-auth?user=alice&scope=owner", {
        headers: { Host: "localhost:45316" },
      }),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 403);
  });

  it("accepts local dev auth bootstrap when Wrangler reports a loopback client IP", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/local-auth?user=alice&scope=owner", {
        headers: { "CF-Connecting-IP": "127.0.0.1" },
      }),
      fakeEnv({ NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS: "true" }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
  });

  it("rejects local dev auth bootstrap when loopback client IP headers are not trusted", async () => {
    const response = await worker.fetch(
      new Request("https://preview.runt.run/local-auth?user=alice&scope=owner", {
        headers: { "CF-Connecting-IP": "127.0.0.1" },
      }),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 403);
  });

  it("normalizes unsafe local dev auth bootstrap inputs", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/local-auth?user=&scope=runtime_peer&next=https://evil.test"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /"browser-editor"/);
    assert.match(html, /"owner"/);
    assert.match(html, /"next":"\/n"/);
  });

  it("keeps the old loopback local dev auth path available as an alias", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/dev/local-auth?user=alice&scope=owner"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
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

  it("reads app session cookie status without exposing identity credentials", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "session-status-user",
      email: "session-status@example.test",
      extraPayload: { email_verified: true },
      name: "Session Status User",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/api/auth/session", {
        headers: { Cookie: cookie },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const bodyText = await response.text();
    assert.doesNotMatch(bodyText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(bodyText, /session-status@example\.test/);
    assert.doesNotMatch(bodyText, /session-status-user/);
    const body = JSON.parse(bodyText) as {
      ok: boolean;
      session: { provider: string; expires_at: number; cache_key: string } | null;
    };
    assert.equal(body.ok, true);
    assert.equal(body.session?.provider, "oidc");
    assert.equal(typeof body.session?.expires_at, "number");
    assert.equal(typeof body.session?.cache_key, "string");
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

  it("temporarily redirects the hosted root to the notebook home", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("https://cloud.test/?source=bookmark"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "https://cloud.test/n?source=bookmark");
  });

  it("bootstraps the notebook home from a valid app session cookie", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "bootstrap-user",
      email: "bootstrap@example.test",
      extraPayload: { email_verified: true },
      name: "Bootstrap User",
    });
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
    // A live peer in the room: their identity must not leak into served HTML
    // any more than the requester's does (presence rides the API, not SSR).
    await env.NOTEBOOK_SNAPSHOTS.put(
      roomSummaryKey("bootstrap-visible"),
      JSON.stringify({
        version: 1,
        notebook_id: "bootstrap-visible",
        updated_at: "2999-01-01T00:00:00.000Z",
        occupants: [
          {
            participant_key: "user:anaconda:peer-person",
            actor_label: "user:anaconda:peer-person/browser:tab",
            display_name: "Peer Person",
            connection_scope: "editor",
          },
        ],
      }),
    );

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
    assert.equal(bootstrap.session?.provider, "oidc");
    assert.equal(typeof bootstrap.session?.expires_at, "number");
    assert.equal(typeof bootstrap.session?.cache_key, "string");
    assert.doesNotMatch(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(
      html,
      /bootstrap@example\.test|bootstrap-user|Bootstrap User|Peer Person|peer-person/,
    );
  });

  it("keeps authenticated notebook home bootstrap free of notebook route asset hints", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "home-preload-user",
      email: "home-preload@example.test",
      extraPayload: { email_verified: true },
      name: "Home Preload User",
    });
    const seenAssetPaths: string[] = [];
    const env = fakeEnv({
      ...oidcEnv,
      ASSETS: fakeNotebookRouteAssets(seenAssetPaths),
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "home-preload-visible");
    seedAcl(env, {
      notebookId: "home-preload-visible",
      subject: "user:anaconda:home-preload-user",
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
    assert.deepEqual(seenAssetPaths, []);
    assert.match(html, /rel="modulepreload" href="\/assets\/notebook-cloud-viewer\.js"/);
    assert.doesNotMatch(
      html,
      /rel="modulepreload" href="\/assets\/notebook-route\.0123456789abcdef\.js"/,
    );
    assert.doesNotMatch(
      html,
      /rel="modulepreload" href="\/assets\/MarkdownText\.0123456789abcdef\.js"/,
    );
    assert.doesNotMatch(
      html,
      /rel="modulepreload" href="\/assets\/markdown\.0123456789abcdef\.js"/,
    );
    assert.doesNotMatch(
      html,
      /rel="modulepreload" href="\/assets\/katex\.min\.0123456789abcdef\.js"/,
    );
    assert.doesNotMatch(
      html,
      /rel="prefetch" href="\/assets\/notebook-route\.0123456789abcdef\.css" as="style"/,
    );
    assert.doesNotMatch(
      html,
      /rel="prefetch" href="\/assets\/katex\.0123456789abcdef\.css" as="style"/,
    );
    assert.doesNotMatch(
      html,
      /rel="preload" href="\/assets\/notebook-route\.0123456789abcdef\.css" as="style"/,
    );
    assert.doesNotMatch(html, /id="nteract-cloud-viewer-config"/);
    assert.doesNotMatch(html, /runtimed_wasm\.0123456789abcdef/);
  });

  it("bootstraps notebook viewers with safe app session status", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "viewer-bootstrap-user",
      email: "viewer-bootstrap@example.test",
      extraPayload: { email_verified: true },
      name: "Viewer Bootstrap User",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "viewer-bootstrap-session");
    const notebook = env.DB.notebooks.get("viewer-bootstrap-session");
    assert.ok(notebook);
    notebook.title = "Viewer Bootstrap Notebook";
    seedAcl(env, {
      notebookId: "viewer-bootstrap-session",
      subject: "user:anaconda:viewer-bootstrap-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n/viewer-bootstrap-session/notebook", {
        headers: { Cookie: cookie },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    const config = notebookViewerConfig(html);
    assert.equal(config.featureFlags?.enable_comments, true);
    assert.equal(config.session?.provider, "oidc");
    assert.equal(typeof config.session?.expires_at, "number");
    assert.equal(typeof config.session?.cache_key, "string");
    assert.deepEqual(config.initialCatalogAccess, {
      scope: "owner",
      title: "Viewer Bootstrap Notebook",
    });
    assert.doesNotMatch(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /viewer-bootstrap@example\.test|viewer-bootstrap-user/);
    assert.doesNotMatch(html, /Viewer Bootstrap User/);
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

  it("uses app session cookies for first-party browser notebook APIs", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-browser-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "cookie-api-visible");
    seedAcl(env, {
      notebookId: "cookie-api-visible",
      subject: "user:anaconda:cookie-browser-user",
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
      ["cookie-api-visible"],
    );

    const patchResponse = await worker.fetch(
      new Request("https://cloud.test/api/n/cookie-api-visible", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://cloud.test",
        },
        body: JSON.stringify({ title: "Cookie Browser Notebook" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(patchResponse.status, 200);
    assert.equal(env.DB.notebooks.get("cookie-api-visible")?.title, "Cookie Browser Notebook");

    const createResponse = await worker.fetch(
      new Request("https://cloud.test/api/n", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://cloud.test",
        },
        body: JSON.stringify({ title: "Cookie Created Notebook" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { notebook_id: string; title: string };
    assert.equal(created.title, "Cookie Created Notebook");
    assert.ok(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === created.notebook_id &&
          row.subject === "user:anaconda:cookie-browser-user" &&
          row.scope === "owner",
      ),
    );

    const explicitBadBearer = await worker.fetch(
      new Request("https://cloud.test/api/n", {
        headers: {
          Authorization: "Bearer definitely-not-a-token",
          Cookie: cookie,
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(explicitBadBearer.status, 401);
  });

  it("resolves post-login pending invites for app-session notebook list APIs", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "cookie-invite-list-user",
      email: "cookie-invite-list@example.test",
      extraPayload: { email_verified: true },
      name: "Cookie Invite List User",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    const cookie = await oidcAppSessionCookie(env, token);
    seedNotebook(env, "cookie-list-invited");
    seedPendingInvite(env, {
      id: "invite-cookie-list",
      notebookId: "cookie-list-invited",
      email: "cookie-invite-list@example.test",
      providerHint: null,
      scope: "editor",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/api/n", {
        headers: { Cookie: cookie },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      notebooks: Array<{ notebook_id: string; scope: NotebookAclRow["scope"] }>;
    };
    assert.deepEqual(
      body.notebooks.map((notebook) => [notebook.notebook_id, notebook.scope]),
      [["cookie-list-invited", "editor"]],
    );
    const accountPrincipal = await canonicalAccountPrincipalForProfile({
      provider: "oidc",
      principalNamespace: "user:anaconda",
      email: "cookie-invite-list@example.test",
      emailVerified: true,
    });
    assert.ok(accountPrincipal);
    assert.equal(env.DB.invites.get("invite-cookie-list")?.status, "accepted");
    assert.ok(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "cookie-list-invited" &&
          row.subject_kind === "principal" &&
          row.subject === accountPrincipal &&
          row.scope === "editor",
      ),
    );
  });

  it("resolves post-login pending invites for app-session notebook home bootstrap", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "cookie-invite-bootstrap-user",
      email: "cookie-invite-bootstrap@example.test",
      extraPayload: { email_verified: true },
      name: "Cookie Invite Bootstrap User",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    const cookie = await oidcAppSessionCookie(env, token);
    seedNotebook(env, "cookie-bootstrap-invited");
    const notebook = env.DB.notebooks.get("cookie-bootstrap-invited");
    assert.ok(notebook);
    notebook.title = "Cookie Bootstrap Invited";
    seedPendingInvite(env, {
      id: "invite-cookie-bootstrap",
      notebookId: "cookie-bootstrap-invited",
      email: "cookie-invite-bootstrap@example.test",
      providerHint: null,
      scope: "viewer",
    });

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
    assert.deepEqual(
      bootstrap.notebooks.map((notebook) => [notebook.notebook_id, notebook.title]),
      [["cookie-bootstrap-invited", "Cookie Bootstrap Invited"]],
    );
    assert.equal(env.DB.invites.get("invite-cookie-bootstrap")?.status, "accepted");
  });

  it("resolves post-login pending invites before app-session WebSocket authorization", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "cookie-invite-ws-user",
      email: "cookie-invite-ws@example.test",
      extraPayload: { email_verified: true },
      name: "Cookie Invite WebSocket User",
    });
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
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
    const cookie = await oidcAppSessionCookie(env, token);
    seedNotebook(env, "cookie-ws-invited");
    seedPendingInvite(env, {
      id: "invite-cookie-ws",
      notebookId: "cookie-ws-invited",
      email: "cookie-invite-ws@example.test",
      providerHint: null,
      scope: "editor",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-ws-invited/sync?scope=editor", {
        headers: {
          Cookie: cookie,
          Origin: "https://cloud.test",
          "Sec-WebSocket-Protocol": NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.ok(forwardedRequest);
    assert.equal(forwardedRequest.headers.get(TRUSTED_SCOPE_HEADER), "editor");
    assert.equal(env.DB.invites.get("invite-cookie-ws")?.status, "accepted");
  });

  it("uses app-session cookies as same-origin room WebSocket credentials", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-ws-user" });
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
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
          "Sec-WebSocket-Protocol": NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
          Upgrade: "websocket",
        },
      }),
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
    assert.equal(forwardedRequest.headers.get(TRUSTED_SCOPE_HEADER), "owner");
  });

  it("rejects app-session WebSockets combined with explicit bearer credentials", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-mixed-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "cookie-mixed-ticket");
    seedAcl(env, {
      notebookId: "cookie-mixed-ticket",
      subject: "user:anaconda:cookie-mixed-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-mixed-ticket/sync?scope=owner", {
        headers: {
          Cookie: cookie,
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

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "multiple identity credentials presented" });
  });

  it("rejects app-session cookie WebSockets without an origin", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-origin-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "cookie-origin-ticket");
    seedAcl(env, {
      notebookId: "cookie-origin-ticket",
      subject: "user:anaconda:cookie-origin-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-origin-ticket/sync?scope=owner", {
        headers: {
          Cookie: cookie,
          "Sec-WebSocket-Protocol": NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "websocket origin is required" });
  });

  it("downgrades optimistic owner app-session WebSockets to the best granted live scope", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-editor-user" });
    let forwardedRequest: Request | undefined;
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
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
    seedNotebook(env, "cookie-ticket-editor");
    seedAcl(env, {
      notebookId: "cookie-ticket-editor",
      subject: "user:anaconda:cookie-editor-user",
      scope: "editor",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-ticket-editor/sync?scope=owner", {
        headers: {
          Cookie: cookie,
          Origin: "https://cloud.test",
          "Sec-WebSocket-Protocol": NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.ok(forwardedRequest);
    assert.equal(forwardedRequest.headers.get(TRUSTED_SCOPE_HEADER), "editor");
  });

  it("rejects runtime_peer scope for app-session browser WebSockets", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({ subject: "cookie-runtime-user" });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedNotebook(env, "cookie-runtime-ticket");
    seedAcl(env, {
      notebookId: "cookie-runtime-ticket",
      subject: "user:anaconda:cookie-runtime-user",
      scope: "owner",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const response = await worker.fetch(
      new Request("https://cloud.test/n/cookie-runtime-ticket/sync?scope=runtime_peer", {
        headers: {
          Cookie: cookie,
          Origin: "https://cloud.test",
          "Sec-WebSocket-Protocol": NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "browser app sessions cannot request runtime_peer scope",
    });
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

  it("serves favicon requests without falling through to the JSON 404", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/favicon.ico"),
      env,
      fakeContext(),
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/svg+xml; charset=utf-8");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=86400");
    assert.match(body, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

    const headResponse = await worker.fetch(
      new Request("http://localhost/favicon.svg", { method: "HEAD" }),
      env,
      fakeContext(),
    );
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get("Content-Type"), "image/svg+xml; charset=utf-8");
    assert.equal(await headResponse.text(), "");
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

  it("keeps local Browser viewer URLs on loopback when Wrangler preserves the custom-domain URL", async () => {
    const env = fakeEnv({ NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS: "true" });
    const localBrowserHeaders = {
      "CF-Connecting-IP": "127.0.0.1",
      "Content-Type": "application/json",
      Origin: "http://localhost:45316",
      "X-Operator": "browser:tab",
      "X-Scope": "owner",
      "X-User": "alice",
    };

    const response = await worker.fetch(
      new Request("https://preview.runt.run/api/n", {
        method: "POST",
        headers: localBrowserHeaders,
        body: JSON.stringify({ title: "Local Dev Notes" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      notebook_id: string;
      viewer_url: string;
    };
    assert.equal(
      body.viewer_url,
      `http://localhost:45316/n/${body.notebook_id}/Local%20Dev%20Notes`,
    );

    const list = await worker.fetch(
      new Request("https://preview.runt.run/api/n?limit=1", {
        headers: {
          "CF-Connecting-IP": "127.0.0.1",
          Origin: "http://localhost:45316",
          "X-Operator": "browser:tab",
          "X-Scope": "viewer",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      notebooks: Array<{ viewer_url: string }>;
    };
    assert.equal(listBody.notebooks[0]?.viewer_url, body.viewer_url);
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
      current_user_principal?: string;
      notebooks: Array<{
        endpoints: Record<string, string>;
        notebook_id: string;
        scope: NotebookAclRow["scope"];
        title: string | null;
        viewer_url: string;
      }>;
      ok: boolean;
      total_count: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.current_user_principal, "user:dev:alice");
    assert.equal(body.total_count, 3);
    assert.equal(body.notebooks.length, 2);
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

  it("hydrates owner and current-user avatars from principal profiles in notebook lists", async () => {
    const env = fakeEnv();
    seedNotebook(env, "profiled-shared");
    seedNotebook(env, "unresolved-shared");
    env.DB.notebooks.get("profiled-shared")!.owner_principal = "user:dev:bob";
    env.DB.notebooks.get("unresolved-shared")!.owner_principal = "user:dev:carol";
    seedAcl(env, { notebookId: "profiled-shared", subject: "user:dev:alice", scope: "editor" });
    seedAcl(env, { notebookId: "unresolved-shared", subject: "user:dev:alice", scope: "viewer" });
    env.DB.profiles.set(
      "user:dev:alice",
      principalProfileRow({
        principal: "user:dev:alice",
        provider_subject: "alice",
        display_name: "Alice Example",
        avatar_url: "https://profiles.example/alice.png",
      }),
    );
    env.DB.profiles.set(
      "user:dev:bob",
      principalProfileRow({
        principal: "user:dev:bob",
        provider_subject: "bob",
        email_normalized: "bob@example.com",
        display_name: "Bob Example",
        avatar_url: "https://profiles.example/bob.png",
      }),
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/n", {
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
      current_user_avatar?: string;
      current_user_display?: string;
      notebooks: Array<{
        notebook_id: string;
        owner_avatar?: string;
        owner_display?: string;
        owner_resolved?: boolean;
      }>;
    };
    assert.equal(body.current_user_display, "alice");
    assert.equal(body.current_user_avatar, "https://profiles.example/alice.png");
    const profiled = body.notebooks.find((notebook) => notebook.notebook_id === "profiled-shared");
    const unresolved = body.notebooks.find(
      (notebook) => notebook.notebook_id === "unresolved-shared",
    );
    assert.equal(profiled?.owner_display, "Bob Example");
    assert.equal(profiled?.owner_avatar, "https://profiles.example/bob.png");
    assert.equal(profiled?.owner_resolved, true);
    assert.equal(Object.hasOwn(profiled ?? {}, "owner_avatar"), true);
    assert.equal(unresolved?.owner_resolved, false);
    assert.equal(Object.hasOwn(unresolved ?? {}, "owner_display"), false);
    assert.equal(Object.hasOwn(unresolved ?? {}, "owner_avatar"), false);
  });

  it("omits malformed notebook composition and preview cells from list rows without dropping language", async () => {
    const env = fakeEnv();
    seedNotebook(env, "malformed-summary");
    const notebook = env.DB.notebooks.get("malformed-summary");
    assert.ok(notebook);
    notebook.cell_composition = "{not-json";
    notebook.preview_cells = "{not-json";
    notebook.language = "python";
    seedAcl(env, { notebookId: "malformed-summary", subject: "user:dev:alice", scope: "owner" });

    const response = await worker.fetch(
      new Request("http://localhost/api/n", {
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
        composition?: unknown;
        language?: string;
        notebook_id: string;
        preview?: unknown;
      }>;
    };
    const row = body.notebooks.find(
      (notebookRow) => notebookRow.notebook_id === "malformed-summary",
    );
    assert.ok(row);
    assert.equal(Object.hasOwn(row, "composition"), false);
    assert.equal(Object.hasOwn(row, "preview"), false);
    assert.equal(row.language, "python");
  });

  it("returns the authorized caller scope from direct notebook catalog fetches", async () => {
    const env = fakeEnv();
    seedNotebook(env, "catalog-scope-demo");
    const notebook = env.DB.notebooks.get("catalog-scope-demo");
    assert.ok(notebook);
    notebook.title = "Scoped Catalog";
    seedAcl(env, {
      notebookId: "catalog-scope-demo",
      subject: "user:dev:alice",
      scope: "editor",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/n/catalog-scope-demo", {
        headers: {
          "X-User": "alice",
          "X-Operator": "browser:tab",
          "X-Scope": "viewer",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      access?: { scope?: string };
      notebook?: { id?: string; title?: string | null };
    };
    assert.deepEqual(body.access, { scope: "editor" });
    assert.equal(body.notebook?.id, "catalog-scope-demo");
    assert.equal(body.notebook?.title, "Scoped Catalog");
  });

  it("enriches owned notebook rows with owner-scoped compute sessions", async () => {
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = fakeEnv({ OWNER_COMPUTE_INDEX: compute });
    seedNotebook(env, "owned-active");
    seedNotebook(env, "shared-active");
    env.DB.notebooks.get("shared-active")!.owner_principal = "user:dev:bob";
    seedAcl(env, { notebookId: "owned-active", subject: "user:dev:alice", scope: "owner" });
    seedAcl(env, { notebookId: "shared-active", subject: "user:dev:alice", scope: "editor" });
    compute.sessions.set("owned-active", {
      environment_label: "Current Python",
      last_runtime_seen_at: "2026-06-23T00:00:00.000Z",
      notebook_id: "owned-active",
      owner_principal: "user:dev:alice",
      queue_depth: 0,
      runtime_peer_count: 1,
      runtime_session_id: "job-1",
      status: "active",
      status_message: null,
      updated_at: "2026-06-23T00:00:00.000Z",
      working_directory: "/home/ubuntu/project",
      workstation_display_name: "lab2 workstation",
      workstation_id: "ws-lab2",
    });
    compute.sessions.set("shared-active", {
      environment_label: "Current Python",
      last_runtime_seen_at: "2026-06-23T00:00:00.000Z",
      notebook_id: "shared-active",
      owner_principal: "user:dev:bob",
      queue_depth: 0,
      runtime_peer_count: 1,
      runtime_session_id: "job-2",
      status: "active",
      status_message: null,
      updated_at: "2026-06-23T00:00:00.000Z",
      working_directory: "/home/bob/project",
      workstation_display_name: "bob workstation",
      workstation_id: "ws-bob",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/n", {
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
        compute_session?: NotebookComputeSessionSummary | null;
        notebook_id: string;
      }>;
    };
    const owned = body.notebooks.find((notebook) => notebook.notebook_id === "owned-active");
    const shared = body.notebooks.find((notebook) => notebook.notebook_id === "shared-active");
    assert.equal(owned?.compute_session?.workstation_id, "ws-lab2");
    assert.equal(shared?.compute_session, null);
    assert.deepEqual(
      compute.requests.map((request) => [request.objectName, request.notebookIds]),
      [["owner-compute:v1:user:dev:alice", ["owned-active"]]],
    );
  });

  it("hydrates fresh room presence and excludes stale, runtime, and requester occupants", async () => {
    const env = fakeEnv();
    seedNotebook(env, "fresh-presence");
    seedNotebook(env, "stale-presence");
    seedAcl(env, { notebookId: "fresh-presence", subject: "user:dev:alice", scope: "owner" });
    seedAcl(env, { notebookId: "stale-presence", subject: "user:dev:alice", scope: "owner" });
    await env.NOTEBOOK_SNAPSHOTS.put(
      roomSummaryKey("fresh-presence"),
      JSON.stringify({
        version: 1,
        notebook_id: "fresh-presence",
        updated_at: "2999-01-01T00:00:00.000Z",
        occupants: [
          {
            participant_key: "user:dev:alice",
            actor_label: "user:dev:alice/desktop:test",
            display_name: "Alice",
            connection_scope: "owner",
          },
          {
            participant_key: "user:dev:bob",
            actor_label: "user:dev:bob/browser:tab",
            display_name: "Bob",
            connection_scope: "editor",
          },
          {
            participant_key: "user:dev:alice-runtime",
            actor_label: "user:dev:alice/runtime:py",
            display_name: "Python",
            connection_scope: "runtime_peer",
          },
          {
            // Read-only viewers (incl. anonymous public viewers) never read as
            // "editing now" on the dashboard.
            participant_key: "user:dev:vera",
            actor_label: "user:dev:vera/browser:tab",
            display_name: "Vera Viewer",
            connection_scope: "viewer",
          },
        ],
      }),
    );
    await env.NOTEBOOK_SNAPSHOTS.put(
      roomSummaryKey("stale-presence"),
      JSON.stringify({
        version: 1,
        notebook_id: "stale-presence",
        updated_at: "2000-01-01T00:00:00.000Z",
        occupants: [
          {
            participant_key: "user:dev:bob",
            actor_label: "user:dev:bob/browser:tab",
            display_name: "Bob",
            connection_scope: "editor",
          },
        ],
      }),
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/n", {
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
        notebook_id: string;
        peers?: Array<{
          participant_key: string;
          actor_label: string;
          display_name?: string;
          connection_scope: string;
        }>;
      }>;
    };
    assert.deepEqual(
      body.notebooks.find((notebook) => notebook.notebook_id === "fresh-presence")?.peers,
      [
        {
          participant_key: "user:dev:bob",
          actor_label: "user:dev:bob/browser:tab",
          display_name: "Bob",
          connection_scope: "editor",
        },
      ],
    );
    assert.equal(
      Object.hasOwn(
        body.notebooks.find((notebook) => notebook.notebook_id === "stale-presence") ?? {},
        "peers",
      ),
      false,
    );
  });

  it("caps room presence hydration and fails open on R2 read errors", async () => {
    const snapshots = new FailingGetR2Bucket();
    const env = fakeEnv({ NOTEBOOK_SNAPSHOTS: snapshots });
    for (let index = 0; index < 205; index += 1) {
      const notebookId = `presence-${String(index).padStart(3, "0")}`;
      seedNotebook(env, notebookId);
      seedAcl(env, { notebookId, subject: "user:dev:alice", scope: "owner" });
    }
    snapshots.failNextGet = true;

    const response = await worker.fetch(
      new Request("http://localhost/api/n?limit=205", {
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
    const body = (await response.json()) as { notebooks: unknown[] };
    assert.equal(body.notebooks.length, 205);
    assert.equal(snapshots.getKeys.length, 200);
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
    assert.equal(registered.workstation.is_default, true);
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
    assert.equal(body.default_workstation_id, "ws-lab2");
    assert.equal(body.workstations.length, 1);
    assert.equal(body.workstations[0]?.display_name, "Lab2");
    assert.equal(body.workstations[0]?.is_default, true);
  });

  it("deregisters an owned workstation, deletes its lease, and pushes went_offline once", async () => {
    const compute = new FakeOwnerComputeIndexNamespace();
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ OWNER_COMPUTE_INDEX: compute, WORKSTATION_EVENTS: events });
    const ownerPrincipal = "user:dev:alice";
    const workstationId = "ws-lab2";
    const objectName = workstationEventsObjectName(ownerPrincipal, workstationId);
    seedWorkstation(env, { ownerPrincipal, workstationId });
    seedWorkstationLease(compute, {
      ownerPrincipal,
      workstationId,
      lastSeenAt: new Date().toISOString(),
    });
    env.DB.workstationDefaults.set(ownerPrincipal, workstationId);

    const deleted = await worker.fetch(
      new Request(`http://localhost/api/workstations/${workstationId}`, {
        method: "DELETE",
        headers: {
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
      ok: true,
      workstation_id: workstationId,
      deregistered: true,
    });
    assert.equal(compute.leases.has(workstationId), false);
    assert.equal(env.DB.workstations.has(workstationKey(ownerPrincipal, workstationId)), false);
    assert.equal(env.DB.workstationDefaults.has(ownerPrincipal), false);

    const wentOffline = events.requests.filter(
      (entry) =>
        entry.objectName === objectName &&
        new URL(entry.url).pathname === "/notify" &&
        (entry.body as { event?: string } | null)?.event === "went_offline",
    );
    assert.equal(wentOffline.length, 1);
    assert.deepEqual(wentOffline[0]?.body, {
      event: "went_offline",
      workstation_id: workstationId,
      reason: "workstation deregistered",
    });

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
    assert.deepEqual(body.workstations, []);
  });

  it("does not let another principal deregister a workstation", async () => {
    const compute = new FakeOwnerComputeIndexNamespace();
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ OWNER_COMPUTE_INDEX: compute, WORKSTATION_EVENTS: events });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationLease(compute, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt: new Date().toISOString(),
    });

    const deleted = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2", {
        method: "DELETE",
        headers: {
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "bob",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(deleted.status, 404);
    assert.equal(compute.leases.has("ws-lab2"), true);
    assert.equal(env.DB.workstations.has(workstationKey("user:dev:alice", "ws-lab2")), true);
    assert.ok(!events.requests.some((entry) => new URL(entry.url).pathname === "/notify"));
  });

  it("forwards user-owned workstation event socket upgrades", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/events", {
        headers: {
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
          Upgrade: "websocket",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fake-websocket-upgrade"), "1");
    const streamRequest = events.requests.find(
      (entry) => new URL(entry.url).pathname === "/stream",
    );
    assert.equal(streamRequest?.objectName, objectName);
    assert.equal(streamRequest?.upgrade, "websocket");
  });

  it("projects a stale workstation as online when its event socket is connected", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt: "2026-05-22T00:00:00.000Z",
    });

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
      workstations: Array<{
        workstation_id: string;
        status: string;
        status_message: string | null;
      }>;
    };
    assert.equal(body.workstations[0]?.workstation_id, "ws-lab2");
    assert.equal(body.workstations[0]?.status, "online");
    assert.equal(body.workstations[0]?.status_message, null);
    const statusRequest = events.requests.find(
      (entry) => new URL(entry.url).pathname === "/status",
    );
    assert.equal(statusRequest?.objectName, objectName);
  });

  it("does not probe event-socket status when a fresh offline lease decides the list row", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = fakeEnv({ OWNER_COMPUTE_INDEX: compute, WORKSTATION_EVENTS: events });
    const now = Date.now();
    const lastSeenAt = new Date(now - 4 * 60_000).toISOString();
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt,
    });
    seedWorkstationLease(compute, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt,
      online: false,
    });

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
      workstations: Array<{
        workstation_id: string;
        status: string;
      }>;
    };
    assert.equal(body.workstations[0]?.workstation_id, "ws-lab2");
    assert.equal(body.workstations[0]?.status, "offline");
    assert.ok(!events.requests.some((entry) => new URL(entry.url).pathname === "/status"));
  });

  it("does not probe event-socket status when a fresh online lease decides a stale list row", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = fakeEnv({ OWNER_COMPUTE_INDEX: compute, WORKSTATION_EVENTS: events });
    const now = Date.now();
    const staleLastSeenAt = new Date(now - 4 * 60_000).toISOString();
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt: staleLastSeenAt,
    });
    seedWorkstationLease(compute, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt: new Date(now).toISOString(),
      online: true,
    });

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
      workstations: Array<{
        workstation_id: string;
        status: string;
      }>;
    };
    assert.equal(body.workstations[0]?.workstation_id, "ws-lab2");
    assert.equal(body.workstations[0]?.status, "online");
    assert.ok(!events.requests.some((entry) => new URL(entry.url).pathname === "/status"));
  });

  it("does not fan out event-socket status checks for fresh workstation rows", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt: new Date().toISOString(),
    });

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
      workstations: Array<{
        workstation_id: string;
        status: string;
        status_message: string | null;
      }>;
    };
    assert.equal(body.workstations[0]?.workstation_id, "ws-lab2");
    assert.equal(body.workstations[0]?.status, "online");
    assert.equal(body.workstations[0]?.status_message, null);
    assert.ok(!events.requests.some((entry) => new URL(entry.url).pathname === "/status"));
  });

  it("does not fan out event-socket status checks for explicitly offline rows", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "offline",
      lastSeenAt: "2026-05-22T00:00:00.000Z",
    });

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
      workstations: Array<{
        workstation_id: string;
        status: string;
        status_message: string | null;
      }>;
    };
    assert.equal(body.workstations[0]?.workstation_id, "ws-lab2");
    assert.equal(body.workstations[0]?.status, "offline");
    assert.ok(!events.requests.some((entry) => new URL(entry.url).pathname === "/status"));
  });

  it("keeps an existing default workstation when another host heartbeats", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-default" });
    env.DB.workstationDefaults.set("user:dev:alice", "ws-default");

    const register = await worker.fetch(
      new Request("http://localhost/api/workstations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab3",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({
          workstation_id: "ws-lab3",
          display_name: "Lab3",
          provider: "runtime_peer",
          default_environment_label: "Current Python",
          environment_policy: "current_python",
          working_directory: "/home/ubuntu/project",
        }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(register.status, 201);
    const body = (await register.json()) as {
      workstation: Record<string, unknown>;
    };
    assert.equal(body.workstation.workstation_id, "ws-lab3");
    assert.equal(body.workstation.is_default, false);
    assert.equal(env.DB.workstationDefaults.get("user:dev:alice"), "ws-default");
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

  it("uses app session cookies for browser workstation selection", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "cookie-workstation-user",
    });
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: APP_SESSION_SECRET,
    });
    seedWorkstation(env, {
      ownerPrincipal: "user:anaconda:cookie-workstation-user",
      workstationId: "ws-cookie",
    });
    const cookie = await oidcAppSessionCookie(env, token);

    const list = await worker.fetch(
      new Request("https://cloud.test/api/workstations", {
        headers: { Cookie: cookie },
      }),
      env,
      fakeContext(),
    );
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      workstations: Array<{ workstation_id: string }>;
    };
    assert.deepEqual(
      listBody.workstations.map((workstation) => workstation.workstation_id),
      ["ws-cookie"],
    );

    const select = await worker.fetch(
      new Request("https://cloud.test/api/workstations/default", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://cloud.test",
        },
        body: JSON.stringify({ workstation_id: "ws-cookie" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(select.status, 200);
    assert.equal(
      env.DB.workstationDefaults.get("user:anaconda:cookie-workstation-user"),
      "ws-cookie",
    );
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

  it("requires an explicit workstation id for notebook attach requests", async () => {
    const env = fakeEnv();
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-default" });
    env.DB.workstationDefaults.set("user:dev:alice", "ws-default");

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

    assert.equal(attach.status, 400);
    assert.deepEqual(await attach.json(), { error: "workstation_id must be a non-empty string" });
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

  it("creates workstation attach jobs for the requested workstation, not the default", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab1");
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-default" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab1" });
    env.DB.workstationDefaults.set("user:dev:alice", "ws-default");

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab1" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as {
      job: { job_id: string; notebook_id: string; status: string; trigger: string };
      workstation: { is_default?: boolean; workstation_id?: string };
    };
    assert.equal(body.job.notebook_id, "attach-demo");
    assert.equal(body.job.status, "pending");
    assert.equal(body.job.trigger, "user_attach");
    assert.equal(body.workstation.workstation_id, "ws-lab1");
    assert.equal(body.workstation.is_default, false);
    assert.equal(env.DB.workstationAttachJobs.get(body.job.job_id)?.workstation_id, "ws-lab1");
    assert.equal(env.DB.workstationAttachJobs.get(body.job.job_id)?.trigger, "user_attach");
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "attach-demo" &&
          row.subject === "user:dev:alice" &&
          row.scope === "runtime_peer",
      ),
      true,
    );
    const notifyRequest = events.requests.find(
      (entry) => new URL(entry.url).pathname === "/notify",
    );
    assert.equal(notifyRequest?.objectName, objectName);
    assert.equal(
      (notifyRequest?.body as { workstation_id?: string } | null)?.workstation_id,
      "ws-lab1",
    );

    const poll = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab1/attach-jobs", {
        headers: {
          "X-Operator": "workstation:lab1",
          "X-Scope": "owner",
          "X-User": "alice",
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(poll.status, 200);
    const polled = (await poll.json()) as { jobs: Array<{ job_id: string; trigger: string }> };
    assert.deepEqual(
      polled.jobs.map((job) => job.job_id),
      [body.job.job_id],
    );
    assert.deepEqual(
      polled.jobs.map((job) => job.trigger),
      ["user_attach"],
    );
  });

  it("does not fall back to the default when the requested workstation has no connected agent", async () => {
    const requestedObjectName = workstationEventsObjectName("user:dev:alice", "ws-lab1");
    const defaultObjectName = workstationEventsObjectName("user:dev:alice", "ws-default");
    const events = new FakeWorkstationEventsNamespace({
      connectedObjectNames: [defaultObjectName],
    });
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-default" });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab1",
      lastSeenAt: "2026-05-22T00:00:00.000Z",
    });
    env.DB.workstationDefaults.set("user:dev:alice", "ws-default");

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab1" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 409);
    const body = (await attach.json()) as {
      error?: string;
      workstation?: { workstation_id?: string; status?: string };
    };
    assert.equal(body.error, "workstation is not online");
    assert.equal(body.workstation?.workstation_id, "ws-lab1");
    assert.equal(body.workstation?.status, "offline");
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
    const statusRequest = events.requests.find(
      (entry) => new URL(entry.url).pathname === "/status",
    );
    assert.equal(statusRequest?.objectName, requestedObjectName);
    assert.ok(!events.requests.some((entry) => entry.objectName === defaultObjectName));
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

  it("does not create attach jobs or runtime peer grants for offline workstations", async () => {
    const roomRequests: string[] = [];
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            roomRequests.push(new URL(request.url).pathname);
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "offline",
    });

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

    assert.equal(attach.status, 409);
    const body = (await attach.json()) as {
      error?: string;
      workstation?: { workstation_id?: string; status?: string };
    };
    assert.equal(body.error, "workstation is not online");
    assert.equal(body.workstation?.workstation_id, "ws-lab2");
    assert.equal(body.workstation?.status, "offline");
    assert.deepEqual(roomRequests, ["/internal/n/attach-demo/runtime-state-repair"]);
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

  it("allows attach requests for stale workstations with a connected event socket", async () => {
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedNotebook(env, "attach-stream-presence-demo");
    seedAcl(env, {
      notebookId: "attach-stream-presence-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt: "2026-05-22T00:00:00.000Z",
    });

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-stream-presence-demo/workstation-attachments", {
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

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as {
      workstation: { status: string; status_message: string | null };
      job: { job_id: string };
    };
    assert.equal(body.workstation.status, "online");
    assert.equal(body.workstation.status_message, null);
    assert.equal(env.DB.workstationAttachJobs.get(body.job.job_id)?.workstation_id, "ws-lab2");
    assert.ok(events.requests.some((entry) => new URL(entry.url).pathname === "/status"));
    assert.ok(events.requests.some((entry) => new URL(entry.url).pathname === "/notify"));
  });

  it("rejects attach when a fresh offline lease outvotes a lingering event socket", async () => {
    const roomRequests: string[] = [];
    const objectName = workstationEventsObjectName("user:dev:alice", "ws-lab2");
    const events = new FakeWorkstationEventsNamespace({ connectedObjectNames: [objectName] });
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = fakeEnv({
      OWNER_COMPUTE_INDEX: compute,
      WORKSTATION_EVENTS: events,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            roomRequests.push(new URL(request.url).pathname);
            return Response.json({ ok: true, changed: true });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    const now = Date.now();
    const lastSeenAt = new Date(now - 4 * 60_000).toISOString();
    seedNotebook(env, "attach-lease-demo");
    seedAcl(env, { notebookId: "attach-lease-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt,
    });
    seedWorkstationLease(compute, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt,
      online: false,
    });

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-lease-demo/workstation-attachments", {
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

    assert.equal(attach.status, 409);
    const body = (await attach.json()) as {
      error?: string;
      workstation?: { workstation_id?: string; status?: string };
    };
    assert.equal(body.error, "workstation is not online");
    assert.equal(body.workstation?.workstation_id, "ws-lab2");
    assert.equal(body.workstation?.status, "offline");
    assert.deepEqual(roomRequests, ["/internal/n/attach-lease-demo/runtime-state-repair"]);
    assert.equal(env.DB.workstationAttachJobs.size, 0);
    assert.equal(
      env.DB.acl.some(
        (row) =>
          row.notebook_id === "attach-lease-demo" &&
          row.subject === "user:dev:alice" &&
          row.scope === "runtime_peer",
      ),
      false,
    );
    assert.ok(events.requests.some((entry) => new URL(entry.url).pathname === "/status"));
    assert.ok(!events.requests.some((entry) => new URL(entry.url).pathname === "/notify"));
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

  it("upgrades a deduped resume attach job when the owner explicitly attaches", async () => {
    const env = fakeEnv();
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "resume-job",
      notebookId: "attach-demo",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      requestedAt: new Date().toISOString(),
      trigger: "resume",
    });

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

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as { job: { job_id: string; trigger: string } };
    assert.equal(body.job.job_id, "resume-job");
    assert.equal(body.job.trigger, "user_attach");
    assert.equal(env.DB.workstationAttachJobs.get("resume-job")?.trigger, "user_attach");

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
    const polled = (await poll.json()) as { jobs: Array<{ job_id: string; trigger: string }> };
    assert.deepEqual(
      polled.jobs.map((job) => ({ job_id: job.job_id, trigger: job.trigger })),
      [{ job_id: "resume-job", trigger: "user_attach" }],
    );
  });

  it("switches active workstation attach jobs to the newly attached workstation", async () => {
    let runtimeStateRequest: Request | undefined;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            runtimeStateRequest = request;
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab-a" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab-b" });
    seedWorkstationAttachJob(env, {
      id: "running-job-a",
      notebookId: "attach-demo",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab-a",
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab-b" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as {
      job: { job_id: string; status: string; workstation_id: string };
    };
    assert.notEqual(body.job.job_id, "running-job-a");
    assert.equal(body.job.status, "pending");
    assert.equal(body.job.workstation_id, "ws-lab-b");
    assert.equal(env.DB.batchSizes.at(-1), 2);
    assert.equal(env.DB.workstationAttachJobs.get("running-job-a")?.status, "cancelled");
    assert.match(
      env.DB.workstationAttachJobs.get("running-job-a")?.error_message ?? "",
      /replaced by a newer workstation attach request/,
    );
    assert.ok(runtimeStateRequest);
    const payload = (await runtimeStateRequest.json()) as {
      attachment?: {
        status?: string;
        status_message?: string | null;
        workstation_id?: string;
        runtime_session_id?: string | null;
      };
      close_runtime_peers?: boolean;
      close_reason?: string;
    };
    assert.equal(payload.close_runtime_peers, true);
    assert.equal(payload.close_reason, "workstation attachment switched");
    assert.equal(payload.attachment?.workstation_id, "ws-lab-b");
  });

  it("enforces one active workstation attach job per notebook owner", async () => {
    const env = fakeEnv();
    const now = new Date().toISOString();
    const insert = (id: string, workstationId: string) =>
      env.DB.prepare(
        `INSERT INTO workstation_attach_jobs (
           id,
           notebook_id,
           owner_principal,
           workstation_id,
           status,
           requested_by_actor_label,
           requested_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
        .bind(
          id,
          "attach-demo",
          "user:dev:alice",
          workstationId,
          "user:dev:alice/browser:tab",
          now,
          now,
        )
        .run();

    await insert("pending-a", "ws-lab-a");
    await assert.rejects(
      insert("pending-b", "ws-lab-b"),
      /UNIQUE constraint failed: workstation_attach_jobs.notebook_id, workstation_attach_jobs.owner_principal/,
    );
    const active = env.DB.workstationAttachJobs.get("pending-a");
    assert.ok(active);
    active.status = "cancelled";

    await insert("pending-b", "ws-lab-b");
    assert.equal(env.DB.workstationAttachJobs.get("pending-b")?.workstation_id, "ws-lab-b");
  });

  it("expires stale running attach jobs before creating a replacement", async () => {
    const env = fakeEnv();
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "stale-running",
      notebookId: "attach-demo",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "running",
      updatedAt: new Date(Date.now() - WORKSTATION_ATTACH_JOB_STALE_MS - 5_000).toISOString(),
    });

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

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as { job: { job_id: string; status: string } };
    assert.notEqual(body.job.job_id, "stale-running");
    assert.equal(body.job.status, "pending");
    assert.equal(env.DB.workstationAttachJobs.get("stale-running")?.status, "failed");
    assert.match(
      env.DB.workstationAttachJobs.get("stale-running")?.error_message ?? "",
      /stale workstation attach job expired/,
    );
  });

  it("replaces active workstation attach jobs when restarting hosted compute", async () => {
    let runtimeStateRequest: Request | undefined;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            runtimeStateRequest = request;
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "attach-demo");
    seedAcl(env, { notebookId: "attach-demo", subject: "user:dev:alice", scope: "owner" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "running-job",
      notebookId: "attach-demo",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/attach-demo/workstation-attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "browser:tab",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ workstation_id: "ws-lab2", replace_existing: true }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 202);
    const body = (await attach.json()) as { job: { job_id: string; status: string } };
    assert.notEqual(body.job.job_id, "running-job");
    assert.equal(body.job.status, "pending");
    assert.equal(env.DB.batchSizes.at(-1), 2);
    assert.equal(env.DB.workstationAttachJobs.get("running-job")?.status, "cancelled");
    assert.match(
      env.DB.workstationAttachJobs.get("running-job")?.error_message ?? "",
      /replaced by a newer workstation attach request/,
    );
    assert.ok(runtimeStateRequest);
    const payload = (await runtimeStateRequest.json()) as {
      attachment?: {
        status?: string;
        status_message?: string | null;
        workstation_id?: string;
        runtime_session_id?: string | null;
      };
      close_runtime_peers?: boolean;
      close_reason?: string;
    };
    assert.equal(payload.close_runtime_peers, true);
    assert.equal(payload.close_reason, "workstation restart requested");
    assert.deepEqual(payload.attachment, {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      runtime_session_id: body.job.job_id,
      status: "connecting",
      status_message: "Waiting for Lab2 to accept the compute request.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: env.DB.workstationAttachJobs.get(body.job.job_id)?.updated_at,
    });
  });

  it("lists fresh running attach jobs so workstation agents can recover after restart", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "running-job",
      notebookId: "nb-running",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    seedWorkstationAttachJob(env, {
      id: "stale-running-job",
      notebookId: "nb-stale",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "running",
      updatedAt: new Date(Date.now() - WORKSTATION_ATTACH_JOB_STALE_MS - 5_000).toISOString(),
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
    const body = (await response.json()) as { jobs: Array<{ job_id: string; status: string }> };
    assert.deepEqual(
      body.jobs.map((job) => [job.job_id, job.status]),
      [["running-job", "running"]],
    );
  });

  it("expires stale pending attach jobs on poll and repairs runtime state", async () => {
    const repairRequests: Array<{ body: unknown; path: string }> = [];
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            repairRequests.push({
              body: await request.json(),
              path: new URL(request.url).pathname,
            });
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "stale-pending-job",
      notebookId: "nb-stale-pending",
      ownerPrincipal: "user:dev:alice",
      requestedAt: new Date(Date.now() - WORKSTATION_ATTACH_PENDING_STALE_MS - 5_000).toISOString(),
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
    const body = (await response.json()) as { jobs: Array<{ job_id: string; status: string }> };
    assert.deepEqual(body.jobs, []);
    const expired = env.DB.workstationAttachJobs.get("stale-pending-job");
    assert.equal(expired?.status, "failed");
    assert.ok(expired?.finished_at);
    assert.match(expired?.error_message ?? "", /expired before host accepted/);
    assert.deepEqual(repairRequests, [
      {
        path: "/internal/n/nb-stale-pending/runtime-state-repair",
        body: {
          expected_runtime_session_id: "stale-pending-job",
          reason: "stale workstation attach job expired before host accepted the request",
        },
      },
    ]);
  });

  it("keeps fresh pending attach jobs visible on poll", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "fresh-pending-job",
      notebookId: "nb-fresh-pending",
      ownerPrincipal: "user:dev:alice",
      requestedAt: new Date().toISOString(),
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
    const body = (await response.json()) as { jobs: Array<{ job_id: string; status: string }> };
    assert.deepEqual(
      body.jobs.map((job) => [job.job_id, job.status]),
      [["fresh-pending-job", "pending"]],
    );
    assert.equal(env.DB.workstationAttachJobs.get("fresh-pending-job")?.status, "pending");
  });

  it("honors a fresh offline workstation lease in the attach-jobs poll response", async () => {
    const compute = new FakeOwnerComputeIndexNamespace();
    const env = fakeEnv({ OWNER_COMPUTE_INDEX: compute });
    const lastSeenAt = new Date().toISOString();
    seedWorkstation(env, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt,
    });
    seedWorkstationLease(compute, {
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      lastSeenAt,
      online: false,
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
    const body = (await response.json()) as {
      workstation: {
        status: string;
        workstation_id: string;
      };
    };
    assert.equal(body.workstation.workstation_id, "ws-lab2");
    assert.equal(body.workstation.status, "offline");
  });

  it("only lists attach jobs for the authenticated workstation owner", async () => {
    const env = fakeEnv();
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstation(env, { ownerPrincipal: "user:dev:bob", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-alice",
      notebookId: "nb-alice",
      ownerPrincipal: "user:dev:alice",
      requestedAt: new Date().toISOString(),
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
    let runtimeStateRequest: Request | undefined;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            runtimeStateRequest = request;
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
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
      trigger: "user_attach",
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
    assert.ok(runtimeStateRequest);
    assert.equal(runtimeStateRequest.method, "POST");
    assert.equal(
      new URL(runtimeStateRequest.url).pathname,
      "/internal/n/nb-1/workstation-attachment",
    );
    const runtimeStatePayload = (await runtimeStateRequest.json()) as {
      attachment?: {
        workstation_id?: string;
        display_name?: string;
        status?: string;
        runtime_session_id?: string | null;
      };
    };
    assert.deepEqual(runtimeStatePayload.attachment, {
      workstation_id: "ws-lab2",
      display_name: "Lab2",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      runtime_session_id: "job-1",
      status: "ready",
      status_message: null,
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: env.DB.workstationAttachJobs.get("job-1")?.updated_at,
    });
  });

  it("publishes workstation claim progress into RuntimeStateDoc", async () => {
    let attachmentStatus: string | undefined;
    let attachmentMessage: string | undefined | null;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            const payload = (await request.json()) as {
              attachment?: { status?: string; status_message?: string | null };
            };
            attachmentStatus = payload.attachment?.status;
            attachmentMessage = payload.attachment?.status_message;
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-claim",
      notebookId: "nb-claim",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs/job-claim", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ status: "accepted" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { job: { job_id: string; status: string } };
    assert.equal(body.job.job_id, "job-claim");
    assert.equal(body.job.status, "accepted");
    assert.equal(env.DB.workstationAttachJobs.get("job-claim")?.status, "accepted");
    assert.ok(env.DB.workstationAttachJobs.get("job-claim")?.accepted_at);
    assert.equal(attachmentStatus, "connecting");
    assert.equal(attachmentMessage, "Lab2 accepted the request and is starting compute.");
  });

  it("no-ops delayed workstation status patches that would move a job backward", async () => {
    let publishCount = 0;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            publishCount += 1;
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-running",
      notebookId: "nb-running",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "running",
      updatedAt: "2026-05-22T00:00:02.000Z",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs/job-running", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ status: "accepted" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 409);
    assert.equal(publishCount, 0);
    const row = env.DB.workstationAttachJobs.get("job-running");
    assert.equal(row?.status, "running");
    assert.equal(row?.updated_at, "2026-05-22T00:00:02.000Z");
    assert.deepEqual(await response.json(), {
      error: "workstation attach job is no longer active",
      job: {
        job_id: "job-running",
        notebook_id: "nb-running",
        workstation_id: "ws-lab2",
        status: "running",
        trigger: "user_attach",
        requested_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:02.000Z",
        accepted_at: null,
        finished_at: null,
        error_message: null,
        runtime_peer: {
          cloud_url: "http://localhost",
          notebook_id: "nb-running",
          scope: "runtime_peer",
        },
      },
    });
  });

  it("repairs RuntimeStateDoc when a workstation attach job fails before runtime peer connects", async () => {
    const roomRequests: Array<{ body: unknown; path: string }> = [];
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            roomRequests.push({
              body: await request.json(),
              path: new URL(request.url).pathname,
            });
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-fail",
      notebookId: "nb-fail",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs/job-fail", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ status: "failed", error_message: "spawn failed" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(roomRequests, [
      {
        path: "/internal/n/nb-fail/workstation-attachment",
        body: {
          attachment: {
            workstation_id: "ws-lab2",
            display_name: "Lab2",
            provider: "runtime_peer",
            default_environment_label: "Current Python",
            environment_policy: "current_python",
            runtime_session_id: "job-fail",
            status: "error",
            status_message: "spawn failed",
            cpu_count: 8,
            memory_bytes: 16_000_000_000,
            working_directory: "/home/ubuntu/project",
            updated_at: env.DB.workstationAttachJobs.get("job-fail")?.updated_at,
          },
        },
      },
      {
        path: "/internal/n/nb-fail/runtime-state-repair",
        body: {
          expected_runtime_session_id: "job-fail",
          reason: "spawn failed",
        },
      },
    ]);
  });

  it("keeps terminal workstation attach jobs sticky after replacement cancellation", async () => {
    let publishCount = 0;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            publishCount += 1;
            return new Response(JSON.stringify({ ok: true, changed: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedWorkstation(env, { ownerPrincipal: "user:dev:alice", workstationId: "ws-lab2" });
    seedWorkstationAttachJob(env, {
      id: "job-old",
      notebookId: "nb-old",
      ownerPrincipal: "user:dev:alice",
      workstationId: "ws-lab2",
      status: "cancelled",
      errorMessage: "replaced by a newer workstation attach request",
      finishedAt: "2026-05-22T00:00:01.000Z",
    });

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-lab2/attach-jobs/job-old", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "workstation:lab2",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ status: "completed" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 409);
    assert.equal(publishCount, 0);
    assert.equal(env.DB.workstationAttachJobs.get("job-old")?.status, "cancelled");
    assert.deepEqual(await response.json(), {
      error: "workstation attach job is no longer active",
      job: {
        job_id: "job-old",
        notebook_id: "nb-old",
        workstation_id: "ws-lab2",
        status: "cancelled",
        trigger: "user_attach",
        requested_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:00.000Z",
        accepted_at: null,
        finished_at: "2026-05-22T00:00:01.000Z",
        error_message: "replaced by a newer workstation attach request",
        runtime_peer: {
          cloud_url: "http://localhost",
          notebook_id: "nb-old",
          scope: "runtime_peer",
        },
      },
    });
  });

  it("lets notebook owners request a room-host runtime-state repair", async () => {
    let repairRequest: Request | undefined;
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            repairRequest = request;
            return new Response(
              JSON.stringify({
                ok: true,
                changed: true,
                forced: false,
                runtime_peer_count: 0,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "repair-demo");
    seedAcl(env, { notebookId: "repair-demo", subject: "user:dev:alice", scope: "owner" });

    const response = await worker.fetch(
      new Request("http://localhost/api/n/repair-demo/runtime-state-repair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator": "desktop:a",
          "X-Scope": "owner",
          "X-User": "alice",
        },
        body: JSON.stringify({ reason: "manual repair: stale runtime", force: false }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      changed: true,
      forced: false,
      runtime_peer_count: 0,
    });
    assert.ok(repairRequest);
    assert.equal(repairRequest.method, "POST");
    assert.equal(
      new URL(repairRequest.url).pathname,
      "/internal/n/repair-demo/runtime-state-repair",
    );
    assert.deepEqual(await repairRequest.json(), {
      force: false,
      reason: "manual repair: stale runtime",
    });
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

  it("allows blob upload content types used by current runtime and publish producers", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-demo");
    seedAcl(env, {
      notebookId: "runtime-demo",
      subject: "user:dev:runtime-service",
      scope: "runtime_peer",
    });
    const cases = [
      "application/octet-stream",
      "application/vnd.apache.arrow.stream",
      "application/vnd.nteract.arrow-stream-manifest+json",
      "application/vnd.apache.parquet",
      "application/json",
      "application/vnd.plotly.v1+json",
      "application/javascript",
      "text/javascript",
      "text/css",
      "text/html",
      "text/markdown",
      "text/plain",
      "image/png",
      "image/svg+xml",
      "application/pdf",
      "audio/wav",
      "video/mp4",
    ];

    for (const contentType of cases) {
      const body = new TextEncoder().encode(`blob ${contentType}`);
      const hash = await sha256Hex(body);
      const response = await scopedPut(env, `/api/n/runtime-demo/blobs/${hash}`, body, {
        "Content-Type": `${contentType}; charset=utf-8`,
        "X-Scope": "runtime_peer",
        "X-User": "runtime-service",
        "X-Operator": "runtime:py-3.12",
      });

      assert.equal(response.status, 201, contentType);
      assert.equal(
        env.NOTEBOOK_SNAPSHOTS.objects.get(blobKey("runtime-demo", hash))?.httpMetadata
          ?.contentType,
        contentType,
      );
      assert.equal(env.DB.blobs.get(`runtime-demo:${hash}`)?.content_type, contentType);
    }
  });

  it("rejects unsupported blob upload content types without writing bytes or catalog rows", async () => {
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
      "Content-Type": "application/xhtml+xml",
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    });

    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: "unsupported blob content type" });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.has(blobKey("runtime-demo", hash)), false);
    assert.equal(env.DB.blobs.size, 0);
  });

  it("keeps blob metadata first-writer-wins on duplicate put", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-demo");
    seedAcl(env, {
      notebookId: "runtime-demo",
      subject: "user:dev:runtime-service",
      scope: "runtime_peer",
    });
    const body = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(body);
    const key = blobKey("runtime-demo", hash);
    const headers = {
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    };

    const first = await scopedPut(env, `/api/n/runtime-demo/blobs/${hash}`, body, {
      ...headers,
      "Content-Type": "application/vnd.apache.arrow.stream",
    });
    assert.equal(first.status, 201);

    const second = await scopedPut(env, `/api/n/runtime-demo/blobs/${hash}`, body, {
      ...headers,
      "Content-Type": "text/plain",
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), {
      ok: true,
      key,
      size: body.byteLength,
      deduplicated: true,
    });
    assert.equal(
      env.NOTEBOOK_SNAPSHOTS.objects.get(key)?.httpMetadata?.contentType,
      "application/vnd.apache.arrow.stream",
    );
    assert.equal(
      env.DB.blobs.get(`runtime-demo:${hash}`)?.content_type,
      "application/vnd.apache.arrow.stream",
    );
  });

  it("heals a missing catalog row on duplicate blob put", async () => {
    const env = fakeEnv();
    seedNotebook(env, "runtime-demo");
    seedAcl(env, {
      notebookId: "runtime-demo",
      subject: "user:dev:runtime-service",
      scope: "runtime_peer",
    });
    const body = new Uint8Array([5, 6, 7, 8]);
    const hash = await sha256Hex(body);
    const key = blobKey("runtime-demo", hash);
    await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType: "image/png" },
    });
    assert.equal(env.DB.blobs.has(`runtime-demo:${hash}`), false);

    const response = await scopedPut(env, `/api/n/runtime-demo/blobs/${hash}`, body, {
      "Content-Type": "image/png",
      "X-Scope": "runtime_peer",
      "X-User": "runtime-service",
      "X-Operator": "runtime:py-3.12",
    });
    assert.equal(response.status, 200);
    assert.equal(env.DB.blobs.get(`runtime-demo:${hash}`)?.content_type, "image/png");
  });

  it("returns 404 for latest OG image when the notebook is not public", async () => {
    const env = fakeEnv();
    seedNotebook(env, "private-og-demo");
    seedRevision(env, {
      id: "revision-private-og",
      notebookId: "private-og-demo",
      coverBlobHash: "private-og-cover",
      coverMime: "image/png",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(
      blobKey("private-og-demo", "private-og-cover"),
      new Uint8Array([1]),
      { httpMetadata: { contentType: "image/png" } },
    );

    const response = await worker.fetch(
      new Request("http://localhost/n/private-og-demo/r/latest/ogImage.png"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
  });

  it("returns 404 for latest OG image when the public revision has no cover", async () => {
    const env = fakeEnv();
    seedNotebook(env, "no-cover-og-demo");
    seedRevision(env, { id: "revision-no-cover-og", notebookId: "no-cover-og-demo" });
    seedAcl(env, {
      notebookId: "no-cover-og-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/no-cover-og-demo/r/latest/ogImage.png"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
  });

  it("returns 404 for latest OG image when the public cover is SVG-only", async () => {
    const env = fakeEnv();
    seedNotebook(env, "svg-og-demo");
    seedRevision(env, {
      id: "revision-svg-og",
      notebookId: "svg-og-demo",
      coverBlobHash: "svg-cover",
      coverMime: "image/svg+xml",
    });
    seedAcl(env, {
      notebookId: "svg-og-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(blobKey("svg-og-demo", "svg-cover"), "<svg></svg>", {
      httpMetadata: { contentType: "image/svg+xml" },
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/svg-og-demo/r/latest/ogImage.png"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
  });

  it("returns 404 for latest OG image when the cover blob is missing", async () => {
    const env = fakeEnv();
    seedNotebook(env, "missing-cover-og-demo");
    seedRevision(env, {
      id: "revision-missing-cover-og",
      notebookId: "missing-cover-og-demo",
      coverBlobHash: "missing-cover",
      coverMime: "image/jpeg",
    });
    seedAcl(env, {
      notebookId: "missing-cover-og-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/missing-cover-og-demo/r/latest/ogImage.png"),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
  });

  it("serves the latest public raster cover as an OG image", async () => {
    const env = fakeEnv();
    const body = new Uint8Array([137, 80, 78, 71]);
    const coverHash = "public-og-cover";
    seedNotebook(env, "public-og-demo");
    seedRevision(env, {
      id: "revision-public-og",
      notebookId: "public-og-demo",
      coverBlobHash: coverHash,
      coverMime: "image/png",
    });
    seedAcl(env, {
      notebookId: "public-og-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });
    await env.NOTEBOOK_SNAPSHOTS.put(blobKey("public-og-demo", coverHash), body, {
      httpMetadata: { contentType: "image/png" },
    });

    const response = await worker.fetch(
      new Request("http://localhost/n/public-og-demo/r/latest/ogImage.png"),
      env,
      fakeContext(),
    );
    const head = await worker.fetch(
      new Request("http://localhost/n/public-og-demo/r/latest/ogImage.png", { method: "HEAD" }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Type"), "image/png");
    assert.equal(head.headers.get("Cache-Control"), "public, max-age=300");
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
    const catalogBody = (await catalog.json()) as {
      access?: { scope?: string };
      notebook?: { id?: string };
    };
    assert.deepEqual(catalogBody.access, { scope: "viewer" });
    assert.equal(catalogBody.notebook?.id, "public-sharing-demo");

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

  it("returns notebook-scoped author profiles for comment attribution", async () => {
    const canonicalGreg = "account:user%3Aanaconda:email:greg-hash";
    const gregTransport = "user:anaconda:6707d79f-4f39-403e-bb2f-1fccb520c09b";
    const env = fakeEnv({
      NOTEBOOK_ROOMS: fakeNotebookRoomsWithCommentAuthors([`${gregTransport}/browser:tab`]),
    });
    seedNotebook(env, "comment-author-demo");
    const mallory = "user:anaconda:mallory";
    seedAcl(env, {
      notebookId: "comment-author-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "comment-author-demo",
      subject: canonicalGreg,
      scope: "editor",
    });
    env.DB.accountLinks.set(gregTransport, {
      transport_principal: gregTransport,
      canonical_principal: canonicalGreg,
      provider: "user:anaconda",
      email_normalized: "greg@example.com",
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
    });
    env.DB.profiles.set(canonicalGreg, {
      principal: canonicalGreg,
      provider: "user:anaconda",
      provider_subject: null,
      email_normalized: "greg@example.com",
      email_verified: 1,
      display_name: "Greg Jennings",
      avatar_url: "https://profiles.example/greg.png",
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
      raw_claims_json: null,
    });
    env.DB.profiles.set(mallory, {
      principal: mallory,
      provider: "oidc",
      provider_subject: "mallory",
      email_normalized: "mallory@example.com",
      email_verified: 1,
      display_name: "Mallory Example",
      avatar_url: null,
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
      raw_claims_json: null,
    });

    const url = new URL("http://localhost/api/n/comment-author-demo/author-profiles");
    url.searchParams.append("actor_label", `${gregTransport}/browser:tab`);
    url.searchParams.append("actor_label", `${mallory}/browser:tab`);
    url.searchParams.append("actor_label", "not-an-actor-label");
    const response = await worker.fetch(
      new Request(url, {
        headers: {
          "X-User": "alice",
          "X-Operator": "desktop:test",
          "X-Scope": "owner",
        },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { profiles: Array<Record<string, unknown>> };
    assert.deepEqual(body.profiles, [
      {
        principal: gregTransport,
        label: "Greg Jennings",
        image_url: "https://profiles.example/greg.png",
        resolved: true,
      },
    ]);
  });

  it("does not expose email fallback labels to public comment viewers", async () => {
    const env = fakeEnv({
      NOTEBOOK_ROOMS: fakeNotebookRoomsWithCommentAuthors(["user:dev:alice/browser:tab"]),
    });
    seedNotebook(env, "public-author-demo");
    seedAcl(env, {
      notebookId: "public-author-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "public-author-demo",
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
      display_name: null,
      avatar_url: null,
      first_seen_at: "2026-05-28T00:00:00.000Z",
      last_seen_at: "2026-05-28T00:00:00.000Z",
      raw_claims_json: null,
    });

    const url = new URL("http://localhost/api/n/public-author-demo/author-profiles");
    url.searchParams.append("actor_label", "user:dev:alice/browser:tab");
    const response = await worker.fetch(new Request(url), env, fakeContext());

    assert.equal(response.status, 200);
    const body = (await response.json()) as { profiles: Array<Record<string, unknown>> };
    // Allowed but unprofiled: the entry carries no name and no email - label is
    // null, never the email fallback - so a public viewer still cannot learn the
    // author's email.
    assert.deepEqual(body.profiles, [
      {
        principal: "user:dev:alice",
        label: null,
        image_url: null,
        resolved: false,
      },
    ]);
  });

  it("does not expose ACL principal profiles unless they authored visible comments", async () => {
    const env = fakeEnv({
      NOTEBOOK_ROOMS: fakeNotebookRoomsWithCommentAuthors(["user:dev:alice/browser:tab"]),
    });
    seedNotebook(env, "public-comment-author-demo");
    seedAcl(env, {
      notebookId: "public-comment-author-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "public-comment-author-demo",
      subject: "user:dev:bob",
      scope: "editor",
    });
    seedAcl(env, {
      notebookId: "public-comment-author-demo",
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

    const url = new URL("http://localhost/api/n/public-comment-author-demo/author-profiles");
    url.searchParams.append("actor_label", "user:dev:alice/browser:tab");
    url.searchParams.append("actor_label", "user:dev:bob/browser:tab");
    const response = await worker.fetch(new Request(url), env, fakeContext());

    assert.equal(response.status, 200);
    const body = (await response.json()) as { profiles: Array<Record<string, unknown>> };
    assert.deepEqual(body.profiles, [
      {
        principal: "user:dev:alice",
        label: "Alice Example",
        image_url: null,
        resolved: true,
      },
    ]);
  });

  it("closes anonymous live viewers when public link access is revoked", async () => {
    const roomRequests: Request[] = [];
    const env = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            roomRequests.push(request.clone());
            return Response.json({ ok: true, closed_anonymous_viewers: 1 });
          },
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "public-revoke-demo");
    seedAcl(env, {
      notebookId: "public-revoke-demo",
      subject: "user:dev:alice",
      scope: "owner",
    });
    seedAcl(env, {
      notebookId: "public-revoke-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const response = await aclRequest(
      env,
      "DELETE",
      {
        subject_kind: "public",
        subject: "anonymous",
        scope: "viewer",
      },
      "public-revoke-demo",
    );

    assert.equal(response.status, 200);
    assert.equal(roomRequests.length, 1);
    const roomRequest = roomRequests[0];
    assert.ok(roomRequest);
    assert.equal(
      new URL(roomRequest.url).pathname,
      "/internal/n/public-revoke-demo/access-revocation",
    );
    assert.deepEqual(await roomRequest.json(), {
      close_anonymous_viewers: true,
      close_reason: "public link access revoked",
    });
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

  it("downgrades OIDC editor WebSocket requests to granted viewer access", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      email: "viewer@example.com",
      extraPayload: { email_verified: true },
      name: "Viewer Example",
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
    seedNotebook(env, "shared-view-demo");
    seedAcl(env, {
      notebookId: "shared-view-demo",
      subject: "user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request("https://cloud.test/n/shared-view-demo/sync?operator=browser:tab&scope=editor", {
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

  it("stores OIDC profile labels and avatars even when there are no pending invites", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "fe0f6c3a-f7c7-4c04-9b8d-77e596da1375",
      email: "kkelley@anaconda.com",
      extraPayload: {
        email_verified: true,
        picture: "https://profiles.example/kkelley.png",
      },
      name: "Kyle Kelley",
    });
    const waitUntilPromises: Promise<unknown>[] = [];
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
      fakeContextWithWaitUntil(waitUntilPromises),
    );

    assert.equal(response.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
    const profile = env.DB.profiles.get("user:anaconda:fe0f6c3a-f7c7-4c04-9b8d-77e596da1375");
    assert.equal(profile?.provider, "oidc");
    assert.equal(profile?.email_normalized, "kkelley@anaconda.com");
    assert.equal(profile?.email_verified, 1);
    assert.equal(profile?.display_name, "Kyle Kelley");
    assert.equal(profile?.avatar_url, "https://profiles.example/kkelley.png");
  });

  it("stores null avatar URLs when OIDC picture claims are absent", async () => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "no-picture-user",
      email: "no-picture@example.com",
      extraPayload: { email_verified: true },
      name: "No Picture",
    });
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = fakeEnv({
      ...oidcEnv,
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => new Response("room ok"),
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(env, "oidc-no-picture-demo");
    seedAcl(env, {
      notebookId: "oidc-no-picture-demo",
      subject: "user:anaconda:no-picture-user",
      scope: "viewer",
    });

    const response = await worker.fetch(
      new Request(
        "https://cloud.test/n/oidc-no-picture-demo/sync?operator=browser:tab&scope=viewer",
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
      fakeContextWithWaitUntil(waitUntilPromises),
    );

    assert.equal(response.status, 200);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
    const profile = env.DB.profiles.get("user:anaconda:no-picture-user");
    assert.equal(profile?.provider, "oidc");
    assert.equal(profile?.avatar_url, null);
  });

  it("does not store room connection profiles for dev or anonymous viewers", async () => {
    const devWaitUntilPromises: Promise<unknown>[] = [];
    const devEnv = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => new Response("room ok"),
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(devEnv, "dev-profile-demo");
    seedAcl(devEnv, {
      notebookId: "dev-profile-demo",
      subject: "user:dev:alice",
      scope: "viewer",
    });

    const devResponse = await worker.fetch(
      new Request(
        "http://localhost/n/dev-profile-demo/sync?user=alice&operator=desktop:a&scope=viewer",
        {
          headers: {
            Upgrade: "websocket",
          },
        },
      ),
      devEnv,
      fakeContextWithWaitUntil(devWaitUntilPromises),
    );

    assert.equal(devResponse.status, 200);
    await Promise.all(devWaitUntilPromises);
    assert.equal(devEnv.DB.profiles.size, 0);

    const anonymousWaitUntilPromises: Promise<unknown>[] = [];
    const anonymousEnv = fakeEnv({
      NOTEBOOK_ROOMS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => new Response("room ok"),
        }),
      } satisfies DurableObjectNamespace,
    });
    seedNotebook(anonymousEnv, "anonymous-profile-demo");
    seedAcl(anonymousEnv, {
      notebookId: "anonymous-profile-demo",
      subjectKind: "public",
      subject: "anonymous",
      scope: "viewer",
    });

    const anonymousResponse = await worker.fetch(
      new Request("http://localhost/n/anonymous-profile-demo/sync?viewer_session=anon", {
        headers: {
          Upgrade: "websocket",
        },
      }),
      anonymousEnv,
      fakeContextWithWaitUntil(anonymousWaitUntilPromises),
    );

    assert.equal(anonymousResponse.status, 200);
    await Promise.all(anonymousWaitUntilPromises);
    assert.equal(anonymousEnv.DB.profiles.size, 0);
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
    const routeNotebook = env.DB.notebooks.get("route-demo");
    assert.equal(routeNotebook?.cell_composition, JSON.stringify({ code: 1, markdown: 0, raw: 0 }));
    const listResponse = await worker.fetch(
      new Request("http://localhost/api/n", {
        headers: {
          "X-User": "alice",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as {
      notebooks: Array<{
        composition?: { code: number; markdown: number; raw: number };
        notebook_id: string;
      }>;
    };
    assert.deepEqual(
      listBody.notebooks.find((notebook) => notebook.notebook_id === "route-demo")?.composition,
      { code: 1, markdown: 0, raw: 0 },
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

  it("persists snapshot cell composition, preview cells, and notebook language for list rows", async () => {
    const env = fakeEnv();
    const { notebookBytes, runtimeStateBytes } = pythonSummarySnapshotPair(
      "summary-demo",
      "runtime:summary-demo",
    );

    const runtimePut = await ownerPut(
      env,
      "/api/n/summary-demo/runtime-snapshots/runtime-summary",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:summary-demo",
      },
    );
    assert.equal(runtimePut.status, 201);

    const notebookPut = await ownerPut(
      env,
      "/api/n/summary-demo/snapshots/heads-summary",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-summary",
        "X-Runtime-State-Doc-Id": "runtime:summary-demo",
      },
    );
    assert.equal(notebookPut.status, 201);

    const notebook = env.DB.notebooks.get("summary-demo");
    assert.equal(notebook?.cell_composition, JSON.stringify({ code: 1, markdown: 1, raw: 1 }));
    assert.equal(
      notebook?.preview_cells,
      JSON.stringify([
        { kind: "markdown", text: "# Summary heading" },
        { kind: "code", text: "print('first code')" },
      ]),
    );
    assert.equal(notebook?.language, "python");

    const listResponse = await worker.fetch(
      new Request("http://localhost/api/n", {
        headers: {
          "X-User": "alice",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as {
      notebooks: Array<{
        composition?: { code: number; markdown: number; raw: number };
        language?: string;
        notebook_id: string;
        preview?: Array<{ kind: string; text: string; execution_count?: number }>;
      }>;
    };
    const row = listBody.notebooks.find((candidate) => candidate.notebook_id === "summary-demo");
    assert.deepEqual(row?.composition, { code: 1, markdown: 1, raw: 1 });
    assert.deepEqual(row?.preview, [
      { kind: "markdown", text: "# Summary heading" },
      { kind: "code", text: "print('first code')" },
    ]);
    assert.equal(row?.language, "python");
  });

  it("persists snapshot covers from image output manifests for list rows", async () => {
    const env = fakeEnv();
    const coverHash = "fake_image_blob_hash_for_fixture_testing_only_not_real";
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/display_data_output/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/display_data_output/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);
    await env.NOTEBOOK_SNAPSHOTS.put(blobKey("cover-demo", coverHash), new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const runtimePut = await ownerPut(
      env,
      "/api/n/cover-demo/runtime-snapshots/runtime-display",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:display-data",
      },
    );
    assert.equal(runtimePut.status, 201);

    const notebookPut = await ownerPut(
      env,
      "/api/n/cover-demo/snapshots/heads-display",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-display",
        "X-Runtime-State-Doc-Id": "runtime:display-data",
      },
    );
    assert.equal(notebookPut.status, 201);
    assert.equal(env.DB.revisions[0]?.cover_blob_hash, coverHash);
    assert.equal(env.DB.revisions[0]?.cover_mime, "image/png");

    const listResponse = await worker.fetch(
      new Request("http://localhost/api/n", {
        headers: {
          "X-User": "alice",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as {
      notebooks: Array<{
        cover?: { blob_hash: string; mime: string };
        notebook_id: string;
      }>;
    };
    assert.deepEqual(
      listBody.notebooks.find((notebook) => notebook.notebook_id === "cover-demo")?.cover,
      { blob_hash: coverHash, mime: "image/png" },
    );
  });

  it("ignores malformed image output manifests when deriving snapshot covers", async () => {
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
    const fixtureHandle = NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
    const cells = JSON.parse(fixtureHandle.get_cells_json()) as Array<{
      execution_id?: unknown;
    }>;
    fixtureHandle.free();
    const executionId = cells[0]?.execution_id;
    if (typeof executionId !== "string") {
      assert.fail("output_streaming fixture should have a synced execution id");
    }

    const runtimeHandle = RuntimeStatePeerHandle.load(runtimeStateBytes, "runtime:test");
    let malformedRuntimeStateBytes: Uint8Array;
    try {
      runtimeHandle.append_output_json(
        executionId,
        JSON.stringify({
          output_type: "display_data",
          output_id: "malformed-image-output",
          data: {
            "image/png": "not-a-content-ref",
          },
          metadata: {},
        }),
      );
      malformedRuntimeStateBytes = runtimeHandle.save();
    } finally {
      runtimeHandle.free();
    }

    const runtimePut = await ownerPut(
      env,
      "/api/n/malformed-cover-demo/runtime-snapshots/runtime-malformed",
      malformedRuntimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:output-streaming",
      },
    );
    assert.equal(runtimePut.status, 201);

    const notebookPut = await ownerPut(
      env,
      "/api/n/malformed-cover-demo/snapshots/heads-malformed",
      notebookBytes,
      {
        "X-Runtime-Heads-Hash": "runtime-malformed",
        "X-Runtime-State-Doc-Id": "runtime:output-streaming",
      },
    );
    assert.equal(notebookPut.status, 201);
    assert.equal(env.DB.revisions[0]?.cover_blob_hash, null);
    assert.equal(env.DB.revisions[0]?.cover_mime, null);

    const listResponse = await worker.fetch(
      new Request("http://localhost/api/n", {
        headers: {
          "X-User": "alice",
          "X-Operator": "desktop:test",
          "X-Scope": "viewer",
        },
      }),
      env,
      fakeContext(),
    );
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as {
      notebooks: Array<{
        cover?: unknown;
        notebook_id: string;
      }>;
    };
    assert.equal(
      listBody.notebooks.find((notebook) => notebook.notebook_id === "malformed-cover-demo")?.cover,
      undefined,
    );
  });

  it("does not fail snapshot publish when derived summary persistence fails", async () => {
    const env = fakeEnv();
    env.DB.failNotebookSummaryUpdate = true;
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
      "/api/n/summary-fail-open/runtime-snapshots/runtime-fixture",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:output-streaming",
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
        "/api/n/summary-fail-open/snapshots/heads-fixture",
        notebookBytes,
        {
          "X-Runtime-Heads-Hash": "runtime-fixture",
          "X-Runtime-State-Doc-Id": "runtime:output-streaming",
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 201);
    assert.equal(env.DB.revisions.length, 1);
    assert.equal(
      env.DB.notebooks.get("summary-fail-open")?.latest_revision_id,
      env.DB.revisions[0]?.id,
    );
    assert.equal(env.DB.notebooks.get("summary-fail-open")?.cell_composition, null);
    assert.equal(env.DB.notebooks.get("summary-fail-open")?.preview_cells, null);
    assert.ok(
      warnings.some(
        (entry) =>
          entry[0] === "[notebook-cloud]" &&
          (entry[1] as { event?: string }).event === "snapshot.summary.update_failed",
      ),
    );
  });

  it("does not fail snapshot publish when derived cover persistence fails", async () => {
    const env = fakeEnv();
    env.DB.failNotebookCoverUpdate = true;
    const coverHash = "fake_image_blob_hash_for_fixture_testing_only_not_real";
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/display_data_output/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/display_data_output/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);
    await env.NOTEBOOK_SNAPSHOTS.put(
      blobKey("cover-fail-open", coverHash),
      new Uint8Array([1, 2, 3]),
      { httpMetadata: { contentType: "image/png" } },
    );

    const runtimePut = await ownerPut(
      env,
      "/api/n/cover-fail-open/runtime-snapshots/runtime-display",
      runtimeStateBytes,
      {
        "X-Runtime-State-Doc-Id": "runtime:display-data",
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
        "/api/n/cover-fail-open/snapshots/heads-display",
        notebookBytes,
        {
          "X-Runtime-Heads-Hash": "runtime-display",
          "X-Runtime-State-Doc-Id": "runtime:display-data",
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(response.status, 201);
    assert.equal(env.DB.revisions.length, 1);
    assert.equal(env.DB.revisions[0]?.cover_blob_hash, null);
    assert.ok(
      warnings.some(
        (entry) =>
          entry[0] === "[notebook-cloud]" &&
          (entry[1] as { event?: string }).event === "snapshot.cover.update_failed",
      ),
    );
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

  it("rejects snapshot renders that reference more blobs than the cap", () => {
    const over = {
      blob_urls: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`sha256:${i}`, `https://x/${i}`]),
      ),
    };
    assert.deepEqual(snapshotBlobRefsOverCap(over, 4), { count: 5, cap: 4, over: true });
    assert.deepEqual(snapshotBlobRefsOverCap(over, 5), { count: 5, cap: 5, over: false });
  });
});

describe("catalog schema migrations", () => {
  it("converges workstation attach active uniqueness to the owner-level index name", async () => {
    const legacyDrop = "DROP INDEX IF EXISTS workstation_attach_jobs_active_unique_idx";
    const ownerIndexCreate =
      "CREATE UNIQUE INDEX IF NOT EXISTS workstation_attach_jobs_active_owner_unique_idx";
    const legacyIndexCreate =
      "CREATE UNIQUE INDEX IF NOT EXISTS workstation_attach_jobs_active_unique_idx";

    const storageSource = await readFile(new URL("../src/storage.ts", import.meta.url), "utf8");
    const dropOffset = storageSource.indexOf(legacyDrop);
    const createOffset = storageSource.indexOf(ownerIndexCreate);
    assert.ok(dropOffset >= 0, "runtime schema drops the old 3-column index name");
    assert.ok(createOffset >= 0, "runtime schema creates the new owner-level index name");
    assert.ok(dropOffset < createOffset, "runtime schema drops the old name before creating new");
    assert.equal(
      storageSource.includes(`${legacyIndexCreate}\n    ON workstation_attach_jobs`),
      false,
      "runtime schema does not recreate the old index name",
    );

    const migration = await readFile(
      new URL("../migrations/0008_workstation_attach_active_owner_unique.sql", import.meta.url),
      "utf8",
    );
    assert.ok(migration.includes(legacyDrop), "migration drops the old index name");
    assert.ok(migration.includes(ownerIndexCreate), "migration creates the new index name");
    assert.equal(
      migration.includes(`${legacyIndexCreate}\n  ON workstation_attach_jobs`),
      false,
      "migration does not recreate the old index name",
    );
  });

  it("adds dashboard summary and cover columns via ALTER TABLE when absent", async () => {
    const db = new FakeD1();
    // Simulate a pre-migration deployment: the columns do not exist yet.
    const notebookColumns = db.tableColumns.get("notebooks");
    assert.ok(notebookColumns);
    notebookColumns.delete("cell_composition");
    notebookColumns.delete("preview_cells");
    notebookColumns.delete("language");
    const revisionColumns = db.tableColumns.get("notebook_revisions");
    assert.ok(revisionColumns);
    revisionColumns.delete("cover_blob_hash");
    revisionColumns.delete("cover_mime");
    const attachJobColumns = db.tableColumns.get("workstation_attach_jobs");
    assert.ok(attachJobColumns);
    attachJobColumns.delete("trigger");

    const env = fakeEnv({ DB: db });
    await runCatalogMigrations(env);

    const migrated = db.tableColumns.get("notebooks");
    assert.ok(migrated?.has("cell_composition"), "cell_composition added by migration");
    assert.ok(migrated?.has("preview_cells"), "preview_cells added by migration");
    assert.ok(migrated?.has("language"), "language added by migration");
    const migratedRevisions = db.tableColumns.get("notebook_revisions");
    assert.ok(migratedRevisions?.has("cover_blob_hash"), "cover_blob_hash added by migration");
    assert.ok(migratedRevisions?.has("cover_mime"), "cover_mime added by migration");
    const migratedAttachJobs = db.tableColumns.get("workstation_attach_jobs");
    assert.ok(migratedAttachJobs?.has("trigger"), "attach job trigger added by migration");
  });
});

describe("Workstation pairing", () => {
  const PAIRING_CODE_PATTERN =
    /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;
  const OWNER_HEADERS = {
    "X-User": "alice",
    "X-Operator": "browser:tab",
    "X-Scope": "owner",
  };

  async function mintPairingCode(env: FakeEnv): Promise<{
    id: string;
    code: string;
    expires_at: string;
  }> {
    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/pairing-codes", {
        method: "POST",
        headers: OWNER_HEADERS,
      }),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      ok: boolean;
      pairing: { id: string; code: string; expires_at: string };
    };
    assert.equal(body.ok, true);
    return body.pairing;
  }

  async function redeemPairingCode(env: FakeEnv, code: string): Promise<Response> {
    return worker.fetch(
      new Request("http://localhost/api/workstations/pairing-codes/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      }),
      env,
      fakeContext(),
    );
  }

  async function redeemedCredentialToken(env: FakeEnv, code: string): Promise<string> {
    const redeem = await redeemPairingCode(env, code);
    assert.equal(redeem.status, 201);
    const body = (await redeem.json()) as { credential: { token: string } };
    return body.credential.token;
  }

  async function pairingStatus(
    env: FakeEnv,
    pairingId: string,
  ): Promise<{ status: string; workstation_id: string | null }> {
    const response = await worker.fetch(
      new Request(`http://localhost/api/workstations/pairing-codes/${pairingId}`, {
        headers: OWNER_HEADERS,
      }),
      env,
      fakeContext(),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      pairing: { status: string; workstation_id: string | null };
    };
    return body.pairing;
  }

  async function registerWorkstationWithToken(
    env: FakeEnv,
    token: string,
    workstationId: string,
  ): Promise<Response> {
    return worker.fetch(
      new Request("http://localhost/api/workstations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workstation_id: workstationId,
          display_name: "Paired Lab",
          provider: "runtime_peer",
        }),
      }),
      env,
      fakeContext(),
    );
  }

  it("requires sign-in to mint pairing codes", async () => {
    const env = fakeEnv();

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/pairing-codes", { method: "POST" }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "sign in to add a workstation" });
    assert.equal(env.DB.workstationPairingCodes.size, 0);
  });

  it("mints, redeems, and registers a workstation through a pairing code", async () => {
    const env = fakeEnv();

    const pairing = await mintPairingCode(env);
    assert.match(pairing.code, PAIRING_CODE_PATTERN);
    assert.ok(pairing.id);
    assert.ok(Date.parse(pairing.expires_at) > Date.now());

    assert.equal((await pairingStatus(env, pairing.id)).status, "pending");

    const redeem = await redeemPairingCode(env, pairing.code);
    assert.equal(redeem.status, 201);
    const redeemed = (await redeem.json()) as {
      ok: boolean;
      credential: { token: string; credential_id: string };
      pairing: { id: string };
    };
    assert.equal(redeemed.ok, true);
    assert.ok(redeemed.credential.token.startsWith("nwc_"));
    assert.ok(redeemed.credential.credential_id);
    assert.equal(redeemed.pairing.id, pairing.id);

    assert.equal((await pairingStatus(env, pairing.id)).status, "redeemed");

    const register = await registerWorkstationWithToken(
      env,
      redeemed.credential.token,
      "ws-paired",
    );
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { workstation: Record<string, unknown> };
    assert.equal(registered.workstation.workstation_id, "ws-paired");
    assert.equal(registered.workstation.is_default, true);

    const status = await pairingStatus(env, pairing.id);
    assert.equal(status.status, "registered");
    assert.equal(status.workstation_id, "ws-paired");

    const list = await worker.fetch(
      new Request("http://localhost/api/workstations", { headers: OWNER_HEADERS }),
      env,
      fakeContext(),
    );
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      default_workstation_id: string | null;
      workstations: Array<Record<string, unknown>>;
    };
    assert.equal(listBody.default_workstation_id, "ws-paired");
    assert.equal(listBody.workstations.length, 1);
    assert.equal(listBody.workstations[0]?.workstation_id, "ws-paired");
    assert.equal(listBody.workstations[0]?.is_default, true);
  });

  it("rejects pairing code replay after the first redeem", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);

    assert.equal((await redeemPairingCode(env, pairing.code)).status, 201);

    const replay = await redeemPairingCode(env, pairing.code);
    assert.equal(replay.status, 404);
    assert.deepEqual(await replay.json(), {
      error: "pairing code is invalid, expired, or already used",
    });
    assert.equal(env.DB.workstationCredentials.size, 1);
  });

  it("rejects expired pairing codes and reports expired status", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);

    const row = env.DB.workstationPairingCodes.get(pairing.id);
    assert.ok(row);
    row.expires_at = new Date(Date.now() - 1000).toISOString();

    const redeem = await redeemPairingCode(env, pairing.code);
    assert.equal(redeem.status, 404);
    assert.equal(env.DB.workstationCredentials.size, 0);

    assert.equal((await pairingStatus(env, pairing.id)).status, "expired");
  });

  it("accepts pairing codes lowercased with spaces instead of dashes", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);

    const sloppy = pairing.code.toLowerCase().replaceAll("-", " ");
    const redeem = await redeemPairingCode(env, sloppy);
    assert.equal(redeem.status, 201);
    const redeemed = (await redeem.json()) as { credential: { token: string } };
    assert.ok(redeemed.credential.token.startsWith("nwc_"));
  });

  it("rejects workstation credentials outside the workstation surface", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const createNotebook = await worker.fetch(
      new Request("http://localhost/api/n", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      fakeContext(),
    );
    assert.equal(createNotebook.status, 403);
    const createBody = (await createNotebook.json()) as { error: string };
    assert.match(createBody.error, /workstation credentials/);
    assert.equal(env.DB.notebooks.size, 0);

    const selectDefault = await worker.fetch(
      new Request("http://localhost/api/workstations/default", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workstation_id: "ws-any" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(selectDefault.status, 403);
  });

  it("clamps workstation credential scope requests", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const ownerScope = await worker.fetch(
      new Request("http://localhost/api/workstations", {
        headers: { Authorization: `Bearer ${token}`, "X-Scope": "owner" },
      }),
      env,
      fakeContext(),
    );
    assert.equal(ownerScope.status, 403);
    const ownerScopeBody = (await ownerScope.json()) as { error: string };
    assert.match(ownerScopeBody.error, /workstation credentials cannot request owner scope/);

    const runtimePeerScope = await worker.fetch(
      new Request("http://localhost/api/workstations", {
        headers: { Authorization: `Bearer ${token}`, "X-Scope": "runtime_peer" },
      }),
      env,
      fakeContext(),
    );
    assert.equal(runtimePeerScope.status, 200);
  });

  it("lets a paired workstation credential poll attach jobs", async () => {
    const env = fakeEnv();
    seedNotebook(env, "pairing-attach-demo");
    seedAcl(env, { notebookId: "pairing-attach-demo", subject: "user:dev:alice", scope: "owner" });

    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const register = await registerWorkstationWithToken(env, token, "ws-paired");
    assert.equal(register.status, 201);

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/pairing-attach-demo/workstation-attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({ workstation_id: "ws-paired" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(attach.status, 202);
    const attachBody = (await attach.json()) as { job: { job_id: string } };

    const poll = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-paired/attach-jobs", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      fakeContext(),
    );
    assert.equal(poll.status, 200);
    const polled = (await poll.json()) as { jobs: Array<{ job_id: string }> };
    assert.deepEqual(
      polled.jobs.map((job) => job.job_id),
      [attachBody.job.job_id],
    );
  });

  it("asks stale workstation credentials to back off when polling attach jobs", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const poll = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-missing/attach-jobs", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      fakeContext(),
    );

    assert.equal(poll.status, 404);
    assert.equal(poll.headers.get("Retry-After"), "900");
    assert.deepEqual(await poll.json(), {
      error: "workstation not found",
      code: "workstation_not_found",
    });
  });

  it("lets a paired workstation credential open the workstation event socket", async () => {
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);
    const register = await registerWorkstationWithToken(env, token, "ws-paired");
    assert.equal(register.status, 201);

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-paired/events", {
        headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fake-websocket-upgrade"), "1");
    assert.equal(events.requests.length, 1);
    assert.equal(
      events.requests[0]?.objectName,
      workstationEventsObjectName("user:dev:alice", "ws-paired"),
    );
    assert.equal(new URL(events.requests[0]!.url).pathname, "/stream");
    assert.equal(events.requests[0]?.upgrade, "websocket");
  });

  it("asks stale workstation credentials to back off when opening event sockets", async () => {
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-missing/events", {
        headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Retry-After"), "900");
    assert.deepEqual(await response.json(), {
      error: "workstation not found",
      code: "workstation_not_found",
    });
    assert.equal(events.requests.length, 0);
  });

  it("rejects workstation event requests that are not websocket upgrades", async () => {
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);
    const register = await registerWorkstationWithToken(env, token, "ws-paired");
    assert.equal(register.status, 201);

    const response = await worker.fetch(
      new Request("http://localhost/api/workstations/ws-paired/events", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      fakeContext(),
    );

    assert.equal(response.status, 426);
    assert.deepEqual(await response.json(), { error: "expected WebSocket upgrade" });
    assert.equal(events.requests.length, 0);
  });

  it("notifies the paired workstation event socket when an owner creates an attach job", async () => {
    const events = new FakeWorkstationEventsNamespace();
    const env = fakeEnv({ WORKSTATION_EVENTS: events });
    seedNotebook(env, "pairing-events-demo");
    seedAcl(env, { notebookId: "pairing-events-demo", subject: "user:dev:alice", scope: "owner" });

    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);
    const register = await registerWorkstationWithToken(env, token, "ws-paired");
    assert.equal(register.status, 201);

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/pairing-events-demo/workstation-attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({ workstation_id: "ws-paired" }),
      }),
      env,
      fakeContext(),
    );

    assert.equal(attach.status, 202);
    const attachBody = (await attach.json()) as { job: { job_id: string } };
    const notify = events.requests.find((entry) => new URL(entry.url).pathname === "/notify");
    assert.ok(notify);
    assert.equal(notify.objectName, workstationEventsObjectName("user:dev:alice", "ws-paired"));
    assert.deepEqual(notify.body, {
      event: "attach_jobs",
      workstation_id: "ws-paired",
      job_id: attachBody.job.job_id,
      notebook_id: "pairing-events-demo",
      status: "pending",
      requested_at: env.DB.workstationAttachJobs.get(attachBody.job.job_id)?.requested_at,
      updated_at: env.DB.workstationAttachJobs.get(attachBody.job.job_id)?.updated_at,
    });
  });

  it("lets a paired workstation credential upload runtime output blobs", async () => {
    const env = fakeEnv();
    seedNotebook(env, "pairing-blob-demo");
    seedAcl(env, { notebookId: "pairing-blob-demo", subject: "user:dev:alice", scope: "owner" });

    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const register = await registerWorkstationWithToken(env, token, "ws-paired");
    assert.equal(register.status, 201);

    const attach = await worker.fetch(
      new Request("http://localhost/api/n/pairing-blob-demo/workstation-attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({ workstation_id: "ws-paired" }),
      }),
      env,
      fakeContext(),
    );
    assert.equal(attach.status, 202);

    const body = new Uint8Array([1, 3, 3, 7]);
    const hash = await sha256Hex(body);

    const response = await scopedPut(env, `/api/n/pairing-blob-demo/blobs/${hash}`, body, {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.apache.arrow.stream",
      "X-Scope": "runtime_peer",
      "X-Operator": "agent:runt:blob-publisher",
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      ok: true,
      key: blobKey("pairing-blob-demo", hash),
      size: body.byteLength,
    });
    assert.equal(env.NOTEBOOK_SNAPSHOTS.objects.has(blobKey("pairing-blob-demo", hash)), true);
    assert.deepEqual(env.DB.blobs.get(`pairing-blob-demo:${hash}`), {
      notebook_id: "pairing-blob-demo",
      hash,
      size: body.byteLength,
      content_type: "application/vnd.apache.arrow.stream",
      r2_key: blobKey("pairing-blob-demo", hash),
      uploaded_at: env.DB.blobs.get(`pairing-blob-demo:${hash}`)?.uploaded_at,
    });
  });

  it("consumes and mints in one batch so a code cannot burn without a credential", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);

    await redeemedCredentialToken(env, pairing.code);

    assert.ok(
      env.DB.batchSizes.includes(2),
      "redeem must issue the consume UPDATE and credential INSERT as one batch transaction",
    );
    const row = env.DB.workstationPairingCodes.get(pairing.id);
    assert.ok(row?.redeemed_by_credential_id, "consume stamps the per-request credential marker");
    const credential = [...env.DB.workstationCredentials.values()][0];
    assert.equal(credential?.id, row?.redeemed_by_credential_id);
  });

  it("lists and revokes workstation credentials; revoked bearers lose access", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);
    assert.equal((await registerWorkstationWithToken(env, token, "ws-paired")).status, 201);

    const list = await worker.fetch(
      new Request("http://localhost/api/workstations/credentials", { headers: OWNER_HEADERS }),
      env,
      fakeContext(),
    );
    assert.equal(list.status, 200);
    const listed = (await list.json()) as {
      credentials: Array<{ credential_id: string; revoked_at: string | null }>;
    };
    assert.equal(listed.credentials.length, 1);
    assert.equal(listed.credentials[0]?.revoked_at, null);
    const credentialId = listed.credentials[0]!.credential_id;

    const revoke = await worker.fetch(
      new Request(`http://localhost/api/workstations/credentials/${credentialId}/revoke`, {
        method: "POST",
        headers: OWNER_HEADERS,
      }),
      env,
      fakeContext(),
    );
    assert.equal(revoke.status, 200);
    assert.deepEqual(await revoke.json(), {
      ok: true,
      credential_id: credentialId,
      revoked: true,
    });

    const heartbeat = await registerWorkstationWithToken(env, token, "ws-paired");
    assert.equal(heartbeat.status, 401);
    assert.deepEqual(await heartbeat.json(), {
      error: "workstation credential is not recognized",
    });

    const replayRevoke = await worker.fetch(
      new Request(`http://localhost/api/workstations/credentials/${credentialId}/revoke`, {
        method: "POST",
        headers: OWNER_HEADERS,
      }),
      env,
      fakeContext(),
    );
    assert.equal(replayRevoke.status, 404);
  });

  it("denies the credential-management surface to workstation credentials", async () => {
    const env = fakeEnv();
    const pairing = await mintPairingCode(env);
    const token = await redeemedCredentialToken(env, pairing.code);

    const list = await worker.fetch(
      new Request("http://localhost/api/workstations/credentials", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      fakeContext(),
    );
    assert.equal(list.status, 403);

    const revoke = await worker.fetch(
      new Request("http://localhost/api/workstations/credentials/any-id/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      fakeContext(),
    );
    assert.equal(revoke.status, 403);
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
    cell_composition: null,
    preview_cells: null,
    language: null,
  });
}

function principalProfileRow(overrides: Partial<PrincipalProfileRow> = {}): PrincipalProfileRow {
  return {
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
    ...overrides,
  };
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

function seedRevision(
  env: FakeEnv,
  input: {
    id: string;
    notebookId: string;
    coverBlobHash?: string | null;
    coverMime?: string | null;
  },
): void {
  env.DB.revisions.push({
    id: input.id,
    notebook_id: input.notebookId,
    runtime_state_doc_id: `runtime:${input.notebookId}`,
    notebook_heads_hash: `heads:${input.id}`,
    runtime_heads_hash: `runtime:${input.id}`,
    comms_heads_hash: null,
    comments_heads_hash: null,
    snapshot_key: snapshotKey(input.notebookId, `heads:${input.id}`),
    runtime_snapshot_key: runtimeStateSnapshotKey(
      `runtime:${input.notebookId}`,
      `runtime:${input.id}`,
    ),
    comms_snapshot_key: null,
    comments_snapshot_key: null,
    cover_blob_hash: input.coverBlobHash ?? null,
    cover_mime: input.coverMime ?? null,
    actor_label: "user:dev:alice/desktop:test",
    created_at: "2026-05-22T00:00:00.000Z",
  });
  const notebook = env.DB.notebooks.get(input.notebookId);
  if (notebook) {
    notebook.latest_revision_id = input.id;
  }
}

function seedWorkstation(
  env: FakeEnv,
  input: {
    ownerPrincipal: string;
    workstationId: string;
    status?: WorkstationRow["status"];
    lastSeenAt?: string;
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
    last_seen_at: input.lastSeenAt ?? new Date().toISOString(),
  });
}

function seedWorkstationLease(
  compute: FakeOwnerComputeIndexNamespace,
  input: {
    ownerPrincipal: string;
    workstationId: string;
    lastSeenAt: string;
    leaseExpiresAt?: number;
    offlineReason?: string | null;
    online?: boolean;
  },
): void {
  compute.leases.set(input.workstationId, {
    workstation_id: input.workstationId,
    owner_principal: input.ownerPrincipal,
    last_seen_at: input.lastSeenAt,
    lease_expires_at: input.leaseExpiresAt ?? Date.now() + 60_000,
    online: input.online ?? true,
    offline_reason: input.offlineReason ?? null,
  });
}

function seedWorkstationAttachJob(
  env: FakeEnv,
  input: {
    id: string;
    notebookId: string;
    ownerPrincipal: string;
    workstationId: string;
    errorMessage?: string | null;
    finishedAt?: string | null;
    requestedAt?: string;
    status?: WorkstationAttachJobRow["status"];
    trigger?: WorkstationAttachJobRow["trigger"];
    updatedAt?: string;
  },
): void {
  env.DB.workstationAttachJobs.set(input.id, {
    id: input.id,
    notebook_id: input.notebookId,
    owner_principal: input.ownerPrincipal,
    workstation_id: input.workstationId,
    status: input.status ?? "pending",
    trigger: input.trigger ?? "user_attach",
    requested_by_actor_label: "user:dev:alice/browser:tab",
    requested_at: input.requestedAt ?? "2026-05-22T00:00:00.000Z",
    updated_at: input.updatedAt ?? "2026-05-22T00:00:00.000Z",
    accepted_at: null,
    finished_at: input.finishedAt ?? null,
    error_message: input.errorMessage ?? null,
  });
}

function isActiveWorkstationAttachJob(
  job: WorkstationAttachJobRow,
  {
    pendingStaleBefore,
    staleBefore,
  }: {
    pendingStaleBefore: string;
    staleBefore: string;
  },
): boolean {
  return (
    (job.status === "pending" && job.requested_at >= pendingStaleBefore) ||
    ((job.status === "accepted" || job.status === "running") && job.updated_at >= staleBefore)
  );
}

function isActiveWorkstationAttachJobStatus(status: WorkstationAttachJobRow["status"]): boolean {
  return status === "pending" || status === "accepted" || status === "running";
}

function workstationAttachJobStatusRank(status: WorkstationAttachJobRow["status"]): number {
  switch (status) {
    case "pending":
      return 0;
    case "accepted":
      return 1;
    case "running":
      return 2;
    case "failed":
    case "completed":
    case "cancelled":
      return 3;
  }
}

function cloneWorkstationAttachJobs(
  jobs: ReadonlyMap<string, WorkstationAttachJobRow>,
): Map<string, WorkstationAttachJobRow> {
  return new Map([...jobs].map(([id, job]) => [id, { ...job }]));
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

function pythonSummarySnapshotPair(
  notebookId: string,
  runtimeStateDocId: string,
): { notebookBytes: Uint8Array; runtimeStateBytes: Uint8Array } {
  const notebook = new NotebookHandle(notebookId);
  const runtime = new RuntimeStatePeerHandle("runtime");
  try {
    notebook.set_runtime_state_doc_id(runtimeStateDocId);
    notebook.set_metadata_snapshot_value({
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
      },
      runt: {
        schema_version: "1",
      },
    });
    notebook.add_cell_after("cell-code", "code", null);
    notebook.add_cell_after("cell-markdown", "markdown", "cell-code");
    notebook.add_cell_after("cell-raw", "raw", "cell-markdown");
    notebook.update_source("cell-code", "import pandas as pd\nprint('first code')");
    notebook.update_source("cell-markdown", "# Summary heading\n\nNarrative body");
    notebook.update_source("cell-raw", "raw note");
    return {
      notebookBytes: notebook.save(),
      runtimeStateBytes: runtime.save(),
    };
  } finally {
    notebook.free();
    runtime.free();
  }
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

function fakeNotebookRoomsWithCommentAuthors(
  actorLabels: readonly string[],
): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => ({
      fetch: async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/comment-authors")) {
          return Response.json({
            notebook_id: id.toString(),
            actor_labels: actorLabels,
          });
        }
        return new Response("not implemented", { status: 501 });
      },
    }),
  } satisfies DurableObjectNamespace;
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

function fakeNotebookRouteAssets(seenPaths: string[] = []): Env["ASSETS"] {
  return {
    fetch: async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      seenPaths.push(pathname);
      if (pathname === "/assets/notebook-route-assets.json") {
        return jsonResponse({
          modulepreload: [
            "notebook-route.0123456789abcdef.js",
            "MarkdownText.0123456789abcdef.js",
            "markdown.0123456789abcdef.js",
          ],
          stylepreload: ["notebook-route.0123456789abcdef.css"],
        });
      }
      return new Response("not found", { status: 404 });
    },
  };
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
  session?: {
    provider: string;
    expires_at: number;
    cache_key: string;
  };
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
    session?: {
      provider: string;
      expires_at: number;
      cache_key: string;
    };
  };
}

function notebookViewerConfig(html: string): {
  featureFlags?: {
    enable_comments?: boolean;
  };
  initialCatalogAccess?: {
    scope: string;
    title?: string | null;
  } | null;
  session?: {
    provider: string;
    expires_at: number;
    cache_key: string;
  } | null;
} {
  const match = html.match(
    /<script id="nteract-cloud-viewer-config" type="application\/json">([^<]+)<\/script>/,
  );
  assert.ok(match?.[1], "expected notebook viewer config script");
  return JSON.parse(match[1]) as {
    featureFlags?: {
      enable_comments?: boolean;
    };
    initialCatalogAccess?: {
      scope: string;
      title?: string | null;
    } | null;
    session?: {
      provider: string;
      expires_at: number;
      cache_key: string;
    } | null;
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
  cell_composition: string | null;
  preview_cells: string | null;
  cover_blob_hash?: string | null;
  cover_mime?: string | null;
  language: string | null;
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
  comments_heads_hash: string | null;
  snapshot_key: string;
  runtime_snapshot_key: string | null;
  comms_snapshot_key: string | null;
  comments_snapshot_key: string | null;
  cover_blob_hash: string | null;
  cover_mime: string | null;
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
  trigger: "user_attach" | "resume";
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
  readonly workstationPairingCodes = new Map<string, WorkstationPairingCodeRow>();
  readonly workstationCredentials = new Map<string, WorkstationCredentialRow>();
  readonly batchSizes: number[] = [];
  readonly tableColumns = new Map<string, Set<string>>([
    [
      "notebooks",
      new Set([
        "id",
        "owner_principal",
        "title",
        "created_at",
        "updated_at",
        "latest_revision_id",
        "cell_composition",
        "preview_cells",
        "language",
      ]),
    ],
    [
      "notebook_revisions",
      new Set([
        "id",
        "notebook_id",
        "runtime_state_doc_id",
        "notebook_heads_hash",
        "runtime_heads_hash",
        "comms_heads_hash",
        "comments_heads_hash",
        "snapshot_key",
        "runtime_snapshot_key",
        "comms_snapshot_key",
        "comments_snapshot_key",
        "cover_blob_hash",
        "cover_mime",
        "actor_label",
        "created_at",
      ]),
    ],
    [
      "workstation_attach_jobs",
      new Set([
        "id",
        "notebook_id",
        "owner_principal",
        "workstation_id",
        "status",
        "trigger",
        "requested_by_actor_label",
        "requested_at",
        "updated_at",
        "accepted_at",
        "finished_at",
        "error_message",
      ]),
    ],
  ]);
  afterBlockedOwnerDelete?: () => void;
  failNotebookCoverUpdate = false;
  failNotebookSummaryUpdate = false;

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return okResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batchSizes.push(statements.length);
    const attachJobsBefore = cloneWorkstationAttachJobs(this.workstationAttachJobs);
    const results: D1Result<T>[] = [];
    try {
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
    } catch (error) {
      this.workstationAttachJobs.clear();
      for (const [id, job] of attachJobsBefore) {
        this.workstationAttachJobs.set(id, job);
      }
      throw error;
    }
    return results;
  }
}

interface FakeWorkstationEventsRequest {
  objectName: string;
  url: string;
  method: string;
  body: unknown;
  upgrade: string | null;
}

class FakeWorkstationEventsNamespace implements DurableObjectNamespace {
  readonly requests: FakeWorkstationEventsRequest[] = [];
  readonly connectedObjectNames: Set<string>;

  constructor({
    connectedObjectNames = [],
  }: {
    connectedObjectNames?: readonly string[];
  } = {}) {
    this.connectedObjectNames = new Set(connectedObjectNames);
  }

  idFromName(name: string): { toString(): string } {
    return { toString: () => name };
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        let body: unknown = null;
        if (request.method !== "GET") {
          body = await request.json().catch(() => null);
        }
        requests.push({
          objectName,
          url: request.url,
          method: request.method,
          body,
          upgrade: request.headers.get("Upgrade"),
        });
        const pathname = new URL(request.url).pathname;
        if (pathname === "/stream") {
          return new Response("websocket accepted", {
            headers: { "x-fake-websocket-upgrade": "1" },
          });
        }
        if (pathname === "/notify") {
          return Response.json({ ok: true, delivered: 1 });
        }
        if (pathname === "/status") {
          const connected = this.connectedObjectNames.has(objectName);
          return Response.json({
            ok: true,
            connected,
            connections: connected ? 1 : 0,
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    };
  }
}

interface FakeOwnerComputeIndexRequest {
  notebookIds: string[];
  objectName: string;
  pathname: string;
  workstationId: string | null;
}

class FakeOwnerComputeIndexNamespace implements DurableObjectNamespace {
  readonly requests: FakeOwnerComputeIndexRequest[] = [];
  readonly leases = new Map<string, WorkstationLeaseRecord>();
  readonly sessions = new Map<string, NotebookComputeSessionSummary>();

  idFromName(name: string): { toString(): string } {
    return { toString: () => name };
  }

  get(id: { toString(): string }) {
    const requests = this.requests;
    const sessions = this.sessions;
    const objectName = id.toString();
    return {
      fetch: async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/lease/list") {
          requests.push({ objectName, notebookIds: [], pathname, workstationId: null });
          return Response.json({ ok: true, leases: Array.from(this.leases.values()) });
        }
        if (pathname === "/lease/delete") {
          const payload = (await request.json().catch(() => ({}))) as {
            owner_principal?: string;
            workstation_id?: string;
          };
          const workstationId =
            typeof payload.workstation_id === "string" ? payload.workstation_id : null;
          requests.push({ objectName, notebookIds: [], pathname, workstationId });
          const lease = workstationId ? this.leases.get(workstationId) : undefined;
          if (!workstationId || !lease || lease.owner_principal !== payload.owner_principal) {
            return Response.json({
              ok: true,
              deleted: false,
              went_offline: false,
              reason: null,
            });
          }
          this.leases.delete(workstationId);
          return Response.json({
            ok: true,
            deleted: true,
            went_offline: lease.online,
            reason: lease.offline_reason,
          });
        }
        if (pathname !== "/list") {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        const payload = (await request.json().catch(() => ({}))) as {
          notebook_ids?: string[];
        };
        const notebookIds = Array.isArray(payload.notebook_ids) ? payload.notebook_ids : [];
        requests.push({ objectName, notebookIds, pathname, workstationId: null });
        return Response.json({
          ok: true,
          sessions: notebookIds.map((notebookId) => sessions.get(notebookId)).filter(Boolean),
        });
      },
    };
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
    const alterMatch = this.query.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
    if (alterMatch) {
      const [, table, column] = alterMatch;
      if (table && column) {
        const columns = this.db.tableColumns.get(table) ?? new Set<string>();
        columns.add(column);
        this.db.tableColumns.set(table, columns);
      }
    } else if (this.query.includes("INSERT OR IGNORE INTO notebook_acl")) {
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
    } else if (this.query.includes("DELETE FROM workstation_defaults")) {
      const [ownerPrincipal, workstationId] = this.values as [string, string];
      if (this.db.workstationDefaults.get(ownerPrincipal) === workstationId) {
        this.db.workstationDefaults.delete(ownerPrincipal);
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (this.query.includes("DELETE FROM workstations")) {
      const [ownerPrincipal, workstationId] = this.values as [string, string];
      const deleted = this.db.workstations.delete(workstationKey(ownerPrincipal, workstationId));
      return okResult(undefined, { changes: deleted ? 1 : 0 });
    } else if (this.query.includes("INSERT INTO workstation_attach_jobs")) {
      const hasTriggerColumn = /\btrigger\b/i.test(this.query);
      const [id, notebookId, ownerPrincipal, workstationId] = this.values as [
        string,
        string,
        string,
        string,
      ];
      const trigger = hasTriggerColumn
        ? (this.values[4] as WorkstationAttachJobRow["trigger"])
        : "user_attach";
      const actorLabel = String(this.values[hasTriggerColumn ? 5 : 4]);
      const requestedAt = String(this.values[hasTriggerColumn ? 6 : 5]);
      const updatedAt = String(this.values[hasTriggerColumn ? 7 : 6]);
      const duplicate = [...this.db.workstationAttachJobs.values()].find(
        (job) =>
          job.notebook_id === notebookId &&
          job.owner_principal === ownerPrincipal &&
          isActiveWorkstationAttachJobStatus(job.status),
      );
      if (duplicate) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: workstation_attach_jobs.notebook_id, workstation_attach_jobs.owner_principal",
        );
      }
      this.db.workstationAttachJobs.set(id, {
        id,
        notebook_id: notebookId,
        owner_principal: ownerPrincipal,
        workstation_id: workstationId,
        status: "pending",
        trigger,
        requested_by_actor_label: actorLabel,
        requested_at: requestedAt,
        updated_at: updatedAt,
        accepted_at: null,
        finished_at: null,
        error_message: null,
      });
      return okResult(undefined, { changes: 1 });
    } else if (
      this.query.includes("UPDATE workstation_attach_jobs") &&
      this.query.includes("stale workstation attach job expired after heartbeat timeout")
    ) {
      const [
        updatedAt,
        finishedAt,
        notebookId,
        notebookIdRepeat,
        ownerPrincipal,
        workstationId,
        workstationIdRepeat,
        staleBefore,
      ] = this.values as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
      ];
      let changes = 0;
      for (const job of this.db.workstationAttachJobs.values()) {
        if (
          (notebookId === null || job.notebook_id === notebookIdRepeat) &&
          job.owner_principal === ownerPrincipal &&
          (workstationId === null || job.workstation_id === workstationIdRepeat) &&
          (job.status === "accepted" || job.status === "running") &&
          job.updated_at < staleBefore
        ) {
          job.status = "failed";
          job.updated_at = updatedAt;
          job.finished_at = finishedAt;
          job.error_message = "stale workstation attach job expired after heartbeat timeout";
          changes += 1;
        }
      }
      return okResult(undefined, { changes });
    } else if (
      this.query.includes("UPDATE workstation_attach_jobs") &&
      this.query.includes("SET trigger = 'user_attach'")
    ) {
      const [updatedAt, jobId, ownerPrincipal, workstationId] = this.values as [
        string,
        string,
        string,
        string,
      ];
      const job = this.db.workstationAttachJobs.get(jobId);
      if (
        job &&
        job.owner_principal === ownerPrincipal &&
        job.workstation_id === workstationId &&
        job.trigger === "resume" &&
        isActiveWorkstationAttachJobStatus(job.status)
      ) {
        job.trigger = "user_attach";
        job.updated_at = updatedAt;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (
      this.query.includes("UPDATE workstation_attach_jobs") &&
      this.query.includes("SET status = 'cancelled'")
    ) {
      const [updatedAt, finishedAt, errorMessage, notebookId, ownerPrincipal] = this.values as [
        string,
        string,
        string,
        string,
        string,
      ];
      let changes = 0;
      for (const job of this.db.workstationAttachJobs.values()) {
        if (
          job.notebook_id === notebookId &&
          job.owner_principal === ownerPrincipal &&
          (job.status === "pending" || job.status === "accepted" || job.status === "running")
        ) {
          job.status = "cancelled";
          job.updated_at = updatedAt;
          job.finished_at = finishedAt;
          job.error_message = errorMessage;
          changes += 1;
        }
      }
      return okResult(undefined, { changes });
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
        if (
          this.query.includes("status IN ('pending', 'accepted', 'running')") &&
          job.status !== "pending" &&
          job.status !== "accepted" &&
          job.status !== "running"
        ) {
          return okResult(undefined, { changes: 0 });
        }
        if (
          this.query.includes("CASE status") &&
          workstationAttachJobStatusRank(job.status) > workstationAttachJobStatusRank(status)
        ) {
          return okResult(undefined, { changes: 0 });
        }
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
    } else if (this.query.includes("INSERT INTO workstation_pairing_codes")) {
      const [id, codeHash, ownerPrincipal, principalNamespace, actorLabel, createdAt, expiresAt] =
        this.values as [string, string, string, string, string, string, string];
      this.db.workstationPairingCodes.set(id, {
        id,
        code_hash: codeHash,
        owner_principal: ownerPrincipal,
        principal_namespace: principalNamespace,
        created_by_actor_label: actorLabel,
        created_at: createdAt,
        expires_at: expiresAt,
        redeemed_at: null,
        redeemed_by_credential_id: null,
        workstation_id: null,
      });
      return okResult(undefined, { changes: 1 });
    } else if (
      this.query.includes("UPDATE workstation_pairing_codes") &&
      this.query.includes("SET redeemed_at")
    ) {
      // Batched consume: enforce single-use and expiry exactly like the
      // RETURNING UPDATE in redeemWorkstationPairingCode, and stamp the
      // per-request credential marker the companion INSERT...SELECT joins on.
      const [redeemedAt, credentialMarker, codeHash, now] = this.values as [
        string,
        string,
        string,
        string,
      ];
      for (const pairing of this.db.workstationPairingCodes.values()) {
        if (
          pairing.code_hash === codeHash &&
          pairing.redeemed_at === null &&
          pairing.expires_at > now
        ) {
          pairing.redeemed_at = redeemedAt;
          pairing.redeemed_by_credential_id = credentialMarker;
          return okResult(
            [
              {
                id: pairing.id,
                owner_principal: pairing.owner_principal,
                principal_namespace: pairing.principal_namespace,
              },
            ] as T[],
            { changes: 1 },
          );
        }
      }
      return okResult([] as T[], { changes: 0 });
    } else if (
      this.query.includes("UPDATE workstation_pairing_codes") &&
      this.query.includes("SET workstation_id")
    ) {
      // linkWorkstationToPairing: first registration wins.
      const [workstationId, pairingId] = this.values as [string, string];
      const pairing = this.db.workstationPairingCodes.get(pairingId);
      if (pairing && pairing.workstation_id === null) {
        pairing.workstation_id = workstationId;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (this.query.includes("INSERT INTO workstation_credentials")) {
      // INSERT...SELECT joined on the per-request marker: mints only when
      // this request's UPDATE consumed the code.
      const [id, tokenHash, createdAt, credentialMarker] = this.values as [
        string,
        string,
        string,
        string,
      ];
      const pairing = [...this.db.workstationPairingCodes.values()].find(
        (row) => row.redeemed_by_credential_id === credentialMarker,
      );
      if (!pairing) {
        return okResult(undefined, { changes: 0 });
      }
      this.db.workstationCredentials.set(id, {
        id,
        token_hash: tokenHash,
        owner_principal: pairing.owner_principal,
        principal_namespace: pairing.principal_namespace,
        pairing_code_id: pairing.id,
        created_at: createdAt,
        last_used_at: null,
        revoked_at: null,
      });
      return okResult(undefined, { changes: 1 });
    } else if (
      this.query.includes("UPDATE workstation_credentials") &&
      this.query.includes("SET revoked_at")
    ) {
      const [revokedAt, credentialId, ownerPrincipal] = this.values as [string, string, string];
      const credential = this.db.workstationCredentials.get(credentialId);
      if (
        credential &&
        credential.owner_principal === ownerPrincipal &&
        credential.revoked_at === null
      ) {
        credential.revoked_at = revokedAt;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (
      this.query.includes("UPDATE workstation_credentials") &&
      this.query.includes("SET last_used_at")
    ) {
      const [lastUsedAt, credentialId] = this.values as [string, string];
      const credential = this.db.workstationCredentials.get(credentialId);
      if (credential) {
        credential.last_used_at = lastUsedAt;
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
        cell_composition: existing?.cell_composition ?? null,
        preview_cells: existing?.preview_cells ?? null,
        language: existing?.language ?? null,
      });
      return okResult(undefined, { changes: 1 });
    } else if (this.query.includes("UPDATE notebooks") && this.query.includes("cell_composition")) {
      if (this.db.failNotebookSummaryUpdate) {
        throw new Error("fake summary update failure");
      }
      const [cellComposition, previewCells, language, notebookId] = this.values as [
        string | null,
        string | null,
        string | null,
        string,
      ];
      const existing = this.db.notebooks.get(notebookId);
      if (existing) {
        existing.cell_composition = cellComposition;
        existing.preview_cells = previewCells;
        existing.language = language;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
    } else if (this.query.includes("INSERT INTO notebook_revisions")) {
      const [
        id,
        notebookId,
        runtimeStateDocId,
        notebookHeadsHash,
        runtimeHeadsHash,
        commsHeadsHash,
        commentsHeadsHash,
        snapshotKey,
        runtimeSnapshotKey,
        commsSnapshotKey,
        commentsSnapshotKey,
        actorLabel,
      ] = this.values as [
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
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
        comments_heads_hash: commentsHeadsHash,
        snapshot_key: snapshotKey,
        runtime_snapshot_key: runtimeSnapshotKey,
        comms_snapshot_key: commsSnapshotKey,
        comments_snapshot_key: commentsSnapshotKey,
        cover_blob_hash: null,
        cover_mime: null,
        actor_label: actorLabel,
        created_at: new Date().toISOString(),
      });
    } else if (
      this.query.includes("UPDATE notebook_revisions") &&
      this.query.includes("cover_blob_hash")
    ) {
      if (this.db.failNotebookCoverUpdate) {
        throw new Error("fake cover update failure");
      }
      const [coverBlobHash, coverMime, revisionId] = this.values as [string, string, string];
      const revision = this.db.revisions.find((row) => row.id === revisionId);
      if (revision) {
        revision.cover_blob_hash = coverBlobHash;
        revision.cover_mime = coverMime;
        return okResult(undefined, { changes: 1 });
      }
      return okResult(undefined, { changes: 0 });
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
      // Mirrors the real ON CONFLICT DO NOTHING: first writer wins.
      if (!this.db.blobs.has(`${notebookId}:${hash}`)) {
        this.db.blobs.set(`${notebookId}:${hash}`, {
          notebook_id: notebookId,
          hash,
          size,
          content_type: contentType,
          r2_key: r2Key,
          uploaded_at: new Date().toISOString(),
        });
      }
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
    if (
      this.query.includes("COUNT(*) AS total_count") &&
      this.query.includes("FROM notebooks n") &&
      this.query.includes("JOIN notebook_acl a")
    ) {
      const [principal, linkedPrincipal] = this.values as [string, string];
      const linked = this.db.accountLinks.get(linkedPrincipal)?.canonical_principal;
      const subjects = new Set([principal, ...(linked ? [linked] : [])]);
      const notebookIds = new Set<string>();
      for (const row of this.db.acl) {
        if (row.subject_kind !== "principal" || !subjects.has(row.subject)) {
          continue;
        }
        if (this.db.notebooks.has(row.notebook_id)) {
          notebookIds.add(row.notebook_id);
        }
      }
      return { total_count: notebookIds.size } as T;
    }
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
    if (this.query.includes("FROM workstation_pairing_codes")) {
      const [pairingId, ownerPrincipal] = this.values as [string, string];
      const pairing = this.db.workstationPairingCodes.get(pairingId);
      return pairing?.owner_principal === ownerPrincipal ? (pairing as T) : null;
    }
    if (this.query.includes("FROM workstation_credentials")) {
      const [tokenHash] = this.values as [string];
      return (
        ([...this.db.workstationCredentials.values()].find(
          (credential) => credential.token_hash === tokenHash,
        ) as T | undefined) ?? null
      );
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
        const [notebookId, ownerPrincipal, pendingStaleBefore, staleBefore] = this.values as [
          string,
          string,
          string,
          string,
        ];
        return (
          ([...this.db.workstationAttachJobs.values()]
            .filter(
              (job) =>
                job.notebook_id === notebookId &&
                job.owner_principal === ownerPrincipal &&
                isActiveWorkstationAttachJob(job, { pendingStaleBefore, staleBefore }),
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
    if (this.query.includes("FROM notebook_revisions")) {
      const [notebookId, revisionId] = this.values as [string, string];
      return (
        (this.db.revisions.find(
          (revision) => revision.notebook_id === notebookId && revision.id === revisionId,
        ) as T | undefined) ?? null
      );
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
    const pragmaMatch = this.query.match(/PRAGMA table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const columns = this.db.tableColumns.get(pragmaMatch[1] ?? "") ?? new Set<string>();
      return okResult([...columns].map((name) => ({ name })) as T[]);
    }
    if (
      this.query.includes("UPDATE workstation_attach_jobs") &&
      this.query.includes("stale workstation attach job expired before host accepted the request")
    ) {
      const [
        updatedAt,
        finishedAt,
        notebookId,
        notebookIdRepeat,
        ownerPrincipal,
        workstationId,
        workstationIdRepeat,
        pendingStaleBefore,
      ] = this.values as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
      ];
      const expired: WorkstationAttachJobRow[] = [];
      for (const job of this.db.workstationAttachJobs.values()) {
        if (
          (notebookId === null || job.notebook_id === notebookIdRepeat) &&
          job.owner_principal === ownerPrincipal &&
          (workstationId === null || job.workstation_id === workstationIdRepeat) &&
          job.status === "pending" &&
          job.requested_at < pendingStaleBefore
        ) {
          job.status = "failed";
          job.updated_at = updatedAt;
          job.finished_at = finishedAt;
          job.error_message =
            "stale workstation attach job expired before host accepted the request";
          expired.push({ ...job });
        }
      }
      return okResult(expired as T[], { changes: expired.length });
    }
    if (
      this.query.includes("FROM workstation_credentials") &&
      this.query.includes("WHERE owner_principal")
    ) {
      const ownerPrincipal = this.values[0] as string;
      return okResult(
        [...this.db.workstationCredentials.values()]
          .filter((credential) => credential.owner_principal === ownerPrincipal)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .map((credential) => ({
            id: credential.id,
            pairing_code_id: credential.pairing_code_id,
            created_at: credential.created_at,
            last_used_at: credential.last_used_at,
            revoked_at: credential.revoked_at,
          })) as T[],
      );
    }
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
      const [ownerPrincipal, workstationId, pendingStaleBefore, staleBefore, limitValue] = this
        .values as [string, string, string, string, number];
      const limit = Number.isFinite(limitValue) ? limitValue : Number.POSITIVE_INFINITY;
      return okResult(
        [...this.db.workstationAttachJobs.values()]
          .filter(
            (job) =>
              job.owner_principal === ownerPrincipal &&
              job.workstation_id === workstationId &&
              isActiveWorkstationAttachJob(job, { pendingStaleBefore, staleBefore }),
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
          const revision = this.db.revisions.find(
            (candidate) => candidate.id === notebook.latest_revision_id,
          );
          byNotebook.set(notebook.id, {
            ...notebook,
            cover_blob_hash: revision?.cover_blob_hash ?? null,
            cover_mime: revision?.cover_mime ?? null,
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

class FailingGetR2Bucket extends FakeR2Bucket {
  failNextGet = false;

  override async get(key: string): Promise<R2ObjectBody | null> {
    this.getKeys.push(key);
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error("R2 unavailable");
    }
    return this.objects.get(key) ?? null;
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
