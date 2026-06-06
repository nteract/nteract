import type { Env, ExecutionContext, ExportedHandler } from "./cloudflare-types.ts";
import type { BlobRef } from "runtimed";
import { NotebookRoom } from "./notebook-room.ts";
import {
  AuthError,
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  allowsBlobUpload,
  allowsPublish,
  authenticateRequestWithProviders,
  DEV_AUTH_TOKEN_HEADER,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  isAnonymousViewer,
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
  commsDocSnapshotKey,
  createNotebookWithOwnerAcl,
  ensureCatalogSchema,
  getNotebookAclRows,
  getNotebookRow,
  getNotebookCatalog,
  grantNotebookAclRow,
  listNotebooksForPrincipal,
  recordBlob,
  recordRevision,
  revokeNotebookAclRow,
  runtimeStateSnapshotKey,
  snapshotKey,
  type NotebookAclRow,
  type NotebookAccessRequestRow,
  type NotebookAccessRequestStatus,
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
  createNotebookAccessRequest,
  getLatestNotebookAccessRequestForRequester,
  listNotebookAccessRequests,
  resolveNotebookAccessRequest,
} from "./access-requests-storage.ts";
import {
  viewerThemeBootstrapScript,
  viewerThemeFirstPaintStyle,
} from "./viewer-theme-bootstrap.ts";
import {
  dispatchWorkerRoute,
  exactPath,
  routePath,
  type WorkerRouteMatch,
  type WorkerRoute,
} from "./worker-routing.ts";
import {
  immutableR2ObjectHeadResponse,
  immutableR2ObjectResponse,
  json,
  withBrowserSecurityHeaders,
  withCors,
} from "./http-responses.ts";

export { NotebookRoom };

// `/plugins/*` is a raw static asset path in deployed Workers. Use a
// Worker-owned route by default so sandboxed srcdoc iframes can fetch sidecar
// assets with explicit CORS, and let hosts replace it with a dedicated origin.
const DEFAULT_RENDERER_ASSETS_BASE_PATH = "/renderer-assets/";
const DEFAULT_RUNTIMED_WASM_BASE_PATH = "/assets/";
const VIEWER_RUNTIME_WASM_ASSET_MANIFEST_PATH = "/assets/runtime-wasm-assets.json";
const VIEWER_RUNTIMED_WASM_MODULE_NAME = "runtimed_wasm.js";
const VIEWER_RUNTIMED_WASM_NAME = "runtimed_wasm_bg.wasm";
const SNAPSHOT_BLOB_HEAD_CONCURRENCY = 16;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CREATE_NOTEBOOK_ID_ATTEMPTS = 8;

interface MissingSnapshotBlob {
  hash: string;
  size: number | null;
  media_type: string | null;
}

interface RuntimeWasmAssetNames {
  module: string;
  wasm: string;
}

type SnapshotPairValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

