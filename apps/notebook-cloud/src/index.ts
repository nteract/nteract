import type { Env, ExecutionContext, ExportedHandler } from "./cloudflare-types.ts";
import type { BlobRef } from "runtimed";
import { NotebookRoom } from "./notebook-room.ts";
import {
  ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
  AuthError,
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  CLOUDFLARE_ACCESS_JWT_HEADER,
  allowsBlobUpload,
  allowsPublish,
  authenticateRequestWithProviders,
  DEV_AUTH_TOKEN_HEADER,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  parseScope,
  stampTrustedIdentity,
  type AuthenticatedConnection,
  type ConnectionScope,
  validatePrincipal,
} from "./identity.ts";
import {
  AuthorizationError,
  authorizeNotebookAccess,
  type AuthorizeNotebookAccessOptions,
} from "./authorization.ts";
import {
  blobKey,
  createNotebookWithOwnerAcl,
  ensureCatalogSchema,
  getNotebookAclRows,
  getNotebookRow,
  getNotebookCatalog,
  grantNotebookAclRow,
  recordBlob,
  recordRevision,
  renderKey,
  revokeNotebookAclRow,
  runtimeStateSnapshotKey,
  snapshotKey,
  type NotebookAclRow,
  type RevisionRow,
} from "./storage.ts";
import { materializeSnapshotPairRender } from "./snapshot-render.ts";
import {
  createNotebookCloudBlobResolver,
  notebookCloudBlobBasePath,
  withTrailingSlash,
} from "./blob-resolver.ts";
import { collectBlobRefs } from "./blob-refs.ts";
import { cloudLog, durationMs } from "./observability.ts";
import {
  createPendingNotebookInvite,
  getPrincipalProfiles,
  getPendingNotebookInvitesForLogin,
  listNotebookInvites,
  resolveNotebookInvitesForLogin,
  revokePendingNotebookInvite,
  type ListedPendingNotebookInviteRow,
  type PendingNotebookInviteRow,
  type PrincipalProfileRow,
} from "./sharing-storage.ts";
import {
  normalizeInviteEmail,
  normalizeProviderHint,
  shareTargetDisplay,
  type PrincipalProfile,
} from "./sharing.ts";
import {
  viewerThemeBootstrapScript,
  viewerThemeFirstPaintStyle,
} from "./viewer-theme-bootstrap.ts";

export { NotebookRoom };

// `/plugins/*` is a raw static asset path in deployed Workers. Use a
// Worker-owned route by default so sandboxed srcdoc iframes can fetch sidecar
// assets with explicit CORS, and let hosts replace it with a dedicated origin.
const DEFAULT_RENDERER_ASSETS_BASE_PATH = "/renderer-assets/";
const DEFAULT_RUNTIMED_WASM_BASE_PATH = "/assets/";
const VIEWER_RUNTIMED_WASM_MODULE_NAME = "runtimed_wasm.js";
const VIEWER_RUNTIMED_WASM_NAME = "runtimed_wasm_bg.wasm";
const RENDER_BLOB_HEAD_CONCURRENCY = 16;

interface MissingRenderBlob {
  hash: string;
  size: number | null;
  media_type: string | null;
}

type RenderMaterializationResult =
  | {
      ok: true;
      body: string;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const assetResponse = await routeAsset(request, env);
    if (assetResponse) {
      return assetResponse;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      await safeEnsureCatalogSchema(env, ctx);
      return json({
        status: "ok",
        service: "nteract-notebook-cloud",
        deployment_env: env.DEPLOYMENT_ENV ?? "development",
        auth: {
          anaconda_api_key: anacondaApiKeyHealth(env),
          cloudflare_access: cloudflareAccessHealth(env),
          oidc: oidcHealth(env),
        },
      });
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      return homeViewer(request, env);
    }

    if (url.pathname === "/oidc" && request.method === "GET") {
      return oidcCallbackViewer(request, env);
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
        request,
        env,
        decodeURIComponent(pinnedViewerMatch[2]),
      );
    }

    const viewerMatch = url.pathname.match(/^\/n\/([^/]+)\/?$/);
    if (viewerMatch && request.method === "GET") {
      return viewer(decodeURIComponent(viewerMatch[1]), request, env);
    }

    const vanityViewerMatch = url.pathname.match(/^\/n\/([^/]+)\/([^/]+)\/?$/);
    if (vanityViewerMatch && request.method === "GET") {
      return viewer(decodeURIComponent(vanityViewerMatch[1]), request, env);
    }

    const catalogMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/?$/);
    if (catalogMatch && request.method === "GET") {
      return routeCatalog(request, env, decodeURIComponent(catalogMatch[1]));
    }

    const aclMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/acl\/?$/);
    if (aclMatch) {
      return routeNotebookAcl(request, env, decodeURIComponent(aclMatch[1]));
    }

    const inviteMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/invites\/?$/);
    if (inviteMatch) {
      return routeNotebookInvites(request, env, decodeURIComponent(inviteMatch[1]));
    }

    const inviteItemMatch = url.pathname.match(/^\/api\/n\/([^/]+)\/invites\/([^/]+)\/?$/);
    if (inviteItemMatch) {
      return routeNotebookInvite(
        request,
        env,
        decodeURIComponent(inviteItemMatch[1]),
        decodeURIComponent(inviteItemMatch[2]),
      );
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

async function routeAsset(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const assetPathname = assetPathnameForRequest(url.pathname);
  if (!assetPathname) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!env.ASSETS) {
    return json({ error: "viewer assets are not configured" }, 503);
  }

  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPathname;
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  cloudLog(response.status >= 400 ? "warn" : "debug", "asset.fetch.completed", {
    asset_kind: assetKind(assetPathname),
    asset_pathname: assetPathname,
    request_pathname: url.pathname,
    status: response.status,
    counter: "asset_fetches",
    counter_delta: 1,
  });
  return withCors(new Response(response.body, response));
}

function assetPathnameForRequest(pathname: string): string | null {
  if (pathname.startsWith("/assets/")) {
    return pathname;
  }
  if (pathname.startsWith("/plugins/")) {
    return pluginAssetPathname(pathname.slice("/plugins/".length));
  }
  if (pathname.startsWith("/renderer-assets/")) {
    return pluginAssetPathname(pathname.slice("/renderer-assets/".length));
  }
  if (pathname.startsWith("/api/assets/")) {
    return pathname.slice("/api".length);
  }
  if (pathname.startsWith("/api/plugins/")) {
    return pluginAssetPathname(pathname.slice("/api/plugins/".length));
  }
  return null;
}

