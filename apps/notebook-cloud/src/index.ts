import type { Env, ExecutionContext, ExportedHandler } from "./cloudflare-types.ts";
import { NotebookRoom } from "./notebook-room.ts";
import {
  AuthError,
  allowsPublish,
  authenticateRequest,
  DEV_AUTH_TOKEN_HEADER,
  stampTrustedIdentity,
  type AuthenticatedConnection,
} from "./identity.ts";
import {
  blobKey,
  ensureCatalogSchema,
  ensureNotebook,
  getNotebookCatalog,
  listRoomEvents,
  recordBlob,
  recordRevision,
  renderKey,
  runtimeSnapshotKey,
  snapshotKey,
  type RevisionRow,
} from "./storage.ts";
import { materializeSnapshotPairRender } from "./snapshot-render.ts";
import { createNotebookCloudBlobResolver } from "./blob-resolver.ts";

export { NotebookRoom };

const DEMO_NOTEBOOK_ID = "nteract-cloud-demo";

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      await safeEnsureCatalogSchema(env, ctx);
      return json({
        status: "ok",
        service: "nteract-notebook-cloud",
        deployment_env: env.DEPLOYMENT_ENV ?? "development",
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return withCors(
        new Response(null, {
          status: 302,
          headers: {
            Location: new URL(`/n/${encodeURIComponent(DEMO_NOTEBOOK_ID)}`, request.url).href,
          },
        }),
      );
    }

    const syncMatch = url.pathname.match(/^\/n\/([^/]+)\/sync\/?$/);
    if (syncMatch) {
      return routeRoomSync(request, env);
    }

    const debugMatch = url.pathname.match(/^\/n\/([^/]+)\/debug\/?$/);
    if (debugMatch && request.method === "GET") {
      return debugViewer(decodeURIComponent(debugMatch[1]));
    }

    const pinnedViewerMatch = url.pathname.match(/^\/n\/([^/]+)\/r\/([^/]+)\/?$/);
    if (pinnedViewerMatch && request.method === "GET") {
      return viewer(
        decodeURIComponent(pinnedViewerMatch[1]),
        decodeURIComponent(pinnedViewerMatch[2]),
      );
    }

    const viewerMatch = url.pathname.match(/^\/n\/([^/]+)\/?$/);
    if (viewerMatch && request.method === "GET") {
      return viewer(decodeURIComponent(viewerMatch[1]));
    }

    const catalogMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/?$/);
    if (catalogMatch && request.method === "GET") {
      return routeCatalog(env, decodeURIComponent(catalogMatch[1]));
    }

    const eventsMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/events$/);
    if (eventsMatch && request.method === "GET") {
      return routeRoomEvents(request, env, decodeURIComponent(eventsMatch[1]));
    }

    const latestRenderMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/render$/);
    if (latestRenderMatch && request.method === "GET") {
      return routeLatestRender(request, env, decodeURIComponent(latestRenderMatch[1]));
    }

    const renderMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/renders\/([^/]+)$/);
    if (renderMatch) {
      return routeRender(
        request,
        env,
        decodeURIComponent(renderMatch[1]),
        decodeURIComponent(renderMatch[2]),
      );
    }

    const runtimeSnapshotMatch = url.pathname.match(
      /^\/api\/n\/([^/]+)\/runtime-snapshots\/([^/]+)$/,
    );
    if (runtimeSnapshotMatch) {
      return routeRuntimeSnapshot(
        request,
        env,
        decodeURIComponent(runtimeSnapshotMatch[1]),
        decodeURIComponent(runtimeSnapshotMatch[2]),
      );
    }

    const snapshotMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/snapshots\/([^/]+)$/);
    if (snapshotMatch) {
      return routeSnapshot(
        request,
        env,
        decodeURIComponent(snapshotMatch[1]),
        decodeURIComponent(snapshotMatch[2]),
      );
    }

    const blobMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/blobs\/([^/]+)$/);
    if (blobMatch) {
      return routeBlob(
        request,
        env,
        decodeURIComponent(blobMatch[1]),
        decodeURIComponent(blobMatch[2]),
      );
    }

    return json({ error: "not found" }, 404);
  },
};

