import { operationPermission } from "@nteract/pages-client/tools";
import { hash } from "./document.ts";
import { json, object, readBody, requireValue, text, PageError } from "./errors.ts";
import type { ServerSessionEnvironment } from "../../notebook-cloud/src/oidc-session-store.ts";
import { readServerAppSession } from "../../notebook-cloud/src/oidc-session-store.ts";
import type { D1Database } from "../../notebook-cloud/src/cloudflare-types.ts";

export type AgentPermission = "read" | "edit" | "comment";
export interface AgentAccess {
  id: string;
  principal: string;
  display_name: string;
  driver: string;
  page_id: string | null;
  permissions: AgentPermission[];
  expires_at: number | null;
}
export interface AgentGrant extends AgentAccess {
  page_id: string;
  expires_at: number;
}
interface GrantRow {
  token_hash: string;
  context: string;
  grant_json: string;
  expires_at: number;
}
const ready = new WeakMap<D1Database, Promise<void>>();
async function database(env: ServerSessionEnvironment) {
  const db = env.DB;
  if (!db) throw Error("Agent access requires database storage");
  let schema = ready.get(db);
  if (!schema) {
    schema = db
      .prepare(`CREATE TABLE IF NOT EXISTS pages_agent_grants (
      token_hash TEXT PRIMARY KEY, context TEXT NOT NULL, principal TEXT NOT NULL,
      grant_json TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
      .run()
      .then(() => {});
    ready.set(db, schema);
  }
  await schema;
  return db;
}
function context(env: ServerSessionEnvironment) {
  return JSON.stringify([
    env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN,
    env.NOTEBOOK_CLOUD_OIDC_ISSUER,
    env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
  ]);
}
export async function readAgentGrant(
  env: ServerSessionEnvironment,
  request: Request,
  now = Math.floor(Date.now() / 1000),
): Promise<AgentGrant | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer (pages_[a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const db = await database(env);
  const row = await db
    .prepare(
      "SELECT * FROM pages_agent_grants WHERE token_hash = ? AND context = ? AND expires_at > ?",
    )
    .bind(await hash(token), context(env), now)
    .first<GrantRow>();
  return row ? (JSON.parse(row.grant_json) as AgentGrant) : null;
}
export function authorizeAgentOperation(grant: AgentAccess, body: Record<string, unknown>) {
  const args = object(body.arguments ?? {});
  const accountOperation = ["list_spaces", "get_space", "list_pages", "create_page"].includes(
    String(body.operation),
  );
  if (accountOperation && grant.page_id !== null)
    throw new PageError("forbidden", "Connection cannot access account operations", 403);
  if (
    !accountOperation &&
    (typeof args.page_id !== "string" || !/^page_[a-f0-9]{32}$/.test(args.page_id))
  )
    throw new PageError("invalid_request", "Provide an explicit Page ID");
  if (grant.page_id !== null && args.page_id !== grant.page_id)
    throw new PageError("forbidden", "Connection is limited to its approved Page", 403);
  const needed = operationPermission(String(body.operation));
  if (!needed || !grant.permissions.includes(needed))
    throw new PageError("forbidden", "Operation is outside this connection's permissions", 403);
}
export async function manageAgentAccess(
  request: Request,
  env: ServerSessionEnvironment,
  verifyPage: (principal: string, pageId: string) => Promise<void>,
  recheck: (principal: string) => Promise<void>,
) {
  const now = Math.floor(Date.now() / 1000);
  const session = await readServerAppSession(env, request, now);
  if (!session) throw new PageError("unauthorized", "Sign in to manage connections", 401);
  const principal = JSON.stringify([env.NOTEBOOK_CLOUD_OIDC_ISSUER, session.principal]);
  const db = await database(env);
  if (request.method === "GET") {
    const rows = await db
      .prepare(
        "SELECT grant_json FROM pages_agent_grants WHERE principal = ? AND context = ? AND expires_at > ?",
      )
      .bind(principal, context(env), now)
      .all<{ grant_json: string }>();
    return json({ connections: (rows.results ?? []).map((r) => JSON.parse(r.grant_json)) });
  }
  const body = await readBody(request);
  if (request.method === "DELETE") {
    const id = text(body.id, "connection ID", 64);
    // IDs are public metadata; principal/context, not possession of an ID, authorize revocation.
    const rows = await db
      .prepare(
        "SELECT token_hash, grant_json FROM pages_agent_grants WHERE principal = ? AND context = ?",
      )
      .bind(principal, context(env))
      .all<GrantRow>();
    const row = rows.results?.find((r) => (JSON.parse(r.grant_json) as AgentGrant).id === id);
    if (row)
      await db
        .prepare(
          "DELETE FROM pages_agent_grants WHERE token_hash = ? AND principal = ? AND context = ?",
        )
        .bind(row.token_hash, principal, context(env))
        .run();
    await recheck(principal);
    return json({ revoked: true });
  }
  requireValue(request.method === "POST", "method_not_allowed", "Use GET, POST or DELETE");
  const tokenHash = text(body.token_hash, "token hash", 64);
  requireValue(/^[a-f0-9]{64}$/.test(tokenHash), "invalid_request", "Invalid token hash");
  const driver = text(body.driver, "driver", 80).trim();
  requireValue(driver.length > 0, "invalid_request", "Name this connection");
  const pageId = text(body.page_id, "Page ID", 100);
  const permissions = body.permissions;
  requireValue(
    Array.isArray(permissions) &&
      permissions.length > 0 &&
      permissions.length <= 3 &&
      permissions.every((p) => ["read", "edit", "comment"].includes(p)) &&
      permissions.includes("read"),
    "invalid_request",
    "Choose read, edit and/or comment permissions",
  );
  const lifetime = body.expires_in ?? 3600;
  requireValue(
    Number.isInteger(lifetime) && Number(lifetime) >= 60 && Number(lifetime) <= 28800,
    "invalid_request",
    "Connections expire after at most eight hours",
  );
  await verifyPage(principal, pageId);
  await db.prepare("DELETE FROM pages_agent_grants WHERE expires_at <= ?").bind(now).run();
  const count = await db
    .prepare("SELECT COUNT(*) AS total FROM pages_agent_grants WHERE principal = ? AND context = ?")
    .bind(principal, context(env))
    .first<number>("total");
  requireValue((count ?? 0) < 32, "connection_limit", "Revoke an existing connection first");
  const grant: AgentGrant = {
    id: crypto.randomUUID(),
    principal,
    display_name: session.displayName?.trim().slice(0, 160) ?? "",
    driver,
    page_id: pageId,
    permissions: [...new Set(permissions)] as AgentPermission[],
    expires_at: now + Number(lifetime),
  };
  // Never replace an existing token binding, even after a repeated approval.
  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO pages_agent_grants (token_hash, context, principal, grant_json, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(tokenHash, context(env), principal, JSON.stringify(grant), grant.expires_at)
    .run();
  if (Number(inserted.meta.changes) !== 1)
    throw new PageError(
      "connection_exists",
      "This connection request was already used. Start a new one.",
      409,
    );
  return json({ connection: grant }, 201);
}

// UUID-v4 replica actors have a 4 in this nibble. Reserve a disjoint namespace
// for server operations before any grant ID or actor mapping is published.
export async function agentActorId(prefix: string, grantId: string) {
  const suffix = (await hash(`pages-agent-actor-v1:${grantId}`)).slice(0, 32);
  return prefix + suffix.slice(0, 12) + "a" + suffix.slice(13);
}
