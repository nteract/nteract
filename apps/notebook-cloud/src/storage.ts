import type { AuthenticatedConnection } from "./identity.ts";
import type { D1PreparedStatement, Env } from "./cloudflare-types.ts";

export interface NotebookCatalog {
  notebook: NotebookRow;
  revisions: RevisionRow[];
  blobs: BlobRow[];
}

export interface NotebookRow {
  id: string;
  owner_principal: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
}

export interface RevisionRow {
  id: string;
  notebook_id: string;
  runtime_state_doc_id: string | null;
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  snapshot_key: string;
  runtime_snapshot_key: string | null;
  actor_label: string;
  created_at: string;
}

export interface BlobRow {
  notebook_id: string;
  hash: string;
  size: number;
  content_type: string | null;
  r2_key: string;
  uploaded_at: string;
}

export interface NotebookAclRow {
  notebook_id: string;
  subject_kind: "principal" | "public";
  subject: string;
  scope: AuthenticatedConnection["scope"];
  created_at: string;
  updated_at: string;
  created_by_actor_label: string;
}

export interface NotebookAclInput {
  notebookId: string;
  subjectKind: NotebookAclRow["subject_kind"];
  subject: string;
  scope: NotebookAclRow["scope"];
  actorLabel: string;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    owner_principal TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    latest_revision_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notebook_revisions (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    runtime_state_doc_id TEXT,
    notebook_heads_hash TEXT NOT NULL,
    runtime_heads_hash TEXT,
    snapshot_key TEXT NOT NULL,
    runtime_snapshot_key TEXT,
    actor_label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS notebook_blobs (
    notebook_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT,
    r2_key TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (notebook_id, hash),
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS notebook_acl (
    notebook_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'public')),
    subject TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('viewer', 'editor', 'runtime_peer', 'owner')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by_actor_label TEXT NOT NULL,
    PRIMARY KEY (notebook_id, subject_kind, subject, scope),
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id),
    CHECK (subject_kind != 'public' OR (subject = 'anonymous' AND scope = 'viewer'))
  )`,
  `CREATE INDEX IF NOT EXISTS notebook_acl_subject_idx
    ON notebook_acl (subject_kind, subject, notebook_id)`,
  `CREATE TABLE IF NOT EXISTS principal_profiles (
    principal TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_subject TEXT,
    email_normalized TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    avatar_url TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    raw_claims_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS principal_profiles_email_idx
    ON principal_profiles(provider, email_normalized)
    WHERE email_verified = 1`,
  `CREATE TABLE IF NOT EXISTS notebook_invites (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    provider_hint TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('viewer', 'editor')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    invited_by_actor_label TEXT NOT NULL,
    accepted_by_principal TEXT,
    token_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT,
    accepted_at TEXT,
    revoked_at TEXT,
    revoked_by_actor_label TEXT,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS notebook_invites_pending_lookup_idx
    ON notebook_invites(email_normalized, status, provider_hint)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notebook_invites_pending_provider_unique_idx
    ON notebook_invites(notebook_id, email_normalized, provider_hint, scope)
    WHERE status = 'pending' AND provider_hint IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notebook_invites_pending_wildcard_unique_idx
    ON notebook_invites(notebook_id, email_normalized, scope)
    WHERE status = 'pending' AND provider_hint IS NULL`,
  `CREATE INDEX IF NOT EXISTS notebook_invites_notebook_idx
    ON notebook_invites(notebook_id, status)`,
];

const SCHEMA_MIGRATIONS = [
  {
    table: "notebook_revisions",
    column: "runtime_snapshot_key",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN runtime_snapshot_key TEXT`,
  },
  {
    table: "notebook_revisions",
    column: "runtime_state_doc_id",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN runtime_state_doc_id TEXT`,
  },
];

// Prototype-local schema memo. The Worker binds every room to the same D1
// database; production multi-binding hosts should scope this per binding.
let schemaReady: Promise<void> | undefined;

export function snapshotKey(notebookId: string, headsHash: string): string {
  return `n/${encodePathComponent(notebookId)}/snapshots/${encodePathComponent(headsHash)}.am`;
}

export function documentSnapshotKey(documentId: string, headsHash: string): string {
  return `docs/${encodePathComponent(documentId)}/snapshots/${encodePathComponent(headsHash)}.am`;
}

export function runtimeStateSnapshotKey(runtimeStateDocId: string, headsHash: string): string {
  return documentSnapshotKey(runtimeStateDocId, headsHash);
}

export function runtimeSnapshotKey(notebookId: string, headsHash: string): string {
  return `n/${encodePathComponent(notebookId)}/snapshots/runtime-state/${encodePathComponent(headsHash)}.am`;
}

export function blobKey(notebookId: string, hash: string): string {
  return `n/${encodePathComponent(notebookId)}/blobs/${encodePathComponent(hash)}`;
}

export function renderKey(notebookId: string, headsHash: string): string {
  return `n/${encodePathComponent(notebookId)}/renders/${encodePathComponent(headsHash)}.json`;
}

export async function ensureCatalogSchema(env: Env): Promise<void> {
  if (!env.DB) {
    return;
  }

  schemaReady ??= initializeCatalogSchema(env)
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaReady = undefined;
      throw error;
    });

  await schemaReady;
}

async function initializeCatalogSchema(env: Env): Promise<void> {
  await Promise.all(SCHEMA_STATEMENTS.map((statement) => env.DB!.prepare(statement).run()));
  await runCatalogMigrations(env);
  await backfillNotebookAcl(env);
}

async function runCatalogMigrations(env: Env): Promise<void> {
  for (const migration of SCHEMA_MIGRATIONS) {
    if (await tableHasColumn(env, migration.table, migration.column)) {
      continue;
    }
    await env.DB!.prepare(migration.statement).run();
  }
}

async function tableHasColumn(env: Env, table: string, column: string): Promise<boolean> {
  const result = await env.DB!.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results?.some((row) => row.name === column) ?? false;
}

async function backfillNotebookAcl(env: Env): Promise<void> {
  await env
    .DB!.prepare(
      `INSERT OR IGNORE INTO notebook_acl (
       notebook_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
     )
     SELECT id,
            'principal',
            owner_principal,
            'owner',
            created_at,
            updated_at,
            'system/schema:notebook-cloud-owner-acl-backfill'
       FROM notebooks`,
    )
    .run();

  await env
    .DB!.prepare(
      `INSERT OR IGNORE INTO notebook_acl (
       notebook_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
     )
     SELECT id,
            'public',
            'anonymous',
            'viewer',
            created_at,
            updated_at,
            'system/schema:notebook-cloud-public-acl-backfill'
       FROM notebooks
       WHERE latest_revision_id IS NOT NULL`,
    )
    .run();
}

export async function getNotebookRow(env: Env, notebookId: string): Promise<NotebookRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `SELECT id, owner_principal, title, created_at, updated_at, latest_revision_id
       FROM notebooks
       WHERE id = ?`,
  )
    .bind(notebookId)
    .first<NotebookRow>();
}

export async function getNotebookAclRowsForPrincipal(
  env: Env,
  notebookId: string,
  principal: string,
): Promise<NotebookAclRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT notebook_id,
            subject_kind,
            subject,
            scope,
            created_at,
            updated_at,
            created_by_actor_label
       FROM notebook_acl
       WHERE notebook_id = ?
         AND subject_kind = 'principal'
         AND subject = ?
       ORDER BY scope`,
  )
    .bind(notebookId, principal)
    .all<NotebookAclRow>();
  return rows.results ?? [];
}