export default worker;

async function routeRoomSync(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected WebSocket upgrade" }, 426);
  }

  const identity = authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  const url = new URL(request.url);
  const notebookId = decodeURIComponent(url.pathname.match(/^\/n\/([^/]+)\/sync\/?$/)?.[1] ?? "");
  if (!notebookId) {
    return json({ error: "notebook id is required" }, 400);
  }

  const id = env.NOTEBOOK_ROOMS.idFromName(notebookId);
  const room = env.NOTEBOOK_ROOMS.get(id);
  return room.fetch(stampTrustedIdentity(request, identity));
}

async function routeSnapshot(
  request: Request,
  env: Env,
  notebookId: string,
  headsHash: string,
): Promise<Response> {
  const key = snapshotKey(notebookId, headsHash);

  if (request.method === "GET") {
    // Prototype publish reads are intentionally public. Production hosts should
    // gate this path with viewer-or-better auth or signed artifact URLs.
    const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
    if (!object) {
      return json({ error: "snapshot not found" }, 404);
    }

    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: object.httpEtag,
    });
    return withCors(new Response(object.body, { headers }));
  }

  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const identity = authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot publish snapshots` }, 403);
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  await ensureNotebook(env, notebookId, identity);
  const body = await request.arrayBuffer();
  const runtimeHeadsHash = normalizedRuntimeHeadsHash(request.headers.get("x-runtime-heads-hash"));
  const runtimeKey = runtimeHeadsHash ? runtimeSnapshotKey(notebookId, runtimeHeadsHash) : null;
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      notebook_heads_hash: headsHash,
    },
  });
  let revisionId: string;
  try {
    revisionId = await recordRevision(env, {
      notebookId,
      notebookHeadsHash: headsHash,
      runtimeHeadsHash,
      snapshotKey: key,
      runtimeSnapshotKey: runtimeKey,
      actorLabel: identity.actorLabel,
    });
  } catch (error) {
    await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
    throw error;
  }

  return json({ ok: true, revision_id: revisionId, key }, 201);
}

async function routeRuntimeSnapshot(
  request: Request,
  env: Env,
  notebookId: string,
  headsHash: string,
): Promise<Response> {
  const key = runtimeSnapshotKey(notebookId, headsHash);

  if (request.method === "GET") {
    const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
    if (!object) {
      return json({ error: "runtime snapshot not found" }, 404);
    }

    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: object.httpEtag,
    });
    return withCors(new Response(object.body, { headers }));
  }

  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const identity = authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot publish runtime snapshots` }, 403);
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  await ensureNotebook(env, notebookId, identity);
  const body = await request.arrayBuffer();
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      runtime_heads_hash: headsHash,
      artifact: "runtime-state-snapshot",
    },
  });

  return json({ ok: true, key, size: body.byteLength }, 201);
}

async function routeCatalog(env: Env, notebookId: string): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  const catalog = await getNotebookCatalog(env, notebookId);
  if (!catalog) {
    return json({ error: "notebook not found" }, 404);
  }

  return json(catalog);
}

async function routeRoomEvents(request: Request, env: Env, notebookId: string): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  return json({
    notebook_id: notebookId,
    events: await listRoomEvents(env, notebookId, limit),
  });
}

async function routeLatestRender(
  request: Request,
  env: Env,
  notebookId: string,
): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  const catalog = await getNotebookCatalog(env, notebookId);
  if (!catalog) {
    return json({ error: "notebook not found" }, 404);
  }

  const revision =
    catalog.revisions.find((candidate) => candidate.id === catalog.notebook.latest_revision_id) ??
    catalog.revisions[0];
  if (!revision) {
    return json({ error: "notebook has no published revisions" }, 404);
  }

  return getRenderObjectOrMaterialize(request, env, notebookId, revision, false);
}