function pluginAssetPathname(rawName: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }

  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    return null;
  }

  return `/plugins/${name}`;
}

function assetKind(pathname: string): string {
  if (pathname.startsWith("/plugins/")) {
    return "renderer_plugin";
  }
  if (pathname.endsWith(".wasm")) {
    return "wasm";
  }
  return "viewer_asset";
}

async function routeRoomSync(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected WebSocket upgrade" }, 426);
  }

  const originRejection = rejectUntrustedWebSocketOrigin(request, env);
  if (originRejection) {
    return originRejection;
  }

  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  const url = new URL(request.url);
  const notebookId = decodeURIComponent(url.pathname.match(/^\/n\/([^/]+)\/sync\/?$/)?.[1] ?? "");
  if (!notebookId) {
    return json({ error: "notebook id is required" }, 400);
  }
  const authorizedIdentity = await authorizeIdentityOrResponse(
    env,
    notebookId,
    identity,
    identity.scope,
    {
      allowPublicViewerDowngrade: true,
    },
  );
  if (authorizedIdentity instanceof Response) {
    return authorizedIdentity;
  }

  const id = env.NOTEBOOK_ROOMS.idFromName(notebookId);
  const room = env.NOTEBOOK_ROOMS.get(id);
  return room.fetch(stampTrustedIdentity(request, authorizedIdentity));
}

function rejectUntrustedWebSocketOrigin(request: Request, env: Env): Response | null {
  const rawOrigin = request.headers.get("Origin");
  const allowedOrigins = allowedTrustedOrigins(request, env);
  const origin = normalizedOrigin(rawOrigin);
  if (hasOriginHeader(rawOrigin) && !origin) {
    return json({ error: "websocket origin is not allowed" }, 403);
  }
  if (!origin) {
    if (!requiresWebSocketOrigin(request)) {
      return null;
    }
    return json({ error: "websocket origin is required" }, 403);
  }
  if (!allowedOrigins.has(origin)) {
    return json({ error: "websocket origin is not allowed" }, 403);
  }
  return null;
}

function requiresWebSocketOrigin(request: Request): boolean {
  return (
    hasCloudflareAccessSessionCredential(request) || hasCredentialWebSocketSubprotocol(request)
  );
}

function rejectUntrustedMutationOrigin(request: Request, env: Env): Response | null {
  const rawOrigin = request.headers.get("Origin");
  const allowedOrigins = allowedTrustedOrigins(request, env);
  const origin = normalizedOrigin(rawOrigin);
  if (hasOriginHeader(rawOrigin) && !origin) {
    return json({ error: "request origin is not allowed" }, 403);
  }
  if (!origin) {
    if (hasCloudflareAccessSessionCredential(request)) {
      return json({ error: "request origin is required" }, 403);
    }
    return null;
  }
  if (!allowedOrigins.has(origin)) {
    return json({ error: "request origin is not allowed" }, 403);
  }
  return null;
}

function allowedTrustedOrigins(request: Request, env: Env): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin]);
  const raw = env.NOTEBOOK_CLOUD_ALLOWED_ORIGINS?.trim();
  if (!raw) {
    return origins;
  }

  for (const origin of raw
    .split(/[\s,]+/)
    .map((entry) => normalizedOrigin(entry))
    .filter((entry): entry is string => Boolean(entry))) {
    origins.add(origin);
  }
  return origins;
}

function normalizedOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hasOriginHeader(value: string | null): boolean {
  return Boolean(value?.trim());
}

function hasCloudflareAccessCookie(request: Request): boolean {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return false;
  }

  return cookie.split(";").some((part) => part.trim().split("=")[0] === "CF_Authorization");
}

function hasCloudflareAccessSessionCredential(request: Request): boolean {
  return (
    hasCloudflareAccessCookie(request) ||
    Boolean(request.headers.get(CLOUDFLARE_ACCESS_JWT_HEADER)?.trim())
  );
}

function hasCredentialWebSocketSubprotocol(request: Request): boolean {
  const protocol = request.headers.get("Sec-WebSocket-Protocol");
  if (!protocol) {
    return false;
  }
  return protocol
    .split(",")
    .some((part) =>
      [
        ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
        BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
        DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
      ].some((prefix) => part.trim().startsWith(prefix)),
    );
}

function cloudflareAccessHealth(env: Env): {
  status: "configured" | "partial" | "disabled";
  jwks: "remote" | "pinned" | "none";
} {
  const hasTeamDomain = Boolean(env.NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN?.trim());
  const hasAudience = Boolean(env.NOTEBOOK_CLOUD_ACCESS_AUD?.trim());
  const hasPinnedJwks = Boolean(env.NOTEBOOK_CLOUD_ACCESS_JWKS_JSON?.trim());
  const status =
    hasTeamDomain && hasAudience
      ? "configured"
      : hasTeamDomain || hasAudience || hasPinnedJwks
        ? "partial"
        : "disabled";

  return {
    status,
    jwks: hasPinnedJwks ? "pinned" : status === "configured" ? "remote" : "none",
  };
}

function anacondaApiKeyHealth(env: Env): {
  status: "configured" | "partial" | "disabled";
  principal_namespace: "configured" | "default";
} {
  const hasUserinfoUrl = Boolean(env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL?.trim());
  const hasPrincipalNamespace = Boolean(
    env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE?.trim(),
  );
  const status = hasUserinfoUrl ? "configured" : hasPrincipalNamespace ? "partial" : "disabled";

  return {
    status,
    principal_namespace: hasPrincipalNamespace ? "configured" : "default",
  };
}