const NOTEBOOK_CLOUD_ROUTES: readonly WorkerRoute[] = [
  {
    match: exactPath("/api/health"),
    methods: ["GET"],
    handler: routeHealth,
  },
  {
    match: exactPath("/", "/index.html"),
    methods: ["GET"],
    handler: (_match, request, env) => homeViewer(request, env),
  },
  {
    match: exactPath("/oidc"),
    methods: ["GET"],
    handler: (_match, request, env) => oidcCallbackViewer(request, env),
  },
  {
    match: routePath("/n/:notebookId/sync", { trailingSlash: "optional" }),
    handler: (_match, request, env) => routeRoomSync(request, env),
  },
  {
    match: routePath("/n/:notebookId/debug", { trailingSlash: "optional" }),
    methods: ["GET"],
    handler: ({ params }) => debugViewer(params.notebookId),
  },
  {
    match: routePath("/n/:notebookId/r/:revision", { trailingSlash: "optional" }),
    methods: ["GET"],
    handler: ({ params }, request, env) => viewer(params.notebookId, request, env, params.revision),
  },
  {
    match: routePath("/n/:notebookId/:vanityName", { trailingSlash: "optional" }),
    methods: ["GET"],
    handler: ({ params }, request, env) => viewer(params.notebookId, request, env),
  },
  {
    match: exactPath("/api/n"),
    methods: ["POST"],
    handler: (_match, request, env) => routeCreateNotebook(request, env),
  },
  {
    match: exactPath("/api/n"),
    methods: ["GET"],
    handler: (_match, request, env) => routeListNotebooks(request, env),
  },
  {
    match: routePath("/api/n/:notebookId", { trailingSlash: "optional" }),
    methods: ["GET"],
    handler: ({ params }, request, env) => routeCatalog(request, env, params.notebookId),
  },
  {
    match: routePath("/api/n/:notebookId/acl", { trailingSlash: "optional" }),
    handler: ({ params }, request, env) => routeNotebookAcl(request, env, params.notebookId),
  },
  {
    match: routePath("/api/n/:notebookId/invites", { trailingSlash: "optional" }),
    handler: ({ params }, request, env) => routeNotebookInvites(request, env, params.notebookId),
  },
  {
    match: routePath("/api/n/:notebookId/invites/:inviteId", { trailingSlash: "optional" }),
    handler: ({ params }, request, env) =>
      routeNotebookInvite(request, env, params.notebookId, params.inviteId),
  },
  {
    match: routePath("/api/n/:notebookId/access-requests", { trailingSlash: "optional" }),
    handler: ({ params }, request, env) =>
      routeNotebookAccessRequests(request, env, params.notebookId),
  },
  {
    match: routePath("/api/n/:notebookId/access-requests/:accessRequestId", {
      trailingSlash: "optional",
    }),
    handler: ({ params }, request, env) =>
      routeNotebookAccessRequest(request, env, params.notebookId, params.accessRequestId),
  },
  {
    match: routePath("/api/n/:notebookId/runtime-snapshots/:runtimeHeadsHash"),
    handler: ({ params }, request, env) =>
      routeRuntimeSnapshot(request, env, params.notebookId, params.runtimeHeadsHash),
  },
  {
    match: routePath("/api/n/:notebookId/comms-snapshots/:commsHeadsHash"),
    handler: ({ params }, request, env) =>
      routeCommsSnapshot(request, env, params.notebookId, params.commsHeadsHash),
  },
  {
    match: routePath("/api/n/:notebookId/snapshots/:headsHash"),
    handler: ({ params }, request, env) =>
      routeSnapshot(request, env, params.notebookId, params.headsHash),
  },
  {
    match: routePath("/api/n/:notebookId/blobs/:hash"),
    handler: ({ params }, request, env, ctx) =>
      routeBlob(request, env, ctx, params.notebookId, params.hash),
  },
];

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const assetResponse = await routeAsset(request, env);
    if (assetResponse) {
      return assetResponse;
    }

    const routeResponse = await dispatchWorkerRoute(NOTEBOOK_CLOUD_ROUTES, request, env, ctx);
    if (routeResponse) {
      return routeResponse;
    }

    return json({ error: "not found" }, 404);
  },
};

export default worker;

async function routeHealth(
  _match: WorkerRouteMatch,
  _request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  await safeEnsureCatalogSchema(env, ctx);
  return json({
    status: "ok",
    service: "nteract-notebook-cloud",
    deployment_env: env.DEPLOYMENT_ENV ?? "development",
    auth: {
      anaconda_api_key: anacondaApiKeyHealth(env),
      oidc: oidcHealth(env),
    },
  });
}

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
  return hasCredentialWebSocketSubprotocol(request);
}