async function routeRender(
  request: Request,
  env: Env,
  notebookId: string,
  headsHash: string,
): Promise<Response> {
  if (request.method === "GET") {
    if (!env.DB) {
      return getRenderObject(env, notebookId, headsHash, true);
    }
    const catalog = await getNotebookCatalog(env, notebookId);
    const revision = catalog?.revisions.find(
      (candidate) => candidate.notebook_heads_hash === headsHash,
    );
    return revision
      ? getRenderObjectOrMaterialize(request, env, notebookId, revision, true)
      : getRenderObject(env, notebookId, headsHash, true);
  }

  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const identity = authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot publish render caches` }, 403);
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  await ensureNotebook(env, notebookId, identity);
  const key = renderKey(notebookId, headsHash);
  const body = await request.text();
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/json; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      notebook_heads_hash: headsHash,
      artifact: "render-cache",
    },
  });

  return json({ ok: true, key, size: body.length }, 201);
}

async function getRenderObjectOrMaterialize(
  request: Request,
  env: Env,
  notebookId: string,
  revision: RevisionRow,
  immutable: boolean,
): Promise<Response> {
  const cached = await getRenderObject(env, notebookId, revision.notebook_heads_hash, immutable);
  if (cached.status !== 404) {
    return cached;
  }

  return materializeSnapshotRender(request, env, notebookId, revision, immutable);
}

async function getRenderObject(
  env: Env,
  notebookId: string,
  headsHash: string,
  immutable: boolean,
): Promise<Response> {
  const key = renderKey(notebookId, headsHash);
  const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
  if (!object) {
    return json({ error: "render cache not found" }, 404);
  }

  const headers = new Headers({
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=30, stale-while-revalidate=300",
    "Content-Type": object.httpMetadata?.contentType ?? "application/json; charset=utf-8",
    ETag: object.httpEtag,
  });
  return withCors(new Response(object.body, { headers }));
}

async function materializeSnapshotRender(
  request: Request,
  env: Env,
  notebookId: string,
  revision: RevisionRow,
  immutable: boolean,
): Promise<Response> {
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }
  if (!revision.runtime_snapshot_key) {
    return json({ error: "revision has no runtime-state snapshot" }, 404);
  }

  const [notebookObject, runtimeObject] = await Promise.all([
    env.NOTEBOOK_SNAPSHOTS.get(revision.snapshot_key),
    env.NOTEBOOK_SNAPSHOTS.get(revision.runtime_snapshot_key),
  ]);
  if (!notebookObject) {
    return json({ error: "notebook snapshot not found" }, 404);
  }
  if (!runtimeObject) {
    return json({ error: "runtime snapshot not found" }, 404);
  }

  const render = await materializeSnapshotPairRender({
    notebookId,
    notebookHeadsHash: revision.notebook_heads_hash,
    runtimeHeadsHash: revision.runtime_heads_hash,
    notebookBytes: new Uint8Array(await notebookObject.arrayBuffer()),
    runtimeStateBytes: new Uint8Array(await runtimeObject.arrayBuffer()),
    blobResolver: createNotebookCloudBlobResolver({
      baseUrl: request.url,
      notebookId,
    }),
  });
  const body = JSON.stringify(render);
  await env.NOTEBOOK_SNAPSHOTS.put(renderKey(notebookId, revision.notebook_heads_hash), body, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=30, stale-while-revalidate=300",
    },
    customMetadata: {
      notebook_id: notebookId,
      notebook_heads_hash: revision.notebook_heads_hash,
      runtime_heads_hash: revision.runtime_heads_hash ?? "",
      artifact: "materialized-render",
    },
  });
  return withCors(
    new Response(body, {
      headers: {
        "Cache-Control": immutable
          ? "public, max-age=31536000, immutable"
          : "public, max-age=30, stale-while-revalidate=300",
        "Content-Type": "application/json; charset=utf-8",
      },
    }),
  );
}

async function routeBlob(
  request: Request,
  env: Env,
  notebookId: string,
  hash: string,
): Promise<Response> {
  const key = blobKey(notebookId, hash);

  if (request.method === "HEAD") {
    // Prototype publish reads are intentionally public. Production hosts should
    // gate this path with viewer-or-better auth or signed artifact URLs.
    const object = await env.NOTEBOOK_SNAPSHOTS?.head(key);
    if (!object) {
      return json({ error: "blob not found" }, 404);
    }

    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": object.size.toString(),
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: object.httpEtag,
    });
    return withCors(new Response(null, { headers }));
  }

  if (request.method === "GET") {
    // Prototype publish reads are intentionally public. Production hosts should
    // gate this path with viewer-or-better auth or signed artifact URLs.
    const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
    if (!object) {
      return json({ error: "blob not found" }, 404);
    }

    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": object.size.toString(),
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: object.httpEtag,
    });
    return withCors(new Response(object.body, { headers }));
  }

  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const identity = authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot upload blobs` }, 403);
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  await ensureNotebook(env, notebookId, identity);
  const body = await request.arrayBuffer();
  const contentType = request.headers.get("content-type");
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: contentType ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      hash,
    },
  });
  await recordBlob(env, {
    notebookId,
    hash,
    size: body.byteLength,
    contentType,
    r2Key: key,
  });

  return json({ ok: true, key, size: body.byteLength }, 201);
}

