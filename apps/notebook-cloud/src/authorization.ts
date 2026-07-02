import type { Env } from "./cloudflare-types.ts";
import {
  type AuthenticatedConnection,
  type ConnectionScope,
  isAnonymousViewer,
} from "./identity.ts";
import {
  ensureCatalogSchema,
  getNotebookAclRowsForPrincipal,
  getNotebookRow,
  getPublicNotebookAclRows,
  type NotebookAclRow,
  type NotebookRow,
} from "./storage.ts";

const CAP_READ = 1 << 0;
const CAP_NOTEBOOK_WRITE = 1 << 1;
const CAP_RUNTIME_WRITE = 1 << 2;
const CAP_PUBLISH = 1 << 3;
const CAP_MANAGE_ACL = 1 << 4;

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface AuthorizeNotebookAccessOptions {
  /**
   * Browser viewers can arrive with a stale or over-eager requested editor
   * scope while still only being allowed to read the notebook. Use this only on
   * the live room connection path so mutation routes do not continue after a
   * silent scope downgrade.
   */
  allowViewerDowngrade?: boolean;
  /**
   * Browser live-room tickets may optimistically request owner so the room
   * opens with the user's best available control surface. Read-only discovery
   * routes may also use this to report the caller's effective scope. Mutation
   * routes must keep exact requested authority.
   */
  allowLiveScopeDowngrade?: boolean;
}

export interface AuthorizedNotebookAccess {
  identity: AuthenticatedConnection;
  notebook: NotebookRow;
}

export async function authorizeNotebookAccess(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
  requestedScope: ConnectionScope = identity.scope,
  options: AuthorizeNotebookAccessOptions = {},
): Promise<AuthenticatedConnection> {
  return (
    await authorizeNotebookAccessWithNotebook(env, notebookId, identity, requestedScope, options)
  ).identity;
}

export async function authorizeNotebookAccessWithNotebook(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
  requestedScope: ConnectionScope = identity.scope,
  options: AuthorizeNotebookAccessOptions = {},
): Promise<AuthorizedNotebookAccess> {
  if (!env.DB) {
    throw new AuthorizationError("D1 binding DB is not configured", 503);
  }

  await ensureCatalogSchema(env);
  const notebook = await getNotebookRow(env, notebookId);
  if (!notebook) {
    throw new AuthorizationError("notebook not found", 404);
  }

  if (isAnonymousViewer(identity)) {
    if (requestedScope !== "viewer") {
      throw new AuthorizationError("anonymous viewers may only request viewer scope", 403);
    }

    const publicRows = await getPublicNotebookAclRows(env, notebookId);
    if (!aclRowsCoverScope(publicRows, "viewer")) {
      throw new AuthorizationError("notebook not found", 404);
    }

    return { identity: { ...identity, scope: "viewer" }, notebook };
  }

  const principalRows = await getNotebookAclRowsForPrincipal(env, notebookId, identity.principal);
  if (aclRowsCoverScope(principalRows, requestedScope)) {
    return { identity: { ...identity, scope: requestedScope }, notebook };
  }
  if (options.allowLiveScopeDowngrade) {
    const downgradedScope = bestDowngradedLiveScope(principalRows, requestedScope);
    if (downgradedScope) {
      return { identity: { ...identity, scope: downgradedScope }, notebook };
    }
  }
  if (
    options.allowViewerDowngrade &&
    requestedScope === "editor" &&
    aclRowsCoverScope(principalRows, "viewer")
  ) {
    return { identity: { ...identity, scope: "viewer" }, notebook };
  }

  const publicRows = await getPublicNotebookAclRows(env, notebookId);
  if (aclRowsCoverScope(publicRows, "viewer")) {
    if (requestedScope === "viewer") {
      return { identity: { ...identity, scope: "viewer" }, notebook };
    }
    if (options.allowLiveScopeDowngrade && requestedScope !== "runtime_peer") {
      return { identity: { ...identity, scope: "viewer" }, notebook };
    }
    if (options.allowViewerDowngrade && requestedScope === "editor") {
      return { identity: { ...identity, scope: "viewer" }, notebook };
    }
  }

  throw new AuthorizationError(`${identity.principal} cannot access ${notebookId}`, 403);
}

function bestDowngradedLiveScope(
  rows: NotebookAclRow[],
  requestedScope: ConnectionScope,
): "editor" | "viewer" | null {
  if (requestedScope === "owner" && aclRowsCoverScope(rows, "editor")) {
    return "editor";
  }
  if (
    (requestedScope === "owner" || requestedScope === "editor") &&
    aclRowsCoverScope(rows, "viewer")
  ) {
    return "viewer";
  }
  return null;
}

export function aclRowsCoverScope(
  rows: NotebookAclRow[],
  requestedScope: ConnectionScope,
): boolean {
  if (requestedScope === "runtime_peer") {
    return rows.some((row) => row.scope === "runtime_peer");
  }
  const granted = rows.reduce((mask, row) => mask | capabilityMask(row.scope), 0);
  const requested = capabilityMask(requestedScope);
  return (granted & requested) === requested;
}

export function capabilityMask(scope: ConnectionScope): number {
  switch (scope) {
    case "viewer":
      return CAP_READ;
    case "editor":
      // No CAP_RUNTIME_WRITE: "can edit notebook" must never read as "can
      // author runtime state". Runtime-doc policy rejects editor
      // RuntimeStateDoc writes; the lattice now says the same (HCA-2). An
      // editor row covers exactly {viewer, editor}.
      return CAP_READ | CAP_NOTEBOOK_WRITE;
    case "runtime_peer":
      return CAP_READ | CAP_RUNTIME_WRITE;
    case "owner":
      return CAP_READ | CAP_NOTEBOOK_WRITE | CAP_PUBLISH | CAP_MANAGE_ACL;
  }
}