function rejectUntrustedMutationOrigin(request: Request, env: Env): Response | null {
  const rawOrigin = request.headers.get("Origin");
  const allowedOrigins = allowedTrustedOrigins(request, env);
  const origin = normalizedOrigin(rawOrigin);
  if (hasOriginHeader(rawOrigin) && !origin) {
    return json({ error: "request origin is not allowed" }, 403);
  }
  if (!origin) {
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

function hasCredentialWebSocketSubprotocol(request: Request): boolean {
  const protocol = request.headers.get("Sec-WebSocket-Protocol");
  if (!protocol) {
    return false;
  }
  return protocol
    .split(",")
    .some((part) =>
      [BEARER_AUTH_TOKEN_PROTOCOL_PREFIX, DEV_AUTH_TOKEN_PROTOCOL_PREFIX].some((prefix) =>
        part.trim().startsWith(prefix),
      ),
    );
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

type CreateNotebookPayload = Record<string, unknown>;

async function routeCreateNotebook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const originRejection = rejectUntrustedMutationOrigin(request, env);
  if (originRejection) {
    return originRejection;
  }
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (!allowsPublish(identity.scope)) {
    return json({ error: `${identity.scope} cannot create notebooks` }, 403);
  }

  const payload = await readCreateNotebookPayload(request);
  if (payload instanceof Response) {
    return payload;
  }
  const vanityName = optionalPayloadString(payload, ["vanity_name", "vanityName"], {
    field: "vanity_name",
    maxLength: 128,
  });
  if (vanityName instanceof Response) {
    return vanityName;
  }
  const sourceNotebookId = optionalPayloadString(
    payload,
    ["source_notebook_id", "sourceNotebookId"],
    { field: "source_notebook_id", maxLength: 256 },
  );
  if (sourceNotebookId instanceof Response) {
    return sourceNotebookId;
  }
  const sourceNotebookName = optionalPayloadString(
    payload,
    ["source_notebook_name", "sourceNotebookName"],
    { field: "source_notebook_name", maxLength: 256 },
  );
  if (sourceNotebookName instanceof Response) {
    return sourceNotebookName;
  }

  const notebookId = await createUniqueNotebookId(env);
  if (!notebookId) {
    return json({ error: "could not allocate notebook id" }, 500);
  }
  const notebookCreation = await createNotebookWithOwnerAcl(env, notebookId, identity);
  if (!notebookCreation.created) {
    return json({ error: "could not allocate notebook id" }, 500);
  }
  cloudLog("info", "notebook.created", {
    notebook_id: notebookId,
    owner_principal: notebookCreation.ownerPrincipal,
    actor_label: identity.actorLabel,
    source_notebook_id: sourceNotebookId,
    source_notebook_name: sourceNotebookName,
    counter: "notebooks_created",
    counter_delta: 1,
  });

  const viewerUrl = viewerUrlForRequest(request, notebookId, vanityName);
  const apiBasePath = `/api/n/${encodeURIComponent(notebookId)}`;
  return json(
    {
      ok: true,
      notebook_id: notebookId,
      vanity_name: vanityName,
      viewer_url: viewerUrl,
      source_notebook_id: sourceNotebookId,
      source_notebook_name: sourceNotebookName,
      endpoints: {
        catalog: apiBasePath,
        blobs: `${apiBasePath}/blobs/{hash}`,
        runtime_snapshots: `${apiBasePath}/runtime-snapshots/{runtimeHeadsHash}`,
        comms_snapshots: `${apiBasePath}/comms-snapshots/{commsHeadsHash}`,
        snapshots: `${apiBasePath}/snapshots/{notebookHeadsHash}`,
      },
    },
    201,
  );
}

const DEFAULT_NOTEBOOK_LIST_LIMIT = 100;
const MAX_NOTEBOOK_LIST_LIMIT = 500;

async function routeListNotebooks(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!env.DB) {
    return json({ error: "D1 binding DB is not configured" }, 503);
  }

  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }
  if (isAnonymousViewer(identity)) {
    return json({ error: "sign in to list notebooks" }, 401);
  }

  const limit = parseNotebookListLimit(request);
  if (limit instanceof Response) {
    return limit;
  }

  const notebooks = await listNotebooksForPrincipal(env, identity.principal, limit);
  return json({
    ok: true,
    notebooks: notebooks.map((notebook) => {
      const notebookPathId = encodeURIComponent(notebook.id);
      const apiBasePath = `/api/n/${notebookPathId}`;
      return {
        notebook_id: notebook.id,
        title: notebook.title,
        owner_principal: notebook.owner_principal,
        scope: notebook.scope,
        created_at: notebook.created_at,
        updated_at: notebook.updated_at,
        latest_revision_id: notebook.latest_revision_id,
        viewer_url: viewerUrlForRequest(request, notebook.id, notebook.title),
        endpoints: {
          catalog: apiBasePath,
          acl: `${apiBasePath}/acl`,
          access_requests: `${apiBasePath}/access-requests`,
        },
      };
    }),
  });
}

function parseNotebookListLimit(request: Request): number | Response {
  const value = new URL(request.url).searchParams.get("limit");
  if (value === null || value.trim() === "") {
    return DEFAULT_NOTEBOOK_LIST_LIMIT;
  }

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    return json({ error: "limit must be a positive integer" }, 400);
  }
  return Math.min(limit, MAX_NOTEBOOK_LIST_LIMIT);
}

async function readCreateNotebookPayload(
  request: Request,
): Promise<CreateNotebookPayload | Response> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return {};
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }
  if (!isRecord(payload)) {
    return json({ error: "request body must be a JSON object" }, 400);
  }
  return payload;
}

function optionalPayloadString(
  payload: Record<string, unknown>,
  keys: string[],
  options: {
    field: string;
    maxLength: number;
  },
): string | null | Response {
  const rawValue = keys.map((key) => payload[key]).find((value) => value !== undefined);
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  if (typeof rawValue !== "string") {
    return json({ error: `${options.field} must be a string` }, 400);
  }
  const value = rawValue.trim();
  if (!value) {
    return null;
  }
  if (value.length > options.maxLength) {
    return json({ error: `${options.field} is too long` }, 400);
  }
  return value;
}

async function createUniqueNotebookId(env: Env): Promise<string | null> {
  for (let attempt = 0; attempt < CREATE_NOTEBOOK_ID_ATTEMPTS; attempt += 1) {
    const notebookId = createUlid();
    if (!(await getNotebookRow(env, notebookId))) {
      return notebookId;
    }
  }
  return null;
}