export async function getPublicNotebookAclRows(
  env: Env,
  notebookId: string,
): Promise<NotebookAclRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT notebook_id,
            subject_kind,
            subject,
            scope,
            created_at,
            updated_at,
            created_by_actor_label
       FROM notebook_acl
       WHERE notebook_id = ?
         AND subject_kind = 'public'
         AND subject = 'anonymous'
       ORDER BY scope`,
  )
    .bind(notebookId)
    .all<NotebookAclRow>();
  return rows.results ?? [];
}

export async function getNotebookAclRows(env: Env, notebookId: string): Promise<NotebookAclRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT notebook_id,
            subject_kind,
            subject,
            scope,
            created_at,
            updated_at,
            created_by_actor_label
       FROM notebook_acl
       WHERE notebook_id = ?
       ORDER BY subject_kind, subject, scope`,
  )
    .bind(notebookId)
    .all<NotebookAclRow>();
  return rows.results ?? [];
}

export async function grantNotebookAclRow(env: Env, row: NotebookAclInput): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  await notebookAclInsert(env, {
    notebookId: row.notebookId,
    subjectKind: row.subjectKind,
    subject: row.subject,
    scope: row.scope,
    actorLabel: row.actorLabel,
    timestamp: new Date().toISOString(),
  }).run();
}

export async function revokeNotebookAclRow(
  env: Env,
  row: Omit<NotebookAclInput, "actorLabel">,
): Promise<boolean> {
  if (!env.DB) {
    return false;
  }

  await ensureCatalogSchema(env);
  const result = await env.DB.prepare(
    `DELETE FROM notebook_acl
       WHERE notebook_id = ?
         AND subject_kind = ?
         AND subject = ?
         AND scope = ?
         AND (
           subject_kind != 'principal'
           OR scope != 'owner'
           OR (
             SELECT COUNT(*)
               FROM notebook_acl
              WHERE notebook_id = ?
                AND subject_kind = 'principal'
                AND scope = 'owner'
                AND subject != ?
           ) > 0
         )`,
  )
    .bind(row.notebookId, row.subjectKind, row.subject, row.scope, row.notebookId, row.subject)
    .run();
  return d1Changes(result) > 0;
}