async function safeEnsureCatalogSchema(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    ensureCatalogSchema(env).catch((error: unknown) => {
      console.warn("Unable to ensure D1 schema", error);
    }),
  );
}

function authenticateRequestOrResponse(
  request: Request,
  env: Env,
): AuthenticatedConnection | Response {
  try {
    return authenticateRequest(request, env);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: String(error) }, 400);
  }
}

function json(value: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    `Content-Type, X-User, X-Principal, X-Operator, X-Scope, X-Viewer-Session, X-Runtime-Heads-Hash, ${DEV_AUTH_TOKEN_HEADER}`,
  );
  return response;
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 25;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 25;
  }

  return Math.min(parsed, 100);
}

function normalizedRuntimeHeadsHash(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "none" ? trimmed : null;
}

function viewer(notebookId: string, headsHash?: string): Response {
  const escaped = escapeHtml(notebookId);
  const title = headsHash ? `${escaped} @ ${escapeHtml(headsHash)}` : escaped;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>nteract cloud notebook ${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    body { margin: 0; }
    main { width: min(960px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 48px; }
    header { display: flex; gap: 16px; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
    h1 { font-size: 24px; line-height: 1.2; margin: 0 0 8px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 16px; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 13px; }
    .meta code { color: CanvasText; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    a.button {
      color: CanvasText;
      border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 6px;
      padding: 7px 10px;
      text-decoration: none;
      font-size: 13px;
    }
    .state {
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 18px;
      color: color-mix(in srgb, CanvasText 72%, transparent);
      background: color-mix(in srgb, Canvas 94%, CanvasText 6%);
    }
    .state[data-kind="error"] {
      border-color: color-mix(in srgb, #b42318 50%, transparent);
      color: #b42318;
      background: color-mix(in srgb, #b42318 8%, Canvas);
    }
    .notebook { display: grid; gap: 14px; }
    .cell {
      border-left: 3px solid color-mix(in srgb, CanvasText 20%, transparent);
      padding: 8px 0 8px 16px;
    }
    .cell[data-type="code"] { border-left-color: #4f46e5; }
    .cell[data-type="markdown"] { border-left-color: #0f766e; }
    .cell-label {
      font-size: 12px;
      color: color-mix(in srgb, CanvasText 56%, transparent);
      margin-bottom: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .markdown { line-height: 1.55; }
    .markdown h2, .markdown h3, .markdown p, .markdown ul { margin: 0 0 10px; }
    .markdown h2 { font-size: 21px; }
    .markdown h3 { font-size: 17px; }
    pre {
      margin: 0;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 8px;
      padding: 12px;
      overflow: auto;
      background: color-mix(in srgb, Canvas 90%, CanvasText 10%);
    }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
    .outputs { margin-top: 8px; }
    @media (max-width: 640px) {
      main { width: min(100vw - 24px, 960px); padding-top: 20px; }
      header { display: block; }
      .links { justify-content: flex-start; margin-top: 12px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>nteract cloud notebook</h1>
        <div class="meta">
          <span>Notebook <code>${escaped}</code></span>
          <span id="revision"></span>
          <span id="connection">anonymous viewer connecting</span>
        </div>
      </div>
      <nav class="links" aria-label="Notebook links">
        <a class="button" href="/n/${encodeURIComponent(notebookId)}/debug">Debug</a>
        <a class="button" href="/api/n/${encodeURIComponent(notebookId)}">Catalog JSON</a>
      </nav>
    </header>
    <div id="state" class="state">Loading notebook snapshot...</div>
    <section id="notebook" class="notebook" aria-label="Notebook cells"></section>
  </main>
  <script type="module">
    const notebookId = ${scriptJsonForHtml(notebookId)};
    const pinnedHeadsHash = ${scriptJsonForHtml(headsHash ?? null)};
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const state = document.querySelector("#state");
    const notebook = document.querySelector("#notebook");
    const revision = document.querySelector("#revision");
    const connection = document.querySelector("#connection");
    const renderEndpoint = pinnedHeadsHash
      ? "/api/n/" + encodeURIComponent(notebookId) + "/renders/" + encodeURIComponent(pinnedHeadsHash)
      : "/api/n/" + encodeURIComponent(notebookId) + "/render";

    connectAnonymousViewer();
    loadNotebook();

    async function loadNotebook() {
      try {
        const response = await fetch(renderEndpoint, { headers: { Accept: "application/json" } });
        if (!response.ok) {
          showState(response.status === 404
            ? "No published snapshot is available for this notebook yet."
            : "Unable to load notebook render: " + response.status,
            response.status === 404 ? "empty" : "error");
          return;
        }
        const render = await response.json();
        renderNotebook(render);
      } catch (error) {
        showState("Unable to load notebook: " + String(error), "error");
      }
    }

    function renderNotebook(render) {
      const cells = Array.isArray(render.cells) ? render.cells : [];
      revision.textContent = render.heads_hash ? "Revision " + render.heads_hash : "";
      notebook.replaceChildren();
      if (cells.length === 0) {
        showState("This published notebook has no cells.", "empty");
        return;
      }
      const source = render.source === "snapshot-pair" ? "snapshot pair" : "render cache";
      showState("Rendered " + cells.length + " cells from a persisted " + source + ".", "ready");
      for (const cell of cells) {
        notebook.append(renderCell(cell));
      }
    }

    function renderCell(cell) {
      const type = typeof cell.cell_type === "string" ? cell.cell_type : "code";
      const id = typeof cell.id === "string" ? cell.id : "cell";
      const source = typeof cell.source === "string" ? cell.source : "";
      const section = document.createElement("article");
      section.className = "cell";
      section.dataset.type = type;

      const label = document.createElement("div");
      label.className = "cell-label";
      label.textContent = type + " - " + id;
      section.append(label);

      if (type === "markdown") {
        const markdown = document.createElement("div");
        markdown.className = "markdown";
        renderMarkdown(markdown, source);
        section.append(markdown);
      } else {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = source;
        pre.append(code);
        section.append(pre);
      }

      if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
        const outputs = document.createElement("pre");
        outputs.className = "outputs";
        outputs.textContent = JSON.stringify(cell.outputs, null, 2);
        section.append(outputs);
      }

      return section;
    }

    function renderMarkdown(container, source) {
      const lines = source.split(/\\r?\\n/);
      let list;
      for (const line of lines) {
        if (line.startsWith("## ")) {
          list = undefined;
          appendText(container, "h3", line.slice(3));
        } else if (line.startsWith("# ")) {
          list = undefined;
          appendText(container, "h2", line.slice(2));
        } else if (line.startsWith("- ")) {
          if (!list) {
            list = document.createElement("ul");
            container.append(list);
          }
          appendText(list, "li", line.slice(2));
        } else if (line.trim() === "") {
          list = undefined;
        } else {
          list = undefined;
          appendText(container, "p", line);
        }
      }
    }

    function appendText(parent, tagName, text) {
      const element = document.createElement(tagName);
      element.textContent = text;
      parent.append(element);
    }

    function connectAnonymousViewer() {
      const url = new URL("/n/" + encodeURIComponent(notebookId) + "/sync", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("viewer_session", sessionId);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        connection.textContent = "anonymous viewer connected";
      });
      socket.addEventListener("close", () => {
        connection.textContent = "anonymous viewer disconnected";
      });
      socket.addEventListener("message", async (event) => {
        const bytes = new Uint8Array(event.data);
        if (bytes[0] !== 0x07) {
          return;
        }
        const message = JSON.parse(new TextDecoder().decode(bytes.slice(1)));
        if (message.type === "cloud_room_ready") {
          connection.textContent = message.actor_label + " (" + message.connection_scope + ")";
        }
      });
    }

    function showState(message, kind) {
      state.textContent = message;
      state.dataset.kind = kind;
    }
  </script>
</body>
</html>`;

  return withCors(
    new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}

function debugViewer(notebookId: string): Response {
  const escaped = escapeHtml(notebookId);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>nteract cloud room ${escaped}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 20px; }
    dt { color: color-mix(in srgb, CanvasText 65%, transparent); }
    dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    button { font: inherit; padding: 8px 12px; }
    section { margin-top: 18px; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    pre { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 12px; min-height: 220px; overflow: auto; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>nteract cloud room</h1>
    <dl>
      <dt>Notebook</dt><dd>${escaped}</dd>
      <dt>WebSocket</dt><dd id="url"></dd>
      <dt>Status</dt><dd id="status">connecting</dd>
    </dl>
    <div class="actions">
      <button id="presence" type="button">Send presence frame</button>
      <button id="refresh" type="button">Refresh catalog</button>
    </div>
    <div class="grid">
      <section>
        <h2>Frames</h2>
        <pre id="log"></pre>
      </section>
      <section>
        <h2>Catalog</h2>
        <pre id="catalog"></pre>
      </section>
      <section>
        <h2>Events</h2>
        <pre id="events"></pre>
      </section>
    </div>
  </main>
  <script type="module">
    const notebookId = ${scriptJsonForHtml(notebookId)};
    const frameType = { presence: 0x04, sessionControl: 0x07 };
    const log = document.querySelector("#log");
    const catalog = document.querySelector("#catalog");
    const events = document.querySelector("#events");
    const status = document.querySelector("#status");
    const urlCell = document.querySelector("#url");
    const base = new URL(location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/n/" + encodeURIComponent(notebookId) + "/sync";
    base.search = "?viewer_session=debug-browser";
    urlCell.textContent = base.href;
    const socket = new WebSocket(base);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => { status.textContent = "open"; });
    socket.addEventListener("close", () => { status.textContent = "closed"; });
    socket.addEventListener("message", async (event) => {
      const bytes = new Uint8Array(event.data);
      const payload = new TextDecoder().decode(bytes.slice(1));
      log.textContent += "[" + bytes[0] + "] " + payload + "\\n";
      if (bytes[0] === frameType.sessionControl) refreshCatalog();
    });
    document.querySelector("#presence").addEventListener("click", () => {
      const payload = new TextEncoder().encode(JSON.stringify({ peer_label: "browser viewer", actor_label: "desktop:browser" }));
      const frame = new Uint8Array(payload.byteLength + 1);
      frame[0] = frameType.presence;
      frame.set(payload, 1);
      socket.send(frame);
    });
    document.querySelector("#refresh").addEventListener("click", refreshCatalog);
    async function refreshCatalog() {
      const [catalogResponse, eventsResponse] = await Promise.all([
        fetch("/api/n/" + encodeURIComponent(notebookId)),
        fetch("/api/n/" + encodeURIComponent(notebookId) + "/events?limit=10"),
      ]);
      catalog.textContent = catalogResponse.ok
        ? JSON.stringify(await catalogResponse.json(), null, 2)
        : "No catalog row yet";
      events.textContent = eventsResponse.ok
        ? JSON.stringify(await eventsResponse.json(), null, 2)
        : "No room events yet";
    }
    refreshCatalog();
  </script>
</body>
</html>`;

  return withCors(
    new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

export function scriptJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
