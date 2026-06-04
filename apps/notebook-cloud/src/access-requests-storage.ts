import type { D1Database, D1PreparedStatement, Env } from "./cloudflare-types.ts";
import {
  ensureCatalogSchema,
  type NotebookAccessRequestRow,
  type NotebookAccessRequestStatus,
} from "./storage.ts";

const NOTEBOOK_ACCESS_REQUEST_LIST_LIMIT = 200;

export interface NotebookAccessRequestInput {
  id?: string;
  notebookId: string;
  requesterPrincipal: string;
  actorLabel: string;
  timestamp?: string;
}

export interface NotebookAccessRequestCreateResult {
  request: NotebookAccessRequestRow;
  created: boolean;
}

export async function createNotebookAccessRequest(
  env: Env,
  input: NotebookAccessRequestInput,
): Promise<NotebookAccessRequestCreateResult | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const existing = await getExistingPendingNotebookAccessRequest(env, {
    notebookId: input.notebookId,
    requesterPrincipal: input.requesterPrincipal,
  });
  if (existing) {
    return { request: existing, created: false };
  }

  const requestId = input.id ?? crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO notebook_access_requests (
       id,
       notebook_id,
       requester_principal,
       scope,
       status,
       requested_by_actor_label,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, 'editor', 'pending', ?, ?, ?)`,
    )
      .bind(
        requestId,
        input.notebookId,
        input.requesterPrincipal,
        input.actorLabel,
        timestamp,
        timestamp,
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const raced = await getExistingPendingNotebookAccessRequest(env, {
      notebookId: input.notebookId,
      requesterPrincipal: input.requesterPrincipal,
    });
    if (raced) {
      return { request: raced, created: false };
    }
    throw error;
  }

  const created = await getNotebookAccessRequest(env, input.notebookId, requestId);
  return created ? { request: created, created: true } : null;
}

export async function getNotebookAccessRequest(
  env: Env,
  notebookId: string,
  requestId: string,
): Promise<NotebookAccessRequestRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(accessRequestSelectSql("WHERE notebook_id = ? AND id = ?"))
    .bind(notebookId, requestId)
    .first<NotebookAccessRequestRow>();
}

export async function getLatestNotebookAccessRequestForRequester(
  env: Env,
  input: {
    notebookId: string;
    requesterPrincipal: string;
  },
): Promise<NotebookAccessRequestRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `${accessRequestSelectSql("WHERE notebook_id = ? AND requester_principal = ?")}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
  )
    .bind(input.notebookId, input.requesterPrincipal)
    .first<NotebookAccessRequestRow>();
}

export async function listNotebookAccessRequests(
  env: Env,
  notebookId: string,
): Promise<NotebookAccessRequestRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `${accessRequestSelectSql("WHERE notebook_id = ?")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
  )
    .bind(notebookId, NOTEBOOK_ACCESS_REQUEST_LIST_LIMIT)
    .all<NotebookAccessRequestRow>();
  return rows.results ?? [];
}

export async function resolveNotebookAccessRequest(
  env: Env,
  input: {
    notebookId: string;
    requestId: string;
    status: Exclude<NotebookAccessRequestStatus, "pending">;
    actorLabel: string;
    timestamp?: string;
  },
): Promise<NotebookAccessRequestRow | null> {
  const db = env.DB;
  if (!db) {
    return null;
  }

  await ensureCatalogSchema(env);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const result =
    input.status === "approved"
      ? (
          await db.batch([
            approvedAccessRequestAclInsert(db, input, timestamp),
            accessRequestResolutionUpdate(db, input, timestamp),
          ])
        )[1]
      : await accessRequestResolutionUpdate(db, input, timestamp).run();
  if (d1Changes(result) === 0) {
    return null;
  }

  return await getNotebookAccessRequest(env, input.notebookId, input.requestId);
}

async function getExistingPendingNotebookAccessRequest(
  env: Env,
  input: {
    notebookId: string;
    requesterPrincipal: string;
  },
): Promise<NotebookAccessRequestRow | null> {
  const db = env.DB;
  if (!db) {
    return null;
  }

  return await db
    .prepare(
      `${accessRequestSelectSql(
        "WHERE notebook_id = ? AND requester_principal = ? AND scope = 'editor' AND status = 'pending'",
      )}
       ORDER BY created_at
       LIMIT 1`,
    )
    .bind(input.notebookId, input.requesterPrincipal)
    .first<NotebookAccessRequestRow>();
}

function accessRequestResolutionUpdate(
  db: D1Database,
  input: {
    notebookId: string;
    requestId: string;
    status: Exclude<NotebookAccessRequestStatus, "pending">;
    actorLabel: string;
  },
  timestamp: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE notebook_access_requests
          SET status = ?,
              resolved_by_actor_label = ?,
              resolved_at = ?,
              updated_at = ?
        WHERE notebook_id = ?
          AND id = ?
          AND status = 'pending'`,
    )
    .bind(input.status, input.actorLabel, timestamp, timestamp, input.notebookId, input.requestId);
}

function approvedAccessRequestAclInsert(
  db: D1Database,
  input: {
    notebookId: string;
    requestId: string;
    actorLabel: string;
  },
  timestamp: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notebook_acl (
         notebook_id,
         subject_kind,
         subject,
         scope,
         created_at,
         updated_at,
         created_by_actor_label
       )
       SELECT notebook_id,
              'principal',
              requester_principal,
              scope,
              ?,
              ?,
              ?
         FROM notebook_access_requests
        WHERE notebook_id = ?
          AND id = ?
          AND status = 'pending'
       ON CONFLICT(notebook_id, subject_kind, subject, scope) DO UPDATE SET
         updated_at = excluded.updated_at`,
    )
    .bind(timestamp, timestamp, input.actorLabel, input.notebookId, input.requestId);
}

function accessRequestSelectSql(whereClause: string): string {
  return `SELECT id,
                 notebook_id,
                 requester_principal,
                 scope,
                 status,
                 requested_by_actor_label,
                 resolved_by_actor_label,
                 created_at,
                 updated_at,
                 resolved_at
            FROM notebook_access_requests
            ${whereClause}`;
}

function d1Changes(result: { meta: Record<string, unknown> }): number {
  const changes = result.meta.changes;
  return typeof changes === "number" ? changes : 0;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed/i.test(message);
}