function createUlid(now = Date.now(), random = randomBytes(10)): string {
  let time = BigInt(Math.max(0, Math.min(now, 0xffffffffffff)));
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) {
    encodedTime = ULID_ALPHABET[Number(time & 31n)] + encodedTime;
    time >>= 5n;
  }

  let randomValue = 0n;
  for (const byte of random) {
    randomValue = (randomValue << 8n) | BigInt(byte);
  }
  let encodedRandom = "";
  for (let index = 0; index < 16; index += 1) {
    encodedRandom = ULID_ALPHABET[Number(randomValue & 31n)] + encodedRandom;
    randomValue >>= 5n;
  }

  return `${encodedTime}${encodedRandom}`;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function viewerUrlForRequest(
  request: Request,
  notebookId: string,
  vanityName: string | null,
): string {
  const url = new URL(request.url);
  const vanitySegment = vanityName?.trim() || "notebook";
  url.pathname = `/n/${encodeURIComponent(notebookId)}/${encodeURIComponent(vanitySegment)}`;
  url.search = "";
  url.hash = "";
  return url.href;
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

    return immutableR2ObjectResponse(object);
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
  const commsHeadsHash = normalizedRuntimeHeadsHash(request.headers.get("x-comms-heads-hash"));
  const runtimeStateDocId = requiredRuntimeStateDocId(
    request.headers.get("x-runtime-state-doc-id"),
  );
  if (!runtimeStateDocId) {
    return json({ error: "X-Runtime-State-Doc-Id header is required" }, 400);
  }
  if (!runtimeHeadsHash) {
    return json({ error: "X-Runtime-Heads-Hash header is required" }, 400);
  }
  const runtimeKey = runtimeStateSnapshotKey(runtimeStateDocId, runtimeHeadsHash);
  const commsKey = commsHeadsHash ? commsDocSnapshotKey(runtimeStateDocId, commsHeadsHash) : null;
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      runtime_state_doc_id: runtimeStateDocId,
      notebook_heads_hash: headsHash,
      comms_heads_hash: commsHeadsHash ?? "",
    },
  });

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
  const commsObject = commsKey ? await env.NOTEBOOK_SNAPSHOTS.get(commsKey) : null;
  if (commsKey && !commsObject) {
    await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
    return json(
      {
        error: "snapshot publish missing comms-doc snapshot",
        comms_heads_hash: commsHeadsHash,
      },
      424,
    );
  }

  const validated = await validateSnapshotPair({
    request,
    env,
    notebookId,
    notebookHeadsHash: headsHash,
    runtimeHeadsHash,
    expectedRuntimeStateDocId: runtimeStateDocId,
    notebookBytes: new Uint8Array(body),
    runtimeStateBytes: new Uint8Array(await runtimeObject.arrayBuffer()),
    commsDocBytes: commsObject ? new Uint8Array(await commsObject.arrayBuffer()) : undefined,
  });
  if (!validated.ok) {
    await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
    return json(validated.body, validated.status);
  }

  let revisionId: string;
  try {
    revisionId = await recordRevision(env, {
      notebookId,
      runtimeStateDocId,
      notebookHeadsHash: headsHash,
      runtimeHeadsHash,
      commsHeadsHash,
      snapshotKey: key,
      runtimeSnapshotKey: runtimeKey,
      commsSnapshotKey: commsKey,
      actorLabel: identity.actorLabel,
      publishPublic: true,
    });
  } catch (error) {
    await env.NOTEBOOK_SNAPSHOTS.delete(key).catch(() => undefined);
    throw error;
  }

  return json(
    {
      ok: true,
      revision_id: revisionId,
      key,
      runtime_state_doc_id: runtimeStateDocId,
      comms_snapshot_key: commsKey,
    },
    201,
  );
}