function oidcHealth(env: Env): {
  status: "configured" | "partial" | "disabled";
  jwks: "remote" | "pinned" | "none";
  audience: "client_id" | "explicit" | "none";
  principal_namespace: "configured" | "default";
} {
  const hasIssuer = Boolean(env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim());
  const hasClientId = Boolean(env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim());
  const hasAudience = Boolean(env.NOTEBOOK_CLOUD_OIDC_AUDIENCE?.trim());
  const hasPinnedJwks = Boolean(env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON?.trim());
  const hasPrincipalNamespace = Boolean(env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim());
  const status =
    hasIssuer && hasClientId
      ? "configured"
      : hasIssuer || hasClientId || hasAudience || hasPinnedJwks
        ? "partial"
        : "disabled";

  return {
    status,
    jwks: hasPinnedJwks ? "pinned" : status === "configured" ? "remote" : "none",
    audience: hasAudience ? "explicit" : hasClientId ? "client_id" : "none",
    principal_namespace: hasPrincipalNamespace ? "configured" : "default",
  };
}

async function routeSnapshot(
  request: Request,
  env: Env,
  notebookId: string,
  headsHash: string,
): Promise<Response> {
  const key = snapshotKey(notebookId, headsHash);

  if (request.method === "GET") {
    const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
    if (identity instanceof Response) {
      return identity;
    }
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

  const originRejection = rejectUntrustedMutationOrigin(request, env);
  if (originRejection) {
    return originRejection;
  }

  const identity = await authorizePublishOrCreateOrResponse(request, env, notebookId, "snapshots");
  if (identity instanceof Response) {
    return identity;
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  const body = await request.arrayBuffer();
  const runtimeHeadsHash = normalizedRuntimeHeadsHash(request.headers.get("x-runtime-heads-hash"));
  const runtimeStateDocId = requiredRuntimeStateDocId(
    request.headers.get("x-runtime-state-doc-id"),
  );
  if (!runtimeStateDocId) {
    return json({ error: "X-Runtime-State-Doc-Id header is required" }, 400);
  }
  const runtimeKey = runtimeHeadsHash
    ? runtimeStateSnapshotKey(runtimeStateDocId, runtimeHeadsHash)
    : null;
  const renderCacheKey = renderKey(notebookId, headsHash);
  let renderCacheWritten = false;
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      runtime_state_doc_id: runtimeStateDocId,
      notebook_heads_hash: headsHash,
    },
  });

  if (runtimeHeadsHash && runtimeKey) {
    const runtimeObject = await env.NOTEBOOK_SNAPSHOTS.get(runtimeKey);
    if (!runtimeObject) {
      await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
      return json(
        {
          error: "snapshot publish missing runtime-state snapshot",
          runtime_heads_hash: runtimeHeadsHash,
        },
        424,
      );
    }

    const materialized = await materializeSnapshotRenderCache({
      request,
      env,
      notebookId,
      notebookHeadsHash: headsHash,
      runtimeHeadsHash,
      notebookBytes: new Uint8Array(body),
      runtimeStateBytes: new Uint8Array(await runtimeObject.arrayBuffer()),
      immutable: true,
    });
    if (!materialized.ok) {
      await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
      return json(materialized.body, materialized.status);
    }
    renderCacheWritten = true;
  }

  let revisionId: string;
  try {
    revisionId = await recordRevision(env, {
      notebookId,
      runtimeStateDocId,
      notebookHeadsHash: headsHash,
      runtimeHeadsHash,
      snapshotKey: key,
      runtimeSnapshotKey: runtimeKey,
      actorLabel: identity.actorLabel,
      publishPublic: true,
    });
  } catch (error) {
    await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
    if (renderCacheWritten) {
      await env.NOTEBOOK_SNAPSHOTS.delete(renderCacheKey).catch(() => undefined);
    }
    throw error;
  }

  return json(
    { ok: true, revision_id: revisionId, key, runtime_state_doc_id: runtimeStateDocId },
    201,
  );
}

async function routeRuntimeSnapshot(
  request: Request,
  env: Env,
  notebookId: string,
  headsHash: string,
): Promise<Response> {
  if (request.method === "GET") {
    const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
    if (identity instanceof Response) {
      return identity;
    }
    const runtimeStateDocId = requiredRuntimeStateDocId(
      request.headers.get("x-runtime-state-doc-id"),
    );
    if (!runtimeStateDocId) {
      return json({ error: "X-Runtime-State-Doc-Id header is required" }, 400);
    }
    const key = runtimeStateSnapshotKey(runtimeStateDocId, headsHash);
    const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
    if (!object) {
      return json({ error: "runtime snapshot not found" }, 404);
    }
    if (
      object.customMetadata?.notebook_id !== notebookId ||
      object.customMetadata?.runtime_state_doc_id !== runtimeStateDocId
    ) {
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

  const originRejection = rejectUntrustedMutationOrigin(request, env);
  if (originRejection) {
    return originRejection;
  }

  const identity = await authorizePublishOrCreateOrResponse(
    request,
    env,
    notebookId,
    "runtime snapshots",
  );
  if (identity instanceof Response) {
    return identity;
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  const body = await request.arrayBuffer();
  const runtimeStateDocId = requiredRuntimeStateDocId(
    request.headers.get("x-runtime-state-doc-id"),
  );
  if (!runtimeStateDocId) {
    return json({ error: "X-Runtime-State-Doc-Id header is required" }, 400);
  }
  const key = runtimeStateSnapshotKey(runtimeStateDocId, headsHash);
  const existing = await env.NOTEBOOK_SNAPSHOTS.head(key);
  if (
    existing &&
    (existing.customMetadata?.notebook_id !== notebookId ||
      existing.customMetadata?.runtime_state_doc_id !== runtimeStateDocId)
  ) {
    return json({ error: "runtime snapshot belongs to another notebook" }, 403);
  }
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      runtime_state_doc_id: runtimeStateDocId,
      runtime_heads_hash: headsHash,
      artifact: "runtime-state-snapshot",
    },
  });

  return json(
    { ok: true, key, size: body.byteLength, runtime_state_doc_id: runtimeStateDocId },
    201,
  );
}

interface PendingInvitePayload {
  email?: unknown;
  provider_hint?: unknown;
  providerHint?: unknown;
  scope?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
}

interface ParsedPendingInviteInput {
  email: string;
  provider_hint: string | null;
  scope: "viewer" | "editor";
  expires_at: string | null;
}

