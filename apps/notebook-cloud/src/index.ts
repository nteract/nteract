import type { Env, ExecutionContext, ExportedHandler } from "./cloudflare-types.ts";
import { NotebookRoom } from "./notebook-room.ts";
import { allowsPublish, authenticateDevRequest, stampTrustedIdentity } from "./identity.ts";
import {
  blobKey,
  ensureCatalogSchema,
  ensureNotebook,
  getNotebookCatalog,
  listRoomEvents,
  recordBlob,
  recordRevision,
  snapshotKey,
} from "./storage.ts";

export { NotebookRoom };

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

    const syncMatch = url.pathname.match(/^\/n\/([^/]+)\/sync\/?$/);
    if (syncMatch) {
      return routeRoomSync(request, env);
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

  const identity = authenticateDevRequest(request);
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

  const identity = authenticateDevRequest(request);
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot publish snapshots` }, 403);
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
      notebook_heads_hash: headsHash,
    },
  });
  const revisionId = await recordRevision(env, {
    notebookId,
    notebookHeadsHash: headsHash,
    runtimeHeadsHash: request.headers.get("x-runtime-heads-hash"),
    snapshotKey: key,
    actorLabel: identity.actorLabel,
  });

  return json({ ok: true, revision_id: revisionId, key }, 201);
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

async function routeBlob(
  request: Request,
  env: Env,
  notebookId: string,
  hash: string,
): Promise<Response> {
  const key = blobKey(notebookId, hash);

  if (request.method === "HEAD") {
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

  const identity = authenticateDevRequest(request);
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
    "Content-Type, X-User, X-Principal, X-Operator, X-Scope, X-Runtime-Heads-Hash",
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

function viewer(notebookId: string): Response {
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
    main { max-width: 920px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 20px; }
    dt { color: color-mix(in srgb, CanvasText 65%, transparent); }
    dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    button { font: inherit; padding: 8px 12px; }
    pre { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 12px; min-height: 240px; overflow: auto; }
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
    <button id="presence" type="button">Send presence frame</button>
    <pre id="log"></pre>
  </main>
  <script type="module">
    const notebookId = ${scriptJsonForHtml(notebookId)};
    const frameType = { presence: 0x04, sessionControl: 0x07 };
    const log = document.querySelector("#log");
    const status = document.querySelector("#status");
    const urlCell = document.querySelector("#url");
    const base = new URL(location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/n/" + encodeURIComponent(notebookId) + "/sync";
    base.search = "?user=viewer&operator=desktop:browser&scope=viewer";
    urlCell.textContent = base.href;
    const socket = new WebSocket(base);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => { status.textContent = "open"; });
    socket.addEventListener("close", () => { status.textContent = "closed"; });
    socket.addEventListener("message", async (event) => {
      const bytes = new Uint8Array(event.data);
      const payload = new TextDecoder().decode(bytes.slice(1));
      log.textContent += "[" + bytes[0] + "] " + payload + "\\n";
    });
    document.querySelector("#presence").addEventListener("click", () => {
      const payload = new TextEncoder().encode(JSON.stringify({ peer_label: "browser viewer", actor_label: "desktop:browser" }));
      const frame = new Uint8Array(payload.byteLength + 1);
      frame[0] = frameType.presence;
      frame.set(payload, 1);
      socket.send(frame);
    });
  </script>
</body>
</html>`;

  return withCors(
    new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function scriptJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
