import type { Env } from "./cloudflare-types.ts";
import {
  type AuthenticatedConnection,
  type ConnectionScope,
  isAnonymousViewer,
} from "./identity.ts";
import {
  ensureCatalogSchema,
  getMarkdownDocumentAclRowsForPrincipal,
  getMarkdownDocumentRow,
  getPublicMarkdownDocumentAclRows,
  type MarkdownDocumentAclRow,
  type MarkdownDocumentScope,
} from "./storage.ts";

const CAP_READ = 1 << 0;
const CAP_MARKDOWN_WRITE = 1 << 1;
const CAP_PUBLISH = 1 << 2;
const CAP_MANAGE_ACL = 1 << 3;

export class MarkdownAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = "MarkdownAuthorizationError";
  }
}

export async function authorizeMarkdownDocumentAccess(
  env: Env,
  documentId: string,
  identity: AuthenticatedConnection,
  requestedScope: ConnectionScope = identity.scope,
): Promise<AuthenticatedConnection & { scope: MarkdownDocumentScope }> {
  if (!env.DB) {
    throw new MarkdownAuthorizationError("D1 binding DB is not configured", 503);
  }
  if (requestedScope === "runtime_peer") {
    throw new MarkdownAuthorizationError(
      "Markdown documents do not accept runtime_peer scope",
      403,
    );
  }

  await ensureCatalogSchema(env);
  const document = await getMarkdownDocumentRow(env, documentId);
  if (!document) {
    throw new MarkdownAuthorizationError("Markdown document not found", 404);
  }

  if (isAnonymousViewer(identity)) {
    if (requestedScope !== "viewer") {
      throw new MarkdownAuthorizationError("anonymous viewers may only request viewer scope", 403);
    }
    const publicRows = await getPublicMarkdownDocumentAclRows(env, documentId);
    if (!markdownAclRowsCoverScope(publicRows, "viewer")) {
      throw new MarkdownAuthorizationError("Markdown document not found", 404);
    }
    return { ...identity, scope: "viewer" };
  }

  const principalRows = await getMarkdownDocumentAclRowsForPrincipal(
    env,
    documentId,
    identity.principal,
  );
  if (markdownAclRowsCoverScope(principalRows, requestedScope)) {
    return { ...identity, scope: requestedScope };
  }

  const publicRows = await getPublicMarkdownDocumentAclRows(env, documentId);
  if (requestedScope === "viewer" && markdownAclRowsCoverScope(publicRows, "viewer")) {
    return { ...identity, scope: "viewer" };
  }

  throw new MarkdownAuthorizationError(`${identity.principal} cannot access ${documentId}`, 403);
}

export async function authorizeMarkdownDocumentReadWithBestScope(
  env: Env,
  documentId: string,
  identity: AuthenticatedConnection,
): Promise<AuthenticatedConnection & { scope: MarkdownDocumentScope }> {
  const readable = await authorizeMarkdownDocumentAccess(env, documentId, identity, "viewer");
  if (isAnonymousViewer(readable)) {
    return readable;
  }

  const principalRows = await getMarkdownDocumentAclRowsForPrincipal(
    env,
    documentId,
    readable.principal,
  );
  if (markdownAclRowsCoverScope(principalRows, "owner")) {
    return { ...readable, scope: "owner" };
  }
  if (markdownAclRowsCoverScope(principalRows, "editor")) {
    return { ...readable, scope: "editor" };
  }
  return readable;
}

export function markdownAclRowsCoverScope(
  rows: MarkdownDocumentAclRow[],
  requestedScope: MarkdownDocumentScope,
): boolean {
  const granted = rows.reduce((mask, row) => mask | markdownCapabilityMask(row.scope), 0);
  const requested = markdownCapabilityMask(requestedScope);
  return (granted & requested) === requested;
}

export function markdownCapabilityMask(scope: MarkdownDocumentScope): number {
  switch (scope) {
    case "viewer":
      return CAP_READ;
    case "editor":
      return CAP_READ | CAP_MARKDOWN_WRITE;
    case "owner":
      return CAP_READ | CAP_MARKDOWN_WRITE | CAP_PUBLISH | CAP_MANAGE_ACL;
  }
}