async function routeNotebookInvites(
  request: Request,
  env: Env,
  notebookId: string,
): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  if (request.method === "POST") {
    const originRejection = rejectUntrustedMutationOrigin(request, env);
    if (originRejection) {
      return originRejection;
    }
  }

  const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "owner");
  if (identity instanceof Response) {
    return identity;
  }

  if (request.method === "GET") {
    return json({
      notebook_id: notebookId,
      invites: (await listNotebookInvites(env, notebookId)).map(inviteResponse),
    });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const inviteInput = await parsePendingInviteInput(request);
  if (inviteInput instanceof Response) {
    return inviteInput;
  }

  const invite = await createPendingNotebookInvite(env, {
    notebookId,
    email: inviteInput.email,
    providerHint: inviteInput.provider_hint,
    scope: inviteInput.scope,
    expiresAt: inviteInput.expires_at,
    actorLabel: identity.actorLabel,
  });

  if (!invite) {
    return json({ error: "invite was not created" }, 500);
  }

  cloudLog("info", "invite.create.completed", {
    notebook_id: notebookId,
    principal: identity.principal,
    actor_label: identity.actorLabel,
    invite_id: invite.id,
    invite_scope: invite.scope,
    provider_hint: invite.provider_hint,
    counter: "invite_creates",
    counter_delta: 1,
  });

  return json(
    {
      ok: true,
      notebook_id: notebookId,
      invite: inviteResponse(invite),
    },
    201,
  );
}

async function routeNotebookInvite(
  request: Request,
  env: Env,
  notebookId: string,
  inviteId: string,
): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  if (request.method === "DELETE") {
    const originRejection = rejectUntrustedMutationOrigin(request, env);
    if (originRejection) {
      return originRejection;
    }
  }

  const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "owner");
  if (identity instanceof Response) {
    return identity;
  }

  if (request.method !== "DELETE") {
    return json({ error: "method not allowed" }, 405);
  }

  const revoked = await revokePendingNotebookInvite(env, {
    notebookId,
    inviteId,
    actorLabel: identity.actorLabel,
  });
  if (!revoked) {
    return json({ error: "pending invite not found" }, 404);
  }

  cloudLog("info", "invite.revoke.completed", {
    notebook_id: notebookId,
    principal: identity.principal,
    actor_label: identity.actorLabel,
    invite_id: inviteId,
    counter: "invite_revocations",
    counter_delta: 1,
  });

  return json({
    ok: true,
    notebook_id: notebookId,
    invites: (await listNotebookInvites(env, notebookId)).map(inviteResponse),
  });
}

async function parsePendingInviteInput(
  request: Request,
): Promise<ParsedPendingInviteInput | Response> {
  let payload: PendingInvitePayload;
  try {
    payload = (await request.json()) as PendingInvitePayload;
  } catch {
    return json({ error: "invite body must be JSON" }, 400);
  }

  const email = stringField(payload.email, "email");
  if (email instanceof Response) {
    return email;
  }
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeInviteEmail(email);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }

  const scopeValue = stringField(payload.scope, "scope");
  if (scopeValue instanceof Response) {
    return scopeValue;
  }
  if (scopeValue !== "viewer" && scopeValue !== "editor") {
    return json({ error: "invite scope must be viewer or editor" }, 400);
  }

  const providerHint = optionalStringField(
    payload.provider_hint ?? payload.providerHint,
    "provider_hint",
  );
  if (providerHint instanceof Response) {
    return providerHint;
  }
  let normalizedProviderHint: string | null;
  try {
    normalizedProviderHint = normalizeProviderHint(providerHint);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }

  const expiresAt = optionalStringField(payload.expires_at ?? payload.expiresAt, "expires_at");
  if (expiresAt instanceof Response) {
    return expiresAt;
  }
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return json({ error: "invite expiry is invalid" }, 400);
    }
    if (expiresAtMs <= Date.now()) {
      return json({ error: "invite expiry must be in the future" }, 400);
    }
  }

  return {
    email: normalizedEmail,
    provider_hint: normalizedProviderHint,
    scope: scopeValue,
    expires_at: expiresAt,
  };
}

function inviteResponse(
  row: PendingNotebookInviteRow | ListedPendingNotebookInviteRow,
): Record<string, unknown> {
  return {
    id: row.id,
    notebook_id: row.notebook_id,
    email: row.email_normalized,
    provider_hint: row.provider_hint,
    scope: row.scope,
    status: row.status,
    invited_by_actor_label: row.invited_by_actor_label,
    accepted_by_principal: row.accepted_by_principal,
    created_at: row.created_at,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at,
    revoked_by_actor_label: row.revoked_by_actor_label,
  };
}

async function aclResponseRows(
  env: Env,
  rows: NotebookAclRow[],
): Promise<Array<NotebookAclRow & { display: ReturnType<typeof shareTargetDisplay> }>> {
  const principals = rows
    .filter((row) => row.subject_kind === "principal")
    .map((row) => row.subject);
  const profilesByPrincipal = new Map(
    (await getPrincipalProfiles(env, principals)).map((profile) => [profile.principal, profile]),
  );
  return rows.map((row) => aclRowResponse(row, profilesByPrincipal.get(row.subject)));
}

function aclRowResponse(
  row: NotebookAclRow,
  profile?: PrincipalProfileRow,
): NotebookAclRow & { display: ReturnType<typeof shareTargetDisplay> } {
  if (row.subject_kind === "public") {
    return {
      ...row,
      display: shareTargetDisplay({ publicViewer: true }),
    };
  }

  return {
    ...row,
    display: profile
      ? shareTargetDisplay({ profile: principalProfileFromRow(profile) })
      : {
          kind: "principal",
          label: row.subject,
          principal: row.subject,
          email: null,
        },
  };
}

