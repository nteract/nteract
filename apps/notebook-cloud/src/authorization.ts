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

export async function authorizeNotebookAccess(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
  requestedScope: ConnectionScope = identity.scope,
): Promise<AuthenticatedConnection> {
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

    return { ...identity, scope: "viewer" };
  }

  const principalRows = await getNotebookAclRowsForPrincipal(env, notebookId, identity.principal);
  if (!aclRowsCoverScope(principalRows, requestedScope)) {
    throw new AuthorizationError(`${identity.principal} cannot access ${notebookId}`, 403);
  }

  return { ...identity, scope: requestedScope };
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
      return CAP_READ | CAP_NOTEBOOK_WRITE | CAP_RUNTIME_WRITE;
    case "runtime_peer":
      return CAP_READ | CAP_RUNTIME_WRITE;
    case "owner":
      return CAP_READ | CAP_NOTEBOOK_WRITE | CAP_RUNTIME_WRITE | CAP_PUBLISH | CAP_MANAGE_ACL;
  }
}