async function routeCommsSnapshot(
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
    const key = commsDocSnapshotKey(runtimeStateDocId, headsHash);
    const object = await env.NOTEBOOK_SNAPSHOTS?.get(key);
    if (!object) {
      return json({ error: "comms snapshot not found" }, 404);
    }
    if (
      object.customMetadata?.notebook_id !== notebookId ||
      object.customMetadata?.runtime_state_doc_id !== runtimeStateDocId
    ) {
      return json({ error: "comms snapshot not found" }, 404);
    }

    return immutableR2ObjectResponse(object);
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
    "comms snapshots",
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
  const key = commsDocSnapshotKey(runtimeStateDocId, headsHash);
  const existing = await env.NOTEBOOK_SNAPSHOTS.head(key);
  if (
    existing &&
    (existing.customMetadata?.notebook_id !== notebookId ||
      existing.customMetadata?.runtime_state_doc_id !== runtimeStateDocId)
  ) {
    return json({ error: "comms snapshot belongs to another notebook" }, 403);
  }
  await env.NOTEBOOK_SNAPSHOTS.put(key, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      notebook_id: notebookId,
      runtime_state_doc_id: runtimeStateDocId,
      comms_heads_hash: headsHash,
      artifact: "comms-doc-snapshot",
    },
  });

  return json(
    { ok: true, key, size: body.byteLength, runtime_state_doc_id: runtimeStateDocId },
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

    return immutableR2ObjectResponse(object);
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

interface AccessRequestActionPayload {
  action?: unknown;
}

async function routeNotebookAccessRequests(
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

  const identity = await authenticateRequestOrResponse(request, env);
  if (identity instanceof Response) {
    return identity;
  }

  if (request.method === "GET") {
    const owner = await tryAuthorizeNotebookAccess(env, notebookId, identity, "owner");
    if (owner.ok) {
      return json({
        notebook_id: notebookId,
        access_requests: await accessRequestResponseRows(
          env,
          await listNotebookAccessRequests(env, notebookId),
        ),
      });
    }

    if (isAnonymousViewer(identity)) {
      return json({ error: "sign in to view access requests" }, 401);
    }

    const viewer = await tryAuthorizeNotebookAccess(env, notebookId, identity, "viewer");
    if (!viewer.ok) {
      return json({ error: viewer.error.message }, viewer.error.status);
    }

    const latest = await getLatestNotebookAccessRequestForRequester(env, {
      notebookId,
      requesterPrincipal: identity.principal,
    });
    return json({
      notebook_id: notebookId,
      access_requests: latest ? [accessRequestResponse(latest)] : [],
    });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (isAnonymousViewer(identity)) {
    return json({ error: "sign in to request edit access" }, 401);
  }

  const viewer = await tryAuthorizeNotebookAccess(env, notebookId, identity, "viewer");
  if (!viewer.ok) {
    return json({ error: viewer.error.message }, viewer.error.status);
  }

  const editor = await tryAuthorizeNotebookAccess(env, notebookId, identity, "editor");
  if (editor.ok) {
    return json({
      ok: true,
      notebook_id: notebookId,
      access_status: "granted",
      access_request: null,
    });
  }

  const accessRequestResult = await createNotebookAccessRequest(env, {
    notebookId,
    requesterPrincipal: identity.principal,
    actorLabel: identity.actorLabel,
  });
  if (!accessRequestResult) {
    return json({ error: "access request was not created" }, 500);
  }
  const accessRequest = accessRequestResult.request;

  if (accessRequestResult.created) {
    cloudLog("info", "access_request.create.completed", {
      notebook_id: notebookId,
      principal: identity.principal,
      actor_label: identity.actorLabel,
      access_request_id: accessRequest.id,
      counter: "access_request_creates",
      counter_delta: 1,
    });
  }

  return json(
    {
      ok: true,
      notebook_id: notebookId,
      access_status: accessRequest.status,
      access_request: accessRequestResponse(accessRequest),
    },
    accessRequestResult.created ? 201 : 200,
  );
}

async function routeNotebookAccessRequest(
  request: Request,
  env: Env,
  notebookId: string,
  requestId: string,
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

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const status = await parseAccessRequestResolutionStatus(request);
  if (status instanceof Response) {
    return status;
  }

  const resolved = await resolveNotebookAccessRequest(env, {
    notebookId,
    requestId,
    status,
    actorLabel: identity.actorLabel,
  });
  if (!resolved) {
    return json({ error: "pending access request not found" }, 404);
  }

  cloudLog("info", "access_request.resolve.completed", {
    notebook_id: notebookId,
    principal: identity.principal,
    actor_label: identity.actorLabel,
    access_request_id: requestId,
    access_request_status: resolved.status,
    counter: "access_request_resolutions",
    counter_delta: 1,
  });

  return json({
    ok: true,
    notebook_id: notebookId,
    access_request: accessRequestResponse(resolved),
    access_requests: await accessRequestResponseRows(
      env,
      await listNotebookAccessRequests(env, notebookId),
    ),
  });
}

async function parseAccessRequestResolutionStatus(
  request: Request,
): Promise<Exclude<NotebookAccessRequestStatus, "pending"> | Response> {
  let payload: AccessRequestActionPayload;
  try {
    payload = (await request.json()) as AccessRequestActionPayload;
  } catch {
    return json({ error: "access request body must be JSON" }, 400);
  }

  const action = stringField(payload.action, "action");
  if (action instanceof Response) {
    return action;
  }

  switch (action) {
    case "approve":
      return "approved";
    case "deny":
      return "denied";
    case "dismiss":
      return "dismissed";
    default:
      return json({ error: "access request action must be approve, deny, or dismiss" }, 400);
  }
}

async function accessRequestResponseRows(
  env: Env,
  rows: NotebookAccessRequestRow[],
): Promise<Array<Record<string, unknown>>> {
  const principals = rows.map((row) => row.requester_principal);
  const profilesByPrincipal = new Map(
    (await getPrincipalProfiles(env, principals)).map((profile) => [profile.principal, profile]),
  );
  return rows.map((row) =>
    accessRequestResponse(row, profilesByPrincipal.get(row.requester_principal)),
  );
}

function accessRequestResponse(
  row: NotebookAccessRequestRow,
  profile?: PrincipalProfileRow,
): Record<string, unknown> {
  return {
    id: row.id,
    notebook_id: row.notebook_id,
    requester_principal: row.requester_principal,
    scope: row.scope,
    status: row.status,
    requested_by_actor_label: row.requested_by_actor_label,
    resolved_by_actor_label: row.resolved_by_actor_label,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    display: profile
      ? shareTargetDisplay({ profile: principalProfileFromRow(profile) })
      : {
          kind: "principal",
          label: row.requester_principal,
          principal: row.requester_principal,
          email: null,
        },
  };
}

async function tryAuthorizeNotebookAccess(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
  requestedScope: ConnectionScope,
): Promise<
  { ok: true; identity: AuthenticatedConnection } | { ok: false; error: AuthorizationError }
> {
  try {
    return {
      ok: true,
      identity: await authorizeNotebookAccess(env, notebookId, identity, requestedScope),
    };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, error };
    }
    throw error;
  }
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

async function validateSnapshotPair(options: {
  request: Request;
  env: Env;
  notebookId: string;
  notebookHeadsHash: string;
  runtimeHeadsHash: string | null;
  expectedRuntimeStateDocId: string;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  commsDocBytes?: Uint8Array;
}): Promise<SnapshotPairValidationResult> {
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
      commsDocBytes: options.commsDocBytes,
      blobResolver: createNotebookCloudBlobResolver({
        baseUrl: options.request.url,
        blobBasePath: notebookCloudBlobBasePath(options.notebookId),
      }),
    });
  } catch (error) {
    cloudLog("warn", "snapshot_pair.validation.failed", {
      notebook_id: options.notebookId,
      notebook_heads_hash: options.notebookHeadsHash,
      runtime_heads_hash: options.runtimeHeadsHash,
      duration_ms: durationMs(startedAt),
      error: errorMessage(error),
      counter: "snapshot_pair_validation_failures",
      counter_delta: 1,
    });
    return {
      ok: false,
      status: 422,
      body: {
        error: "snapshot pair validation failed",
        details: errorMessage(error),
      },
    };
  }

  if (render.runtime_state_doc_id !== options.expectedRuntimeStateDocId) {
    cloudLog("warn", "snapshot_pair.validation.runtime_state_doc_id_mismatch", {
      notebook_id: options.notebookId,
      notebook_heads_hash: options.notebookHeadsHash,
      runtime_heads_hash: options.runtimeHeadsHash,
      expected_runtime_state_doc_id: options.expectedRuntimeStateDocId,
      actual_runtime_state_doc_id: render.runtime_state_doc_id,
      duration_ms: durationMs(startedAt),
      counter: "snapshot_pair_validation_runtime_doc_mismatches",
      counter_delta: 1,
    });
    return {
      ok: false,
      status: 409,
      body: {
        error: "snapshot pair runtime_state_doc_id mismatch",
        expected_runtime_state_doc_id: options.expectedRuntimeStateDocId,
        actual_runtime_state_doc_id: render.runtime_state_doc_id,
      },
    };
  }

  const missingBlobs = await findMissingSnapshotBlobs(bucket, options.notebookId, render);
  if (missingBlobs.length > 0) {
    cloudLog("warn", "snapshot_pair.validation.missing_blobs", {
      notebook_id: options.notebookId,
      notebook_heads_hash: options.notebookHeadsHash,
      runtime_heads_hash: options.runtimeHeadsHash,
      duration_ms: durationMs(startedAt),
      missing_blob_count: missingBlobs.length,
      missing_blob_hashes: missingBlobs.map((blob) => blob.hash).slice(0, 20),
      counter: "snapshot_pair_validation_missing_blobs",
      counter_delta: 1,
    });
    return {
      ok: false,
      status: 424,
      body: {
        error: "snapshot pair validation missing blobs",
        missing_blobs: missingBlobs,
      },
    };
  }

  cloudLog("info", "snapshot_pair.validation.completed", {
    notebook_id: options.notebookId,
    notebook_heads_hash: options.notebookHeadsHash,
    runtime_heads_hash: options.runtimeHeadsHash,
    duration_ms: durationMs(startedAt),
    cell_count: Array.isArray(render.cells) ? render.cells.length : undefined,
    blob_ref_count: Object.keys(render.blob_urls).length,
    counter: "snapshot_pair_validations",
    counter_delta: 1,
  });
  return { ok: true };
}