function principalProfileFromRow(row: PrincipalProfileRow): PrincipalProfile {
  return {
    principal: row.principal,
    provider: row.provider,
    email: row.email_normalized,
    displayName: row.display_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function routeNotebookAcl(request: Request, env: Env, notebookId: string): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  if (request.method === "POST" || request.method === "DELETE") {
    const originRejection = rejectUntrustedMutationOrigin(request, env);
    if (originRejection) {
      return originRejection;
    }
  }

  const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "owner");
  if (identity instanceof Response) {
    return identity;
  }

  if (request.method === "GET") {
    const acl = await getNotebookAclRows(env, notebookId);
    return json({
      notebook_id: notebookId,
      acl: await aclResponseRows(env, acl),
    });
  }

  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method not allowed" }, 405);
  }

  const aclInput = await parseNotebookAclInput(request);
  if (aclInput instanceof Response) {
    return aclInput;
  }

  if (request.method === "DELETE") {
    const revoked = await revokeNotebookAclRow(env, {
      notebookId,
      subjectKind: aclInput.subject_kind,
      subject: aclInput.subject,
      scope: aclInput.scope,
    });
    const acl = await getNotebookAclRows(env, notebookId);
    if (!revoked && isOwnerAclInput(aclInput) && aclContainsInput(acl, aclInput)) {
      if (isOnlyOwnerAclRow(acl, aclInput)) {
        return json({ error: "cannot remove the last owner ACL row" }, 409);
      }
      return json({ error: "owner ACL row was not removed; retry the request" }, 409);
    }
    cloudLog("info", "acl.revoke.completed", {
      notebook_id: notebookId,
      principal: identity.principal,
      actor_label: identity.actorLabel,
      acl_subject_kind: aclInput.subject_kind,
      acl_subject: aclInput.subject,
      acl_scope: aclInput.scope,
      revoked,
      counter: "acl_revocations",
      counter_delta: 1,
    });
    return json({
      ok: true,
      notebook_id: notebookId,
      acl: await aclResponseRows(env, acl),
    });
  }

  await grantNotebookAclRow(env, {
    notebookId,
    subjectKind: aclInput.subject_kind,
    subject: aclInput.subject,
    scope: aclInput.scope,
    actorLabel: identity.actorLabel,
  });
  cloudLog("info", "acl.grant.completed", {
    notebook_id: notebookId,
    principal: identity.principal,
    actor_label: identity.actorLabel,
    acl_subject_kind: aclInput.subject_kind,
    acl_subject: aclInput.subject,
    acl_scope: aclInput.scope,
    counter: "acl_grants",
    counter_delta: 1,
  });
  return json(
    {
      ok: true,
      notebook_id: notebookId,
      acl: await aclResponseRows(env, await getNotebookAclRows(env, notebookId)),
    },
    201,
  );
}

async function routeCatalog(request: Request, env: Env, notebookId: string): Promise<Response> {
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }
  const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
  if (identity instanceof Response) {
    return identity;
  }

  const catalog = await getNotebookCatalog(env, notebookId);
  if (!catalog) {
    return json({ error: "notebook not found" }, 404);
  }

  return json(catalog);
}

async function routeRender(
  request: Request,
  env: Env,
  notebookId: string,
  headsHash: string,
): Promise<Response> {
  if (request.method === "GET") {
    const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
    if (identity instanceof Response) {
      return identity;
    }
    const catalog = await getNotebookCatalog(env, notebookId);
    const revision = catalog?.revisions.find(
      (candidate) => candidate.notebook_heads_hash === headsHash,
    );
    return revision
      ? getRenderObjectOrMaterialize(request, env, notebookId, revision, true)
      : getRenderObject(env, notebookId, headsHash, true);
  }

  return json({ error: "method not allowed" }, 405);
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

  const materialized = await materializeSnapshotRenderCache({
    request,
    env,
    notebookId,
    notebookHeadsHash: revision.notebook_heads_hash,
    runtimeHeadsHash: revision.runtime_heads_hash,
    notebookBytes: new Uint8Array(await notebookObject.arrayBuffer()),
    runtimeStateBytes: new Uint8Array(await runtimeObject.arrayBuffer()),
    immutable,
  });
  if (!materialized.ok) {
    return json(materialized.body, materialized.status);
  }

  return withCors(
    new Response(materialized.body, {
      headers: {
        "Cache-Control": immutable
          ? "public, max-age=31536000, immutable"
          : "public, max-age=30, stale-while-revalidate=300",
        "Content-Type": "application/json; charset=utf-8",
      },
    }),
  );
}

async function materializeSnapshotRenderCache(options: {
  request: Request;
  env: Env;
  notebookId: string;
  notebookHeadsHash: string;
  runtimeHeadsHash: string | null;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  immutable: boolean;
}): Promise<RenderMaterializationResult> {
  const startedAt = Date.now();
  const bucket = options.env.NOTEBOOK_SNAPSHOTS;
  if (!bucket) {
    return {
      ok: false,
      status: 503,
      body: { error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" },
    };
  }

  let render: Awaited<ReturnType<typeof materializeSnapshotPairRender>>;
  try {
    render = await materializeSnapshotPairRender({
      notebookId: options.notebookId,
      notebookHeadsHash: options.notebookHeadsHash,
      runtimeHeadsHash: options.runtimeHeadsHash,
      notebookBytes: options.notebookBytes,
      runtimeStateBytes: options.runtimeStateBytes,
      blobResolver: createNotebookCloudBlobResolver({
        baseUrl: options.request.url,
        blobBasePath: notebookCloudBlobBasePath(options.notebookId),
      }),
    });
  } catch (error) {
    cloudLog("warn", "render.materialization.failed", {
      notebook_id: options.notebookId,
      notebook_heads_hash: options.notebookHeadsHash,
      runtime_heads_hash: options.runtimeHeadsHash,
      duration_ms: durationMs(startedAt),
      error: errorMessage(error),
      counter: "render_materialization_failures",
      counter_delta: 1,
    });
    return {
      ok: false,
      status: 422,
      body: {
        error: "render materialization failed",
        details: errorMessage(error),
      },
    };
  }

  const missingBlobs = await findMissingRenderBlobs(bucket, options.notebookId, render);
  if (missingBlobs.length > 0) {
    cloudLog("warn", "render.materialization.missing_blobs", {
      notebook_id: options.notebookId,
      notebook_heads_hash: options.notebookHeadsHash,
      runtime_heads_hash: options.runtimeHeadsHash,
      duration_ms: durationMs(startedAt),
      missing_blob_count: missingBlobs.length,
      missing_blob_hashes: missingBlobs.map((blob) => blob.hash).slice(0, 20),
      counter: "render_materialization_missing_blobs",
      counter_delta: 1,
    });
    return {
      ok: false,
      status: 424,
      body: {
        error: "render materialization missing blobs",
        missing_blobs: missingBlobs,
      },
    };
  }

  const body = JSON.stringify(render);
  await bucket.put(renderKey(options.notebookId, options.notebookHeadsHash), body, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: options.immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=30, stale-while-revalidate=300",
    },
    customMetadata: {
      notebook_id: options.notebookId,
      notebook_heads_hash: options.notebookHeadsHash,
      runtime_heads_hash: options.runtimeHeadsHash ?? "",
      artifact: "materialized-render",
    },
  });
  cloudLog("info", "render.materialization.completed", {
    notebook_id: options.notebookId,
    notebook_heads_hash: options.notebookHeadsHash,
    runtime_heads_hash: options.runtimeHeadsHash,
    duration_ms: durationMs(startedAt),
    cell_count: Array.isArray(render.cells) ? render.cells.length : undefined,
    blob_ref_count: Object.keys(render.blob_urls).length,
    byte_length: body.length,
    counter: "render_materializations",
    counter_delta: 1,
  });
  return { ok: true, body };
}