export async function createNotebookWithOwnerAcl(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notebooks (id, owner_principal, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
    ).bind(notebookId, identity.principal, now, now),
    notebookOwnerAclInsert(env, {
      notebookId,
      subject: identity.principal,
      actorLabel: identity.actorLabel,
      timestamp: now,
    }),
  ]);
}

function notebookAclInsert(
  env: Env,
  row: {
    notebookId: string;
    subjectKind: NotebookAclRow["subject_kind"];
    subject: string;
    scope: NotebookAclRow["scope"];
    actorLabel: string;
    timestamp: string;
  },
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `INSERT INTO notebook_acl (
       notebook_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, subject_kind, subject, scope) DO UPDATE SET
       updated_at = excluded.updated_at`,
    )
    .bind(
      row.notebookId,
      row.subjectKind,
      row.subject,
      row.scope,
      row.timestamp,
      row.timestamp,
      row.actorLabel,
    );
}

function notebookOwnerAclInsert(
  env: Env,
  row: {
    notebookId: string;
    subject: string;
    actorLabel: string;
    timestamp: string;
  },
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `INSERT INTO notebook_acl (
       notebook_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
     )
     SELECT ?, 'principal', ?, 'owner', ?, ?, ?
      WHERE EXISTS (
        SELECT 1
          FROM notebooks
         WHERE id = ?
           AND owner_principal = ?
      )
     ON CONFLICT(notebook_id, subject_kind, subject, scope) DO UPDATE SET
       updated_at = excluded.updated_at`,
    )
    .bind(
      row.notebookId,
      row.subject,
      row.timestamp,
      row.timestamp,
      row.actorLabel,
      row.notebookId,
      row.subject,
    );
}

export async function recordRevision(
  env: Env,
  revision: {
    notebookId: string;
    runtimeStateDocId: string;
    notebookHeadsHash: string;
    runtimeHeadsHash: string | null;
    snapshotKey: string;
    runtimeSnapshotKey: string | null;
    actorLabel: string;
    publishPublic?: boolean;
  },
): Promise<string> {
  if (!env.DB) {
    return crypto.randomUUID();
  }

  await ensureCatalogSchema(env);
  const revisionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notebook_revisions (
       id,
       notebook_id,
       runtime_state_doc_id,
       notebook_heads_hash,
       runtime_heads_hash,
       snapshot_key,
       runtime_snapshot_key,
       actor_label
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      revision.notebookId,
      revision.runtimeStateDocId,
      revision.notebookHeadsHash,
      revision.runtimeHeadsHash,
      revision.snapshotKey,
      revision.runtimeSnapshotKey,
      revision.actorLabel,
    ),
    env.DB.prepare(
      `UPDATE notebooks
       SET latest_revision_id = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(revisionId, createdAt, revision.notebookId),
    ...(revision.publishPublic
      ? [
          notebookAclInsert(env, {
            notebookId: revision.notebookId,
            subjectKind: "public",
            subject: "anonymous",
            scope: "viewer",
            actorLabel: revision.actorLabel,
            timestamp: createdAt,
          }),
        ]
      : []),
  ]);
  return revisionId;
}

export async function recordBlob(
  env: Env,
  blob: {
    notebookId: string;
    hash: string;
    size: number;
    contentType: string | null;
    r2Key: string;
  },
): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  await env.DB.prepare(
    `INSERT INTO notebook_blobs (
       notebook_id,
       hash,
       size,
       content_type,
       r2_key
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, hash) DO UPDATE SET
       size = excluded.size,
       content_type = excluded.content_type,
       r2_key = excluded.r2_key,
       uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(blob.notebookId, blob.hash, blob.size, blob.contentType, blob.r2Key)
    .run();
}

export async function getNotebookCatalog(
  env: Env,
  notebookId: string,
): Promise<NotebookCatalog | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const notebook = await env.DB.prepare(
    `SELECT id, owner_principal, title, created_at, updated_at, latest_revision_id
       FROM notebooks
       WHERE id = ?`,
  )
    .bind(notebookId)
    .first<NotebookRow>();

  if (!notebook) {
    return null;
  }

  const revisions = await env.DB.prepare(
    `SELECT id,
            notebook_id,
            runtime_state_doc_id,
            notebook_heads_hash,
            runtime_heads_hash,
            snapshot_key,
            runtime_snapshot_key,
            actor_label,
            created_at
       FROM notebook_revisions
       WHERE notebook_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
  )
    .bind(notebookId)
    .all<RevisionRow>();

  const blobs = await env.DB.prepare(
    `SELECT notebook_id, hash, size, content_type, r2_key, uploaded_at
       FROM notebook_blobs
       WHERE notebook_id = ?
       ORDER BY uploaded_at DESC
       LIMIT 50`,
  )
    .bind(notebookId)
    .all<BlobRow>();

  return {
    notebook,
    revisions: revisions.results ?? [],
    blobs: blobs.results ?? [],
  };
}

function encodePathComponent(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "%252F");
}

function d1Changes(result: { meta: Record<string, unknown> }): number {
  const changes = result.meta.changes;
  return typeof changes === "number" ? changes : 0;
}