async function findMissingSnapshotBlobs(
  bucket: NonNullable<Env["NOTEBOOK_SNAPSHOTS"]>,
  notebookId: string,
  render: unknown,
): Promise<MissingSnapshotBlob[]> {
  const refs = collectSnapshotBlobRefs(render);
  const missing: Array<MissingSnapshotBlob | null> = [];

  for (let index = 0; index < refs.length; index += SNAPSHOT_BLOB_HEAD_CONCURRENCY) {
    const batch = refs.slice(index, index + SNAPSHOT_BLOB_HEAD_CONCURRENCY);
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
    .filter((entry): entry is MissingSnapshotBlob => entry !== null)
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

function collectSnapshotBlobRefs(render: unknown): BlobRef[] {
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
  ctx: ExecutionContext,
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

    return immutableR2ObjectHeadResponse(object);
  }

  if (request.method === "GET") {
    const identity = await authenticateAndAuthorizeOrResponse(request, env, notebookId, "viewer");
    if (identity instanceof Response) {
      return identity;
    }
    const cache = cloudflareDefaultCache();
    const cacheKey = blobCacheKey(request);
    const cached = cache ? await matchBlobCache(cache, cacheKey, notebookId, hash) : null;
    if (cached) {
      cloudLog("debug", "blob.read.cache_hit", {
        notebook_id: notebookId,
        hash,
        counter: "blob_read_cache_hits",
        counter_delta: 1,
      });
      const cachedResponse = withCors(new Response(cached.body, cached));
      cachedResponse.headers.set("X-Notebook-Cloud-Blob-Cache", "hit");
      return cachedResponse;
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

    const response = immutableR2ObjectResponse(object, { includeContentLength: true });
    if (cache) {
      response.headers.set("X-Notebook-Cloud-Blob-Cache", "miss");
      ctx.waitUntil(
        cache.put(cacheKey, response.clone()).catch((error) => {
          cloudLog("warn", "blob.read.cache_put_failed", {
            notebook_id: notebookId,
            hash,
            error: errorMessage(error),
            counter: "blob_read_cache_put_failures",
            counter_delta: 1,
          });
        }),
      );
    }
    return response;
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

type CloudflareCacheStorage = CacheStorage & { default?: Cache };

function cloudflareDefaultCache(): Cache | null {
  const cacheStorage = (globalThis as { caches?: CloudflareCacheStorage }).caches;
  return cacheStorage?.default ?? null;
}

async function matchBlobCache(
  cache: Cache,
  cacheKey: Request,
  notebookId: string,
  hash: string,
): Promise<Response | null> {
  try {
    return (await cache.match(cacheKey)) ?? null;
  } catch (error) {
    cloudLog("warn", "blob.read.cache_match_failed", {
      notebook_id: notebookId,
      hash,
      error: errorMessage(error),
      counter: "blob_read_cache_match_failures",
      counter_delta: 1,
    });
    return null;
  }
}

function blobCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
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
    await syncAuthenticatedProfile(env, identity);
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

async function syncAuthenticatedProfile(
  env: Env,
  identity: AuthenticatedConnection,
): Promise<void> {
  if (identity.metadata.provider !== "oidc" && identity.metadata.provider !== "anaconda-api-key") {
    return;
  }

  try {
    const profile = {
      principal: identity.principal,
      provider: identity.metadata.provider,
      email: identity.metadata.email ?? null,
      displayName: identity.metadata.displayName ?? null,
    };

    // Canonical account ACLs are keyed by verified email. OIDC carries an
    // explicit email_verified claim; Anaconda API-key whoami responses are
    // trusted to return only server-verified account emails. If that backend
    // contract changes, API-key email claims must stop feeding invite
    // resolution and account canonicalization.
    const resolution = await resolveNotebookInvitesForLogin(env, {
      ...profile,
      principalNamespace: identity.metadata.principalNamespace,
      emailVerified:
        identity.metadata.provider === "anaconda-api-key"
          ? Boolean(identity.metadata.email)
          : identity.metadata.emailVerified === true,
    });
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
    cloudLog("warn", "profile.sync.failed", {
      principal: identity.principal,
      provider: identity.metadata.provider,
      reason: error instanceof Error ? error.message : String(error),
      counter: "profile_sync_failures",
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

  const notebookCreation = await createNotebookWithOwnerAcl(env, notebookId, identity);
  if (notebookCreation.created) {
    cloudLog("info", "notebook.created", {
      notebook_id: notebookId,
      owner_principal: notebookCreation.ownerPrincipal,
      actor_label: identity.actorLabel,
      counter: "notebooks_created",
      counter_delta: 1,
    });
  }
  return authorizeIdentityOrResponse(env, notebookId, identity, "owner");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function viewer(
  notebookId: string,
  request: Request,
  env: Env,
  headsHash?: string,
): Promise<Response> {
  const escaped = escapeHtml(notebookId);
  const title = headsHash ? `${escaped} @ ${escapeHtml(headsHash)}` : escaped;
  const notebookApiBasePath = `/api/n/${encodeURIComponent(notebookId)}`;
  const runtimeWasmAssets = await runtimeWasmAssetNames(env);
  const config = {
    notebookId,
    headsHash: headsHash ?? null,
    catalogEndpoint: notebookApiBasePath,
    snapshotBasePath: `${notebookApiBasePath}/snapshots/`,
    runtimeSnapshotBasePath: `${notebookApiBasePath}/runtime-snapshots/`,
    commsSnapshotBasePath: `${notebookApiBasePath}/comms-snapshots/`,
    aclEndpoint: `${notebookApiBasePath}/acl`,
    invitesEndpoint: `${notebookApiBasePath}/invites`,
    accessRequestsEndpoint: `${notebookApiBasePath}/access-requests`,
    hostCapabilities: {
      canManageSharing: true,
    },
    syncEndpoint: `/n/${encodeURIComponent(notebookId)}/sync`,
    blobBasePath: notebookCloudBlobBasePath(notebookId),
    rendererAssetsBasePath: rendererAssetsBasePath(env),
    outputDocumentBaseUrl: outputDocumentBaseUrl(env),
    runtimedWasmModulePath: runtimedWasmAssetPath(env, runtimeWasmAssets.module),
    runtimedWasmPath: runtimedWasmAssetPath(env, runtimeWasmAssets.wasm),
  };
  return viewerShell(
    `nteract cloud notebook ${title}`,
    env,
    authConfigForRequest(request, env),
    config,
  );
}

interface ViewerShellConfig extends Record<string, unknown> {
  outputDocumentBaseUrl?: string | null;
  rendererAssetsBasePath?: string;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
}

function homeViewer(request: Request, env: Env): Response {
  return viewerShell("nteract", env, authConfigForRequest(request, env), null);
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
  config: ViewerShellConfig | null,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style id="nteract-cloud-viewer-theme-surface">${viewerThemeFirstPaintStyle()}</style>
  <script>${viewerThemeBootstrapScript()}</script>
  ${viewerResourceHints(config)}
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

function viewerResourceHints(config: ViewerShellConfig | null): string {
  const viewerEntryHint = `<link rel="modulepreload" href="/assets/notebook-cloud-viewer.js" />`;
  if (!config) {
    return viewerEntryHint;
  }

  return [
    ...preconnectResourceHints([
      config.rendererAssetsBasePath,
      config.outputDocumentBaseUrl,
      config.runtimedWasmModulePath,
    ]),
    viewerEntryHint,
    `<link rel="modulepreload" href="${escapeHtml(config.runtimedWasmModulePath)}" crossorigin />`,
    `<link rel="preload" href="${escapeHtml(
      config.runtimedWasmPath,
    )}" as="fetch" type="application/wasm" crossorigin />`,
  ].join("\n  ");
}

function preconnectResourceHints(urls: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  const hints: string[] = [];
  for (const value of urls) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      continue;
    }
    if (origins.has(url.origin)) {
      continue;
    }
    origins.add(url.origin);
    hints.push(`<link rel="preconnect" href="${escapeHtml(url.origin)}" crossorigin />`);
  }
  return hints;
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

async function runtimeWasmAssetNames(env: Env): Promise<RuntimeWasmAssetNames> {
  if (!env.ASSETS) {
    return defaultRuntimeWasmAssetNames();
  }

  try {
    const manifestRequest = new Request(
      `https://notebook-cloud.local${VIEWER_RUNTIME_WASM_ASSET_MANIFEST_PATH}`,
    );
    const response = await env.ASSETS.fetch(manifestRequest);
    if (!response.ok) {
      return defaultRuntimeWasmAssetNames();
    }
    const manifest = await response.json();
    if (isRuntimeWasmAssetManifest(manifest)) {
      return manifest;
    }
    cloudLog("warn", "viewer.runtime_wasm_manifest.invalid", {
      manifest_path: VIEWER_RUNTIME_WASM_ASSET_MANIFEST_PATH,
    });
  } catch (error) {
    cloudLog("warn", "viewer.runtime_wasm_manifest.failed", {
      manifest_path: VIEWER_RUNTIME_WASM_ASSET_MANIFEST_PATH,
      error: errorMessage(error),
    });
  }

  return defaultRuntimeWasmAssetNames();
}

function defaultRuntimeWasmAssetNames(): RuntimeWasmAssetNames {
  return {
    module: VIEWER_RUNTIMED_WASM_MODULE_NAME,
    wasm: VIEWER_RUNTIMED_WASM_NAME,
  };
}

function isRuntimeWasmAssetManifest(value: unknown): value is RuntimeWasmAssetNames {
  if (!value || typeof value !== "object") {
    return false;
  }
  const manifest = value as Record<string, unknown>;
  return isRuntimeWasmModuleName(manifest.module) && isRuntimeWasmBinaryName(manifest.wasm);
}

function isRuntimeWasmModuleName(value: unknown): value is string {
  return typeof value === "string" && /^runtimed_wasm(?:\.[a-f0-9]{12,64})?\.js$/.test(value);
}

function isRuntimeWasmBinaryName(value: unknown): value is string {
  return typeof value === "string" && /^runtimed_wasm_bg(?:\.[a-f0-9]{12,64})?\.wasm$/.test(value);
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