async function findMissingRenderBlobs(
  bucket: NonNullable<Env["NOTEBOOK_SNAPSHOTS"]>,
  notebookId: string,
  render: unknown,
): Promise<MissingRenderBlob[]> {
  const refs = collectRenderBlobRefs(render);
  const missing: Array<MissingRenderBlob | null> = [];

  for (let index = 0; index < refs.length; index += RENDER_BLOB_HEAD_CONCURRENCY) {
    const batch = refs.slice(index, index + RENDER_BLOB_HEAD_CONCURRENCY);
    missing.push(
      ...(await Promise.all(
        batch.map(async (ref) => {
          const object = await bucket.head(blobKey(notebookId, ref.blob));
          return object
            ? null
            : {
                hash: ref.blob,
                size: ref.size ?? null,
                media_type: ref.media_type ?? null,
              };
        }),
      )),
    );
  }

  return missing
    .filter((entry): entry is MissingRenderBlob => entry !== null)
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

function collectRenderBlobRefs(render: unknown): BlobRef[] {
  const refs = collectBlobRefs(render);
  const blobUrls = isRecord(render) ? render.blob_urls : undefined;
  if (isRecord(blobUrls)) {
    for (const hash of Object.keys(blobUrls)) {
      refs[hash] ??= { blob: hash };
    }
  }
  return Object.values(refs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function routeBlob(
  request: Request,
  env: Env,
  notebookId: string,
  hash: string,
): Promise<Response> {
  const key = blobKey(notebookId, hash);

  if (request.method === "HEAD") {
    const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
    if (identity instanceof Response) {
      return identity;
    }
    const object = await env.NOTEBOOK_SNAPSHOTS?.head(key);
    if (!object) {
      cloudLog("warn", "blob.read.missing", {
        notebook_id: notebookId,
        hash,
        method: "HEAD",
        counter: "blob_read_misses",
        counter_delta: 1,
      });
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
    const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
    if (identity instanceof Response) {
      return identity;
    }
    const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
    if (!object) {
      cloudLog("warn", "blob.read.missing", {
        notebook_id: notebookId,
        hash,
        method: "GET",
        counter: "blob_read_misses",
        counter_delta: 1,
      });
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

  const originRejection = rejectUntrustedMutationOrigin(request, env);
  if (originRejection) {
    return originRejection;
  }

  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsBlobUpload(identity.scope)) {
    return json({ error: `${identity.scope} cannot upload blobs` }, 403);
  }
  if (!env.NOTEBOOK_SNAPSHOTS) {
    return json({ error: "R2 binding NOTEBOOK_SNAPSHOTS is not configured" }, 503);
  }

  const body = await request.arrayBuffer();
  const digest = await sha256Hex(body);
  if (hash !== digest) {
    cloudLog("warn", "blob.upload.rejected", {
      notebook_id: notebookId,
      hash,
      actual_hash: digest,
      reason: "hash_mismatch",
      byte_length: body.byteLength,
      counter: "blob_upload_rejections",
      counter_delta: 1,
    });
    return json(
      {
        error: "blob hash mismatch",
        expected: hash,
        actual: digest,
      },
      400,
    );
  }

  const authorizedIdentity = allowsPublish(identity.scope)
    ? await authorizePublishOrCreate(env, notebookId, identity)
    : await authorizeIdentityOrResponse(env, notebookId, identity);
  if (authorizedIdentity instanceof Response) {
    return authorizedIdentity;
  }

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
  cloudLog("info", "blob.upload.completed", {
    notebook_id: notebookId,
    hash,
    byte_length: body.byteLength,
    content_type: contentType,
    principal: authorizedIdentity.principal,
    scope: authorizedIdentity.scope,
    counter: "blob_uploads",
    counter_delta: 1,
  });

  return json({ ok: true, key, size: body.byteLength }, 201);
}

interface NotebookAclPayload {
  subject_kind?: unknown;
  subjectKind?: unknown;
  subject?: unknown;
  scope?: unknown;
}

interface ParsedNotebookAclInput {
  subject_kind: NotebookAclRow["subject_kind"];
  subject: string;
  scope: NotebookAclRow["scope"];
}

async function parseNotebookAclInput(request: Request): Promise<ParsedNotebookAclInput | Response> {
  let payload: NotebookAclPayload;
  try {
    payload = (await request.json()) as NotebookAclPayload;
  } catch {
    return json({ error: "ACL mutation body must be JSON" }, 400);
  }

  const subjectKind = stringField(payload.subject_kind ?? payload.subjectKind, "subject_kind");
  if (subjectKind instanceof Response) {
    return subjectKind;
  }
  if (subjectKind !== "principal" && subjectKind !== "public") {
    return json({ error: "subject_kind must be 'principal' or 'public'" }, 400);
  }

  const subject = stringField(payload.subject, "subject");
  if (subject instanceof Response) {
    return subject;
  }

  const scopeValue = stringField(payload.scope, "scope");
  if (scopeValue instanceof Response) {
    return scopeValue;
  }

  let scope: ConnectionScope;
  try {
    scope = parseScope(scopeValue);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }

  if (subjectKind === "public") {
    if (subject !== "anonymous") {
      return json({ error: "public ACL rows must use subject 'anonymous'" }, 400);
    }
    if (scope !== "viewer") {
      return json({ error: "public ACL rows may only grant viewer scope" }, 400);
    }
  } else {
    try {
      validatePrincipal(subject);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
    if (subject === "system" || subject.startsWith("anonymous:")) {
      return json(
        { error: "principal ACL rows cannot target system or anonymous principals" },
        400,
      );
    }
  }

  return {
    subject_kind: subjectKind,
    subject,
    scope,
  };
}

function stringField(value: unknown, fieldName: string): string | Response {
  if (typeof value !== "string" || value.trim() === "") {
    return json({ error: `${fieldName} must be a non-empty string` }, 400);
  }
  return value.trim();
}

function optionalStringField(value: unknown, fieldName: string): string | null | Response {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return json({ error: `${fieldName} must be a string` }, 400);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isOwnerAclInput(row: ParsedNotebookAclInput): boolean {
  return row.subject_kind === "principal" && row.scope === "owner";
}

function aclContainsInput(rows: NotebookAclRow[], row: ParsedNotebookAclInput): boolean {
  return rows.some(
    (candidate) =>
      candidate.subject_kind === row.subject_kind &&
      candidate.subject === row.subject &&
      candidate.scope === row.scope,
  );
}

function isOnlyOwnerAclRow(rows: NotebookAclRow[], row: ParsedNotebookAclInput): boolean {
  if (row.subject_kind !== "principal" || row.scope !== "owner") {
    return false;
  }

  const ownerRows = rows.filter(
    (candidate) => candidate.subject_kind === "principal" && candidate.scope === "owner",
  );
  return ownerRows.length === 1 && ownerRows[0]?.subject === row.subject;
}

async function safeEnsureCatalogSchema(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    ensureCatalogSchema(env).catch((error: unknown) => {
      console.warn("Unable to ensure D1 schema", error);
    }),
  );
}

async function authenticateRequestOrResponse(
  request: Request,
  env: Env,
): Promise<AuthenticatedConnection | Response> {
  try {
    const identity = await authenticateRequestWithProviders(request, env);
    await resolveLoginInvites(env, identity);
    return identity;
  } catch (error) {
    if (error instanceof AuthError) {
      cloudLog(error.status >= 500 ? "warn" : "info", "auth.failed", {
        status: error.status,
        reason: error.message,
        has_dev_token_header: request.headers.has(DEV_AUTH_TOKEN_HEADER),
        has_websocket_protocol: request.headers.has("sec-websocket-protocol"),
        counter: "auth_failures",
        counter_delta: 1,
      });
      return json({ error: error.message }, error.status);
    }
    cloudLog("info", "auth.failed", {
      status: 400,
      reason: String(error),
      has_dev_token_header: request.headers.has(DEV_AUTH_TOKEN_HEADER),
      has_websocket_protocol: request.headers.has("sec-websocket-protocol"),
      counter: "auth_failures",
      counter_delta: 1,
    });
    return json({ error: String(error) }, 400);
  }
}

async function resolveLoginInvites(env: Env, identity: AuthenticatedConnection): Promise<void> {
  if (identity.metadata.provider !== "cloudflare-access" && identity.metadata.provider !== "oidc") {
    return;
  }

  try {
    // The identity provider has already authenticated this email claim; use it
    // only to resolve pending invite rows into principal ACL rows before
    // authorization.
    const login = {
      principal: identity.principal,
      provider: identity.metadata.provider,
      email: identity.metadata.email ?? null,
      emailVerified: identity.metadata.emailVerified === true,
      displayName: identity.metadata.displayName ?? null,
    };
    const pendingInvites = await getPendingNotebookInvitesForLogin(env, login);
    if (pendingInvites.length === 0) {
      return;
    }
    const resolution = await resolveNotebookInvitesForLogin(env, login);
    if (resolution.acceptedInvites.length === 0 && resolution.aclGrants.length === 0) {
      return;
    }
    cloudLog("info", "invites.resolution.completed", {
      principal: identity.principal,
      provider: identity.metadata.provider,
      accepted_invite_count: resolution.acceptedInvites.length,
      acl_grant_count: resolution.aclGrants.length,
      counter: "invite_resolutions",
      counter_delta: resolution.acceptedInvites.length,
    });
  } catch (error) {
    cloudLog("warn", "invites.resolution.failed", {
      principal: identity.principal,
      provider: identity.metadata.provider,
      reason: error instanceof Error ? error.message : String(error),
      counter: "invite_resolution_failures",
      counter_delta: 1,
    });
  }
}

async function authenticateAndAuthorizeOrResponse(
  request: Request,
  env: Env,
  notebookId: string,
  requestedScope: ConnectionScope,
): Promise<AuthenticatedConnection | Response> {
  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  return authorizeIdentityOrResponse(env, notebookId, identity, requestedScope);
}

async function authorizeIdentityOrResponse(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
  requestedScope: ConnectionScope = identity.scope,
  options?: AuthorizeNotebookAccessOptions,
): Promise<AuthenticatedConnection | Response> {
  try {
    return await authorizeNotebookAccess(env, notebookId, identity, requestedScope, options);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      cloudLog(error.status >= 500 ? "warn" : "info", "authz.denied", {
        notebook_id: notebookId,
        principal: identity.principal,
        scope: identity.scope,
        requested_scope: requestedScope,
        status: error.status,
        reason: error.message,
        counter: "authorization_denials",
        counter_delta: 1,
      });
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}

async function authorizePublishOrCreateOrResponse(
  request: Request,
  env: Env,
  notebookId: string,
  artifactName: string,
): Promise<AuthenticatedConnection | Response> {
  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot publish ${artifactName}` }, 403);
  }
  return authorizePublishOrCreate(env, notebookId, identity);
}

async function authorizePublishOrCreate(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
): Promise<AuthenticatedConnection | Response> {
  if (!env.DB) {
    return identity;
  }

  const existing = await getNotebookRow(env, notebookId);
  if (existing) {
    return authorizeIdentityOrResponse(env, notebookId, identity, "owner");
  }

  await createNotebookWithOwnerAcl(env, notebookId, identity);
  cloudLog("info", "notebook.created", {
    notebook_id: notebookId,
    owner_principal: identity.principal,
    actor_label: identity.actorLabel,
    counter: "notebooks_created",
    counter_delta: 1,
  });
  return authorizeIdentityOrResponse(env, notebookId, identity, "owner");
}

function json(value: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "DELETE, GET, HEAD, POST, PUT, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    `Authorization, Cf-Access-Jwt-Assertion, CF-Access-Token, Content-Type, X-User, X-Principal, X-Operator, X-Scope, X-Viewer-Session, X-Runtime-Heads-Hash, ${DEV_AUTH_TOKEN_HEADER}`,
  );
  return response;
}

function withBrowserSecurityHeaders(response: Response, contentSecurityPolicy?: string): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "picture-in-picture=()",
      "publickey-credentials-get=()",
      "screen-wake-lock=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  );
  if (contentSecurityPolicy) {
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  }
  return response;
}

function viewerContentSecurityPolicy(env: Env): string {
  const connectSources = new Set(["'self'", "ws:", "wss:"]);
  const oidcIssuerOrigin = absoluteOrigin(env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim() ?? "");
  if (oidcIssuerOrigin) {
    connectSources.add(oidcIssuerOrigin);
  }
  const rendererAssetOrigin = absoluteOrigin(rendererAssetsBasePath(env));
  if (rendererAssetOrigin) {
    connectSources.add(rendererAssetOrigin);
  }
  const runtimedWasmOrigin = absoluteOrigin(runtimedWasmBasePath(env));
  if (runtimedWasmOrigin) {
    connectSources.add(runtimedWasmOrigin);
  }
  const frameSources = new Set(["'self'", "blob:", "data:"]);
  const outputDocumentOrigin = absoluteOrigin(outputDocumentBaseUrl(env) ?? "");
  if (outputDocumentOrigin) {
    frameSources.add(outputDocumentOrigin);
  }

  // The shared isolated output renderer currently boots from about:srcdoc,
  // which inherits the parent page CSP. Do not set default-src/script-src here:
  // that blocks the sandboxed renderer bootstrap unless the iframe moves to a
  // separate origin or every generated script carries a matching nonce/hash.
  return [
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "worker-src 'self' blob:",
    `frame-src ${Array.from(frameSources).join(" ")}`,
    "form-action 'none'",
  ].join("; ");
}

function absoluteOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

function normalizedRuntimeHeadsHash(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "none" ? trimmed : null;
}

function requiredRuntimeStateDocId(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "none" ? trimmed : null;
}

function viewer(notebookId: string, request: Request, env: Env, headsHash?: string): Response {
  const escaped = escapeHtml(notebookId);
  const title = headsHash ? `${escaped} @ ${escapeHtml(headsHash)}` : escaped;
  const notebookApiBasePath = `/api/n/${encodeURIComponent(notebookId)}`;
  const config = {
    notebookId,
    headsHash: headsHash ?? null,
    pinnedRenderBasePath: `${notebookApiBasePath}/renders/`,
    aclEndpoint: `${notebookApiBasePath}/acl`,
    invitesEndpoint: `${notebookApiBasePath}/invites`,
    syncEndpoint: `/n/${encodeURIComponent(notebookId)}/sync`,
    blobBasePath: notebookCloudBlobBasePath(notebookId),
    rendererAssetsBasePath: rendererAssetsBasePath(env),
    outputDocumentBaseUrl: outputDocumentBaseUrl(env),
    runtimedWasmModulePath: runtimedWasmAssetPath(env, VIEWER_RUNTIMED_WASM_MODULE_NAME),
    runtimedWasmPath: runtimedWasmAssetPath(env, VIEWER_RUNTIMED_WASM_NAME),
  };
  return viewerShell(
    `nteract cloud notebook ${title}`,
    env,
    authConfigForRequest(request, env),
    config,
  );
}

function homeViewer(request: Request, env: Env): Response {
  return viewerShell("nteract cloud notebooks", env, authConfigForRequest(request, env), null);
}

function oidcCallbackViewer(request: Request, env: Env): Response {
  return viewerShell(
    "nteract cloud notebook sign-in",
    env,
    authConfigForRequest(request, env),
    null,
  );
}

function viewerShell(
  title: string,
  env: Env,
  authConfig: unknown,
  config: Record<string, unknown> | null,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style id="nteract-cloud-viewer-theme-surface">${viewerThemeFirstPaintStyle()}</style>
  <script>${viewerThemeBootstrapScript()}</script>
  <link rel="stylesheet" href="/assets/notebook-cloud-viewer.css" />
</head>
<body>
  <div id="root"></div>
  <script id="nteract-cloud-auth-config" type="application/json">${scriptJsonForHtml(authConfig)}</script>
  ${
    config
      ? `<script id="nteract-cloud-viewer-config" type="application/json">${scriptJsonForHtml(
          config,
        )}</script>`
      : ""
  }
  <script type="module" src="/assets/notebook-cloud-viewer.js"></script>
</body>
</html>`;

  return withCors(
    withBrowserSecurityHeaders(
      new Response(html, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        },
      }),
      viewerContentSecurityPolicy(env),
    ),
  );
}

function authConfigForRequest(request: Request, env: Env): { oidc: Record<string, string> | null } {
  const issuer = env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim();
  const clientId = env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) {
    return { oidc: null };
  }
  return {
    oidc: {
      issuer,
      clientId,
      redirectUri:
        env.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI?.trim() || new URL("/oidc", request.url).href,
    },
  };
}

function rendererAssetsBasePath(env: Env): string {
  const configured = env.RENDERER_ASSETS_BASE_URL?.trim();
  return withTrailingSlash(configured || DEFAULT_RENDERER_ASSETS_BASE_PATH);
}

function runtimedWasmBasePath(env: Env): string {
  const configured = env.RUNTIMED_WASM_BASE_URL?.trim();
  return withTrailingSlash(configured || DEFAULT_RUNTIMED_WASM_BASE_PATH);
}

function outputDocumentBaseUrl(env: Env): string | null {
  const configured = env.OUTPUT_DOCUMENT_BASE_URL?.trim();
  return configured ? withTrailingSlash(configured) : null;
}

function runtimedWasmAssetPath(env: Env, name: string): string {
  return `${runtimedWasmBasePath(env)}${name}`;
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
    </div>
  </main>
  <script type="module">
    const notebookId = ${scriptJsonForHtml(notebookId)};
    const frameType = { presence: 0x04, sessionControl: 0x07 };
    const log = document.querySelector("#log");
    const catalog = document.querySelector("#catalog");
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
      const catalogResponse = await fetch("/api/n/" + encodeURIComponent(notebookId));
      catalog.textContent = catalogResponse.ok
        ? JSON.stringify(await catalogResponse.json(), null, 2)
        : "No catalog row yet";
    }
    refreshCatalog();
  </script>
</body>
</html>`;

  return withCors(
    withBrowserSecurityHeaders(
      new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    ),
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
