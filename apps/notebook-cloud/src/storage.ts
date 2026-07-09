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
  cell_composition: string | null;
  preview_cells: string | null;
  cover_blob_hash?: string | null;
  cover_mime?: string | null;
  language: string | null;
}

export interface RevisionRow {
  id: string;
  notebook_id: string;
  runtime_state_doc_id: string | null;
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  comms_heads_hash: string | null;
  comments_heads_hash: string | null;
  snapshot_key: string;
  runtime_snapshot_key: string | null;
  comms_snapshot_key: string | null;
  comments_snapshot_key: string | null;
  cover_blob_hash: string | null;
  cover_mime: string | null;
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

export interface ListedNotebookRow extends NotebookRow {
  scope: NotebookAclRow["scope"];
}

export interface ListedNotebookPage {
  notebooks: ListedNotebookRow[];
  totalCount: number;
}

export interface NotebookRoomSummaryOccupant {
  participant_key: string;
  actor_label: string;
  display_name?: string;
  connection_scope: AuthenticatedConnection["scope"];
}

export interface NotebookRoomSummary {
  version: 1;
  notebook_id: string;
  occupants: NotebookRoomSummaryOccupant[];
  updated_at: string;
}

export interface NotebookAclInput {
  notebookId: string;
  subjectKind: NotebookAclRow["subject_kind"];
  subject: string;
  scope: NotebookAclRow["scope"];
  actorLabel: string;
}

export type NotebookAccessRequestStatus = "pending" | "approved" | "denied" | "dismissed";

export interface NotebookAccessRequestRow {
  id: string;
  notebook_id: string;
  requester_principal: string;
  scope: "editor";
  status: NotebookAccessRequestStatus;
  requested_by_actor_label: string;
  resolved_by_actor_label: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface PrincipalAccountLinkRow {
  transport_principal: string;
  canonical_principal: string;
  provider: string;
  email_normalized: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export type WorkstationStatus = "online" | "offline" | "connecting" | "attention" | "unknown";

export type WorkstationAttachJobStatus =
  | "pending"
  | "accepted"
  | "running"
  | "failed"
  | "completed"
  | "cancelled";

export type WorkstationAttachJobTrigger = "user_attach" | "resume";

export const WORKSTATION_ATTACH_JOB_STALE_MS = 2 * 60_000;
// Pending jobs cover host cold start before the agent accepts the request; give
// a slow host one extra minute beyond the accepted/running heartbeat timeout.
export const WORKSTATION_ATTACH_PENDING_STALE_MS = 3 * 60_000;

export interface WorkstationRow {
  owner_principal: string;
  workstation_id: string;
  display_name: string;
  provider: string;
  provider_label: string | null;
  status: WorkstationStatus;
  status_message: string | null;
  default_environment_label: string | null;
  environment_policy: string | null;
  working_directory: string | null;
  cpu_count: number | null;
  memory_bytes: number | null;
  environments_json: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface WorkstationRegistrationInput {
  workstationId: string;
  displayName: string;
  provider?: string | null;
  providerLabel?: string | null;
  statusMessage?: string | null;
  defaultEnvironmentLabel?: string | null;
  environmentPolicy?: string | null;
  workingDirectory?: string | null;
  cpuCount?: number | null;
  memoryBytes?: number | null;
  environmentsJson?: string | null;
}

export interface WorkstationAttachJobRow {
  id: string;
  notebook_id: string;
  owner_principal: string;
  workstation_id: string;
  status: WorkstationAttachJobStatus;
  trigger: WorkstationAttachJobTrigger;
  requested_by_actor_label: string;
  requested_at: string;
  updated_at: string;
  accepted_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

export interface CreateWorkstationAttachJobResult {
  job: WorkstationAttachJobRow;
  cancelledActiveJob: WorkstationAttachJobRow | null;
}

export interface ListActiveWorkstationAttachJobsResult {
  jobs: WorkstationAttachJobRow[];
  expiredPendingJobs: WorkstationAttachJobRow[];
}

const WORKSTATION_ATTACH_JOBS_DROP_LEGACY_ACTIVE_UNIQUE_INDEX = `DROP INDEX IF EXISTS workstation_attach_jobs_active_unique_idx`;

const WORKSTATION_ATTACH_JOBS_DEDUPE_ACTIVE_OWNER = `UPDATE workstation_attach_jobs
   SET status = 'cancelled',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       error_message = 'cancelled by active workstation attach job uniqueness migration'
 WHERE status IN ('pending', 'accepted', 'running')
   AND id IN (
     SELECT id
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY notebook_id, owner_principal
                  ORDER BY requested_at DESC, updated_at DESC, id DESC
                ) AS active_rank
           FROM workstation_attach_jobs
          WHERE status IN ('pending', 'accepted', 'running')
       )
      WHERE active_rank > 1
   );`;

const WORKSTATION_ATTACH_JOBS_ACTIVE_UNIQUE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS workstation_attach_jobs_active_owner_unique_idx
    ON workstation_attach_jobs(notebook_id, owner_principal)
    WHERE status IN ('pending', 'accepted', 'running')`;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    owner_principal TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    latest_revision_id TEXT,
    cell_composition TEXT,
    preview_cells TEXT,
    language TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notebook_revisions (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    runtime_state_doc_id TEXT,
    notebook_heads_hash TEXT NOT NULL,
    runtime_heads_hash TEXT,
    comms_heads_hash TEXT,
    comments_heads_hash TEXT,
    snapshot_key TEXT NOT NULL,
    runtime_snapshot_key TEXT,
    comms_snapshot_key TEXT,
    comments_snapshot_key TEXT,
    cover_blob_hash TEXT,
    cover_mime TEXT,
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
  `CREATE TABLE IF NOT EXISTS principal_account_links (
    transport_principal TEXT PRIMARY KEY,
    canonical_principal TEXT NOT NULL,
    provider TEXT NOT NULL,
    email_normalized TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS principal_account_links_canonical_idx
    ON principal_account_links(canonical_principal)`,
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
  `CREATE TABLE IF NOT EXISTS notebook_access_requests (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    requester_principal TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('editor')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'dismissed')),
    requested_by_actor_label TEXT NOT NULL,
    resolved_by_actor_label TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notebook_access_requests_pending_unique_idx
    ON notebook_access_requests(notebook_id, requester_principal, scope)
    WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS notebook_access_requests_notebook_idx
    ON notebook_access_requests(notebook_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS notebook_access_requests_requester_idx
    ON notebook_access_requests(requester_principal, notebook_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS workstations (
    owner_principal TEXT NOT NULL,
    workstation_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'runtime_peer',
    provider_label TEXT,
    status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'connecting', 'attention', 'unknown')),
    status_message TEXT,
    default_environment_label TEXT,
    environment_policy TEXT,
    working_directory TEXT,
    cpu_count INTEGER,
    memory_bytes INTEGER,
    environments_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT,
    PRIMARY KEY (owner_principal, workstation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS workstations_owner_updated_idx
    ON workstations(owner_principal, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS workstation_defaults (
    owner_principal TEXT PRIMARY KEY,
    workstation_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS workstation_attach_jobs (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    owner_principal TEXT NOT NULL,
    workstation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'running', 'failed', 'completed', 'cancelled')),
    trigger TEXT NOT NULL DEFAULT 'user_attach',
    requested_by_actor_label TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    accepted_at TEXT,
    finished_at TEXT,
    error_message TEXT,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
  )`,
  WORKSTATION_ATTACH_JOBS_DEDUPE_ACTIVE_OWNER,
  WORKSTATION_ATTACH_JOBS_DROP_LEGACY_ACTIVE_UNIQUE_INDEX,
  WORKSTATION_ATTACH_JOBS_ACTIVE_UNIQUE_INDEX,
  `CREATE INDEX IF NOT EXISTS workstation_attach_jobs_poll_idx
    ON workstation_attach_jobs(owner_principal, workstation_id, status, requested_at)`,
  `CREATE TABLE IF NOT EXISTS workstation_pairing_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    owner_principal TEXT NOT NULL,
    principal_namespace TEXT NOT NULL,
    created_by_actor_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    redeemed_by_credential_id TEXT,
    workstation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS workstation_pairing_codes_owner_idx
    ON workstation_pairing_codes(owner_principal, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS workstation_credentials (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    owner_principal TEXT NOT NULL,
    principal_namespace TEXT NOT NULL,
    pairing_code_id TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS workstation_credentials_owner_idx
    ON workstation_credentials(owner_principal, created_at DESC)`,
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
  {
    table: "notebook_revisions",
    column: "comms_heads_hash",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN comms_heads_hash TEXT`,
  },
  {
    table: "notebook_revisions",
    column: "comms_snapshot_key",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN comms_snapshot_key TEXT`,
  },
  {
    table: "notebook_revisions",
    column: "comments_heads_hash",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN comments_heads_hash TEXT`,
  },
  {
    table: "notebook_revisions",
    column: "comments_snapshot_key",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN comments_snapshot_key TEXT`,
  },
  {
    table: "notebook_revisions",
    column: "cover_blob_hash",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN cover_blob_hash TEXT`,
  },
  {
    table: "notebook_revisions",
    column: "cover_mime",
    statement: `ALTER TABLE notebook_revisions ADD COLUMN cover_mime TEXT`,
  },
  {
    table: "workstation_attach_jobs",
    column: "trigger",
    statement: `ALTER TABLE workstation_attach_jobs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'user_attach'`,
  },
  {
    table: "notebooks",
    column: "cell_composition",
    statement: `ALTER TABLE notebooks ADD COLUMN cell_composition TEXT`,
  },
  {
    table: "notebooks",
    column: "preview_cells",
    statement: `ALTER TABLE notebooks ADD COLUMN preview_cells TEXT`,
  },
  {
    table: "notebooks",
    column: "language",
    statement: `ALTER TABLE notebooks ADD COLUMN language TEXT`,
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

export function commsDocSnapshotKey(runtimeStateDocId: string, headsHash: string): string {
  return documentSnapshotKey(`comms:${runtimeStateDocId}`, headsHash);
}

export function blobKey(notebookId: string, hash: string): string {
  return `n/${encodePathComponent(notebookId)}/blobs/${encodePathComponent(hash)}`;
}

export function roomSummaryKey(notebookId: string): string {
  return `n/${encodePathComponent(notebookId)}/room-summary.json`;
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
  for (const statement of SCHEMA_STATEMENTS) {
    await env.DB!.prepare(statement).run();
  }
  await runCatalogMigrations(env);
  await backfillNotebookAcl(env);
}

export async function runCatalogMigrations(env: Env): Promise<void> {
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
    `SELECT id,
            owner_principal,
            title,
            created_at,
            updated_at,
            latest_revision_id,
            cell_composition,
            preview_cells,
            language
       FROM notebooks
       WHERE id = ?`,
  )
    .bind(notebookId)
    .first<NotebookRow>();
}

export async function getPublicPublishedNotebookRow(
  env: Env,
  notebookId: string,
): Promise<NotebookRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `SELECT n.id,
            n.owner_principal,
            n.title,
            n.created_at,
            n.updated_at,
            n.latest_revision_id,
            n.cell_composition,
            n.preview_cells,
            n.language
       FROM notebooks n
       JOIN notebook_acl a
         ON a.notebook_id = n.id
      WHERE n.id = ?
        AND n.latest_revision_id IS NOT NULL
        AND a.subject_kind = 'public'
        AND a.subject = 'anonymous'
        AND a.scope = 'viewer'
      LIMIT 1`,
  )
    .bind(notebookId)
    .first<NotebookRow>();
}

export async function updateNotebookTitle(
  env: Env,
  notebookId: string,
  title: string | null,
): Promise<NotebookRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const updatedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE notebooks
        SET title = ?,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(title, updatedAt, notebookId)
    .run();
  if (d1Changes(result) === 0) {
    return null;
  }
  return await getNotebookRow(env, notebookId);
}

export async function updateNotebookSnapshotSummary(
  env: Env,
  notebookId: string,
  summary: {
    cellComposition: {
      code: number;
      markdown: number;
      raw: number;
    };
    language: string | null;
    previewCells: Array<{ kind: "markdown" | "code"; text: string; execution_count?: number }>;
  },
): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  await env.DB.prepare(
    `UPDATE notebooks
        SET cell_composition = ?,
            preview_cells = ?,
            language = ?
      WHERE id = ?`,
  )
    .bind(
      JSON.stringify(summary.cellComposition),
      JSON.stringify(summary.previewCells),
      summary.language,
      notebookId,
    )
    .run();
}

export async function updateNotebookRevisionCover(
  env: Env,
  revisionId: string,
  cover: { blobHash: string; mime: string },
): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  await env.DB.prepare(
    `UPDATE notebook_revisions
        SET cover_blob_hash = ?,
            cover_mime = ?
      WHERE id = ?`,
  )
    .bind(cover.blobHash, cover.mime, revisionId)
    .run();
}

export async function getNotebookRevisionRow(
  env: Env,
  notebookId: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return await env.DB.prepare(
    `SELECT id,
            notebook_id,
            runtime_state_doc_id,
            notebook_heads_hash,
            runtime_heads_hash,
            comms_heads_hash,
            comments_heads_hash,
            snapshot_key,
            runtime_snapshot_key,
            comms_snapshot_key,
            comments_snapshot_key,
            cover_blob_hash,
            cover_mime,
            actor_label,
            created_at
       FROM notebook_revisions
       WHERE notebook_id = ?
         AND id = ?
       LIMIT 1`,
  )
    .bind(notebookId, revisionId)
    .first<RevisionRow>();
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
         AND (
           subject = ?
           OR subject IN (
             SELECT canonical_principal
               FROM principal_account_links
              WHERE transport_principal = ?
           )
         )
       ORDER BY scope`,
  )
    .bind(notebookId, principal, principal)
    .all<NotebookAclRow>();
  return rows.results ?? [];
}

export async function listNotebooksForPrincipal(
  env: Env,
  principal: string,
  limit: number,
): Promise<ListedNotebookPage> {
  if (!env.DB) {
    return { notebooks: [], totalCount: 0 };
  }

  await ensureCatalogSchema(env);
  const visibility = notebookPrincipalVisibilityPredicate(principal);
  const rows = await env.DB.prepare(
    `SELECT n.id,
            n.owner_principal,
            n.title,
            n.created_at,
            n.updated_at,
            n.latest_revision_id,
            n.cell_composition,
            n.preview_cells,
            r.cover_blob_hash,
            r.cover_mime,
            n.language,
            CASE MAX(
              CASE a.scope
                WHEN 'owner' THEN 4
                WHEN 'editor' THEN 3
                WHEN 'runtime_peer' THEN 2
                WHEN 'viewer' THEN 1
                ELSE 0
              END
            )
              WHEN 4 THEN 'owner'
              WHEN 3 THEN 'editor'
              WHEN 2 THEN 'runtime_peer'
              ELSE 'viewer'
            END AS scope
       FROM notebooks n
       JOIN notebook_acl a
         ON a.notebook_id = n.id
       LEFT JOIN notebook_revisions r
         ON r.id = n.latest_revision_id
      WHERE ${visibility.sql}
      GROUP BY n.id,
               n.owner_principal,
               n.title,
               n.created_at,
               n.updated_at,
               n.latest_revision_id,
               n.cell_composition,
               n.preview_cells,
               r.cover_blob_hash,
               r.cover_mime,
               n.language
      ORDER BY n.updated_at DESC, n.created_at DESC, n.id DESC
      LIMIT ?`,
  )
    .bind(...visibility.bindings, limit)
    .all<ListedNotebookRow>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total_count
       FROM (
         SELECT n.id
           FROM notebooks n
           JOIN notebook_acl a
             ON a.notebook_id = n.id
          WHERE ${visibility.sql}
          GROUP BY n.id
       ) visible_notebooks`,
  )
    .bind(...visibility.bindings)
    .first<{ total_count: number }>();
  const totalCount = Number(count?.total_count ?? rows.results?.length ?? 0);
  return {
    notebooks: rows.results ?? [],
    totalCount: Number.isFinite(totalCount) ? totalCount : (rows.results ?? []).length,
  };
}

function notebookPrincipalVisibilityPredicate(principal: string): {
  bindings: [string, string];
  sql: string;
} {
  return {
    bindings: [principal, principal],
    sql: `a.subject_kind = 'principal'
        AND (
          a.subject = ?
          OR a.subject IN (
            SELECT canonical_principal
              FROM principal_account_links
             WHERE transport_principal = ?
          )
        )`,
  };
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

export async function registerWorkstation(
  env: Env,
  ownerPrincipal: string,
  input: WorkstationRegistrationInput,
): Promise<WorkstationRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO workstations (
       owner_principal,
       workstation_id,
       display_name,
       provider,
       provider_label,
       status,
       status_message,
       default_environment_label,
       environment_policy,
       working_directory,
       cpu_count,
       memory_bytes,
       environments_json,
       created_at,
       updated_at,
       last_seen_at
     ) VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_principal, workstation_id) DO UPDATE SET
       display_name = excluded.display_name,
       provider = excluded.provider,
       provider_label = excluded.provider_label,
       status = excluded.status,
       status_message = excluded.status_message,
       default_environment_label = excluded.default_environment_label,
       environment_policy = excluded.environment_policy,
       working_directory = excluded.working_directory,
       cpu_count = excluded.cpu_count,
       memory_bytes = excluded.memory_bytes,
       environments_json = excluded.environments_json,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(
      ownerPrincipal,
      input.workstationId,
      input.displayName,
      input.provider ?? "runtime_peer",
      input.providerLabel ?? null,
      input.statusMessage ?? null,
      input.defaultEnvironmentLabel ?? null,
      input.environmentPolicy ?? null,
      input.workingDirectory ?? null,
      input.cpuCount ?? null,
      input.memoryBytes ?? null,
      input.environmentsJson ?? null,
      now,
      now,
      now,
    )
    .run();
  return getWorkstationRow(env, ownerPrincipal, input.workstationId);
}

export async function getWorkstationRow(
  env: Env,
  ownerPrincipal: string,
  workstationId: string,
): Promise<WorkstationRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  return env.DB.prepare(
    `SELECT owner_principal,
            workstation_id,
            display_name,
            provider,
            provider_label,
            status,
            status_message,
            default_environment_label,
            environment_policy,
            working_directory,
            cpu_count,
            memory_bytes,
            environments_json,
            created_at,
            updated_at,
            last_seen_at
       FROM workstations
      WHERE owner_principal = ?
        AND workstation_id = ?`,
  )
    .bind(ownerPrincipal, workstationId)
    .first<WorkstationRow>();
}

export async function listWorkstationsForPrincipal(
  env: Env,
  ownerPrincipal: string,
): Promise<WorkstationRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(
    `SELECT owner_principal,
            workstation_id,
            display_name,
            provider,
            provider_label,
            status,
            status_message,
            default_environment_label,
            environment_policy,
            working_directory,
            cpu_count,
            memory_bytes,
            environments_json,
            created_at,
            updated_at,
            last_seen_at
       FROM workstations
      WHERE owner_principal = ?
      ORDER BY last_seen_at DESC, updated_at DESC, workstation_id`,
  )
    .bind(ownerPrincipal)
    .all<WorkstationRow>();
  return rows.results ?? [];
}

export async function getDefaultWorkstationId(
  env: Env,
  ownerPrincipal: string,
): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const row = await env.DB.prepare(
    `SELECT workstation_id
       FROM workstation_defaults
      WHERE owner_principal = ?`,
  )
    .bind(ownerPrincipal)
    .first<Pick<WorkstationRow, "workstation_id">>();
  return row?.workstation_id ?? null;
}

export async function setDefaultWorkstation(
  env: Env,
  ownerPrincipal: string,
  workstationId: string,
): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const workstation = await getWorkstationRow(env, ownerPrincipal, workstationId);
  if (!workstation) {
    return null;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO workstation_defaults (owner_principal, workstation_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(owner_principal) DO UPDATE SET
       workstation_id = excluded.workstation_id,
       updated_at = excluded.updated_at`,
  )
    .bind(ownerPrincipal, workstationId, now)
    .run();
  return workstationId;
}

export async function createWorkstationAttachJob(
  env: Env,
  input: {
    notebookId: string;
    ownerPrincipal: string;
    replaceActive?: boolean;
    trigger?: WorkstationAttachJobTrigger;
    workstationId: string;
    actorLabel: string;
  },
): Promise<CreateWorkstationAttachJobResult | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - WORKSTATION_ATTACH_JOB_STALE_MS).toISOString();
  const pendingStaleBefore = new Date(
    now.getTime() - WORKSTATION_ATTACH_PENDING_STALE_MS,
  ).toISOString();
  const trigger = input.trigger ?? "user_attach";
  if (!isWorkstationAttachJobTrigger(trigger)) {
    throw new Error(`invalid workstation attach job trigger: ${trigger}`);
  }
  await expireStaleWorkstationAttachJobs(
    env,
    { notebookId: input.notebookId, ownerPrincipal: input.ownerPrincipal },
    {
      now: nowIso,
      pendingStaleBefore,
      staleBefore,
    },
  );
  let cancelledActiveJob: WorkstationAttachJobRow | null = null;
  let activeJobToCancel: WorkstationAttachJobRow | null = null;

  const existing = await getActiveWorkstationAttachJob(env, input, {
    pendingStaleBefore,
    staleBefore,
  });
  if (existing) {
    if (input.replaceActive !== true && existing.workstation_id === input.workstationId) {
      const job = await upgradeDedupedAttachJobTriggerToUserAttach(env, existing, trigger, nowIso);
      return { job, cancelledActiveJob: null };
    }
    cancelledActiveJob = existing;
    activeJobToCancel = existing;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const jobId = crypto.randomUUID();
    const insert = env.DB.prepare(
      `INSERT INTO workstation_attach_jobs (
       id,
       notebook_id,
       owner_principal,
       workstation_id,
       status,
       trigger,
       requested_by_actor_label,
       requested_at,
       updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).bind(
      jobId,
      input.notebookId,
      input.ownerPrincipal,
      input.workstationId,
      trigger,
      input.actorLabel,
      nowIso,
      nowIso,
    );
    try {
      if (activeJobToCancel) {
        await env.DB.batch([
          cancelActiveWorkstationAttachJobsStatement(env, input, {
            now: nowIso,
            errorMessage: "replaced by a newer workstation attach request",
          }),
          insert,
        ]);
      } else {
        await insert.run();
      }
      const job = await getWorkstationAttachJob(
        env,
        input.ownerPrincipal,
        input.workstationId,
        jobId,
      );
      if (!job) {
        throw new Error("workstation attach job insert did not return a row");
      }
      return { job, cancelledActiveJob };
    } catch (error) {
      const racedExisting = await getActiveWorkstationAttachJob(env, input, {
        pendingStaleBefore,
        staleBefore,
      });
      if (!racedExisting || attempt > 0) {
        throw error;
      }
      if (input.replaceActive !== true && racedExisting.workstation_id === input.workstationId) {
        const job = await upgradeDedupedAttachJobTriggerToUserAttach(
          env,
          racedExisting,
          trigger,
          nowIso,
        );
        return { job, cancelledActiveJob };
      }
      cancelledActiveJob ??= racedExisting;
      activeJobToCancel = racedExisting;
    }
  }
  throw new Error("workstation attach job was not created");
}

export async function listActiveWorkstationAttachJobs(
  env: Env,
  ownerPrincipal: string,
  workstationId: string,
  limit = 10,
): Promise<ListActiveWorkstationAttachJobsResult> {
  if (!env.DB) {
    return { jobs: [], expiredPendingJobs: [] };
  }

  await ensureCatalogSchema(env);
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - WORKSTATION_ATTACH_JOB_STALE_MS).toISOString();
  const pendingStaleBefore = new Date(
    now.getTime() - WORKSTATION_ATTACH_PENDING_STALE_MS,
  ).toISOString();
  const expiredPendingJobs = await expireStaleWorkstationAttachJobs(
    env,
    { ownerPrincipal, workstationId },
    { now: nowIso, pendingStaleBefore, staleBefore },
  );
  const rows = await env.DB.prepare(
    `SELECT id,
            notebook_id,
            owner_principal,
            workstation_id,
            status,
            trigger,
            requested_by_actor_label,
            requested_at,
            updated_at,
            accepted_at,
            finished_at,
            error_message
       FROM workstation_attach_jobs
      WHERE owner_principal = ?
        AND workstation_id = ?
        AND (
          (status = 'pending' AND requested_at >= ?)
          OR (status IN ('accepted', 'running') AND updated_at >= ?)
        )
      ORDER BY requested_at ASC
      LIMIT ?`,
  )
    .bind(ownerPrincipal, workstationId, pendingStaleBefore, staleBefore, limit)
    .all<WorkstationAttachJobRow>();
  return {
    jobs: rows.results ?? [],
    expiredPendingJobs,
  };
}

export async function updateWorkstationAttachJobStatus(
  env: Env,
  input: {
    ownerPrincipal: string;
    workstationId: string;
    jobId: string;
    status: WorkstationAttachJobStatus;
    errorMessage?: string | null;
  },
): Promise<WorkstationAttachJobRow | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE workstation_attach_jobs
        SET status = ?,
            updated_at = ?,
            accepted_at = CASE
              WHEN ? IN ('accepted', 'running') AND accepted_at IS NULL THEN ?
              ELSE accepted_at
            END,
            finished_at = CASE
              WHEN ? IN ('failed', 'completed', 'cancelled') THEN ?
              ELSE finished_at
            END,
            error_message = ?
      WHERE id = ?
        AND owner_principal = ?
        AND workstation_id = ?
        AND status IN ('pending', 'accepted', 'running')
        AND CASE status
              WHEN 'pending' THEN 0
              WHEN 'accepted' THEN 1
              WHEN 'running' THEN 2
              ELSE 3
            END <= ?`,
  )
    .bind(
      input.status,
      now,
      input.status,
      now,
      input.status,
      now,
      input.errorMessage ?? null,
      input.jobId,
      input.ownerPrincipal,
      input.workstationId,
      workstationAttachJobStatusRank(input.status),
    )
    .run();
  return getWorkstationAttachJob(env, input.ownerPrincipal, input.workstationId, input.jobId);
}

export async function failActiveWorkstationAttachJobsForWorkstation(
  env: Env,
  input: {
    ownerPrincipal: string;
    workstationId: string;
    errorMessage: string;
    now?: string;
  },
): Promise<WorkstationAttachJobRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const now = input.now ?? new Date().toISOString();
  const failed = await env.DB.prepare(
    `UPDATE workstation_attach_jobs
        SET status = 'failed',
            updated_at = ?,
            finished_at = ?,
            error_message = ?
      WHERE owner_principal = ?
        AND workstation_id = ?
        AND status IN ('pending', 'accepted', 'running')
      RETURNING id,
                notebook_id,
                owner_principal,
                workstation_id,
                status,
                trigger,
                requested_by_actor_label,
                requested_at,
                updated_at,
                accepted_at,
                finished_at,
                error_message`,
  )
    .bind(now, now, input.errorMessage, input.ownerPrincipal, input.workstationId)
    .all<WorkstationAttachJobRow>();
  return failed.results ?? [];
}

function workstationAttachJobStatusRank(status: WorkstationAttachJobStatus): number {
  switch (status) {
    case "pending":
      return 0;
    case "accepted":
      return 1;
    case "running":
      return 2;
    case "failed":
    case "completed":
    case "cancelled":
      return 3;
  }
}

async function getActiveWorkstationAttachJob(
  env: Env,
  input: {
    notebookId: string;
    ownerPrincipal: string;
  },
  {
    pendingStaleBefore,
    staleBefore,
  }: {
    pendingStaleBefore: string;
    staleBefore: string;
  },
): Promise<WorkstationAttachJobRow | null> {
  const row = await env
    .DB!.prepare(
      `SELECT id,
            notebook_id,
            owner_principal,
            workstation_id,
            status,
            trigger,
            requested_by_actor_label,
            requested_at,
            updated_at,
            accepted_at,
            finished_at,
            error_message
       FROM workstation_attach_jobs
      WHERE notebook_id = ?
        AND owner_principal = ?
        AND (
          (status = 'pending' AND requested_at >= ?)
          OR (status IN ('accepted', 'running') AND updated_at >= ?)
        )
      ORDER BY requested_at DESC
      LIMIT 1`,
    )
    .bind(input.notebookId, input.ownerPrincipal, pendingStaleBefore, staleBefore)
    .first<WorkstationAttachJobRow>();
  return row;
}

async function upgradeDedupedAttachJobTriggerToUserAttach(
  env: Env,
  job: WorkstationAttachJobRow,
  requestedTrigger: WorkstationAttachJobTrigger,
  now: string,
): Promise<WorkstationAttachJobRow> {
  if (requestedTrigger !== "user_attach" || job.trigger === "user_attach") {
    return job;
  }
  await env
    .DB!.prepare(
      `UPDATE workstation_attach_jobs
          SET trigger = 'user_attach',
              updated_at = ?
        WHERE id = ?
          AND owner_principal = ?
          AND workstation_id = ?
          AND trigger = 'resume'
          AND status IN ('pending', 'accepted', 'running')`,
    )
    .bind(now, job.id, job.owner_principal, job.workstation_id)
    .run();
  return (
    (await getWorkstationAttachJob(env, job.owner_principal, job.workstation_id, job.id)) ?? job
  );
}

async function expireStaleWorkstationAttachJobs(
  env: Env,
  input: {
    notebookId?: string;
    ownerPrincipal: string;
    workstationId?: string;
  },
  {
    now,
    pendingStaleBefore,
    staleBefore,
  }: {
    now: string;
    pendingStaleBefore: string;
    staleBefore: string;
  },
): Promise<WorkstationAttachJobRow[]> {
  await env
    .DB!.prepare(
      `UPDATE workstation_attach_jobs
          SET status = 'failed',
              updated_at = ?,
              finished_at = ?,
              error_message = 'stale workstation attach job expired after heartbeat timeout'
        WHERE (? IS NULL OR notebook_id = ?)
          AND owner_principal = ?
          AND (? IS NULL OR workstation_id = ?)
          AND status IN ('accepted', 'running')
          AND updated_at < ?`,
    )
    .bind(
      now,
      now,
      input.notebookId ?? null,
      input.notebookId ?? null,
      input.ownerPrincipal,
      input.workstationId ?? null,
      input.workstationId ?? null,
      staleBefore,
    )
    .run();
  const expiredPending = await env
    .DB!.prepare(
      `UPDATE workstation_attach_jobs
          SET status = 'failed',
              updated_at = ?,
              finished_at = ?,
              error_message = 'stale workstation attach job expired before host accepted the request'
        WHERE (? IS NULL OR notebook_id = ?)
          AND owner_principal = ?
          AND (? IS NULL OR workstation_id = ?)
          AND status = 'pending'
          AND requested_at < ?
        RETURNING id,
                  notebook_id,
                  owner_principal,
                  workstation_id,
                  status,
                  trigger,
                  requested_by_actor_label,
                  requested_at,
                  updated_at,
                  accepted_at,
                  finished_at,
                  error_message`,
    )
    .bind(
      now,
      now,
      input.notebookId ?? null,
      input.notebookId ?? null,
      input.ownerPrincipal,
      input.workstationId ?? null,
      input.workstationId ?? null,
      pendingStaleBefore,
    )
    .all<WorkstationAttachJobRow>();
  return expiredPending.results ?? [];
}

function cancelActiveWorkstationAttachJobsStatement(
  env: Env,
  input: {
    notebookId: string;
    ownerPrincipal: string;
  },
  {
    now,
    errorMessage,
  }: {
    now: string;
    errorMessage: string;
  },
): D1PreparedStatement {
  return env
    .DB!.prepare(
      `UPDATE workstation_attach_jobs
          SET status = 'cancelled',
              updated_at = ?,
              finished_at = ?,
              error_message = ?
        WHERE notebook_id = ?
          AND owner_principal = ?
          AND status IN ('pending', 'accepted', 'running')`,
    )
    .bind(now, now, errorMessage, input.notebookId, input.ownerPrincipal);
}

async function getWorkstationAttachJob(
  env: Env,
  ownerPrincipal: string,
  workstationId: string,
  jobId: string,
): Promise<WorkstationAttachJobRow | null> {
  const row = await env
    .DB!.prepare(
      `SELECT id,
            notebook_id,
            owner_principal,
            workstation_id,
            status,
            trigger,
            requested_by_actor_label,
            requested_at,
            updated_at,
            accepted_at,
            finished_at,
            error_message
       FROM workstation_attach_jobs
      WHERE id = ?
        AND owner_principal = ?
        AND workstation_id = ?`,
    )
    .bind(jobId, ownerPrincipal, workstationId)
    .first<WorkstationAttachJobRow>();
  return row;
}

function isWorkstationAttachJobTrigger(value: string): value is WorkstationAttachJobTrigger {
  return value === "user_attach" || value === "resume";
}

export interface CreateNotebookWithOwnerAclResult {
  ownerPrincipal: string;
  created: boolean;
}

export async function createNotebookWithOwnerAcl(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
  options: { title?: string | null } = {},
): Promise<CreateNotebookWithOwnerAclResult> {
  if (!env.DB) {
    return { ownerPrincipal: identity.principal, created: true };
  }

  await ensureCatalogSchema(env);
  const now = new Date().toISOString();
  const ownerSubject =
    (await getCanonicalPrincipalForTransport(env, identity.principal)) ?? identity.principal;
  const [notebookInsertResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notebooks (id, owner_principal, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
    ).bind(notebookId, ownerSubject, options.title ?? null, now, now),
    notebookOwnerAclInsert(env, {
      notebookId,
      subject: ownerSubject,
      actorLabel: identity.actorLabel,
      timestamp: now,
    }),
  ]);
  return {
    ownerPrincipal: ownerSubject,
    created: d1Changes(notebookInsertResult) > 0,
  };
}

export async function getCanonicalPrincipalForTransport(
  env: Env,
  transportPrincipal: string,
): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  await ensureCatalogSchema(env);
  const row = await env.DB.prepare(
    `SELECT canonical_principal
       FROM principal_account_links
      WHERE transport_principal = ?`,
  )
    .bind(transportPrincipal)
    .first<Pick<PrincipalAccountLinkRow, "canonical_principal">>();
  return row?.canonical_principal ?? null;
}

export async function canonicalizeNotebookAclForPrincipal(
  env: Env,
  input: {
    transportPrincipal: string;
    canonicalPrincipal: string;
    timestamp?: string;
  },
): Promise<void> {
  if (!env.DB || input.transportPrincipal === input.canonicalPrincipal) {
    return;
  }

  await ensureCatalogSchema(env);
  const timestamp = input.timestamp ?? new Date().toISOString();
  await env.DB.batch(
    canonicalizeNotebookAclForPrincipalStatements(env, {
      transportPrincipal: input.transportPrincipal,
      canonicalPrincipal: input.canonicalPrincipal,
      timestamp,
    }),
  );
}

export function canonicalizeNotebookAclForPrincipalStatements(
  env: Env,
  input: {
    transportPrincipal: string;
    canonicalPrincipal: string;
    timestamp: string;
  },
): D1PreparedStatement[] {
  if (!env.DB || input.transportPrincipal === input.canonicalPrincipal) {
    return [];
  }

  return [
    copyNotebookAclForPrincipalStatement(env, {
      sourcePrincipal: input.transportPrincipal,
      targetPrincipal: input.canonicalPrincipal,
      timestamp: input.timestamp,
    }),
    env.DB.prepare(
      `UPDATE notebooks
          SET owner_principal = ?,
              updated_at = ?
        WHERE owner_principal = ?`,
    ).bind(input.canonicalPrincipal, input.timestamp, input.transportPrincipal),
    env.DB.prepare(
      `DELETE FROM notebook_acl
        WHERE subject_kind = 'principal'
          AND subject = ?
          AND EXISTS (
            SELECT 1
              FROM notebook_acl AS target_acl
             WHERE target_acl.notebook_id = notebook_acl.notebook_id
               AND target_acl.subject_kind = 'principal'
               AND target_acl.subject = ?
               AND target_acl.scope = notebook_acl.scope
          )`,
    ).bind(input.transportPrincipal, input.canonicalPrincipal),
  ];
}

export async function copyNotebookAclForPrincipal(
  env: Env,
  input: {
    sourcePrincipal: string;
    targetPrincipal: string;
    timestamp?: string;
  },
): Promise<void> {
  if (!env.DB || input.sourcePrincipal === input.targetPrincipal) {
    return;
  }

  await ensureCatalogSchema(env);
  await copyNotebookAclForPrincipalStatement(env, {
    sourcePrincipal: input.sourcePrincipal,
    targetPrincipal: input.targetPrincipal,
    timestamp: input.timestamp ?? new Date().toISOString(),
  }).run();
}

export function copyNotebookAclForPrincipalStatement(
  env: Env,
  input: {
    sourcePrincipal: string;
    targetPrincipal: string;
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
     SELECT notebook_id,
            'principal',
            ?,
            scope,
            created_at,
            ?,
            created_by_actor_label
       FROM notebook_acl
      WHERE subject_kind = 'principal'
        AND subject = ?
     ON CONFLICT(notebook_id, subject_kind, subject, scope) DO UPDATE SET
       updated_at = excluded.updated_at`,
    )
    .bind(input.targetPrincipal, input.timestamp, input.sourcePrincipal);
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
    commsHeadsHash: string | null;
    commentsHeadsHash?: string | null;
    snapshotKey: string;
    runtimeSnapshotKey: string | null;
    commsSnapshotKey: string | null;
    commentsSnapshotKey?: string | null;
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
       comms_heads_hash,
       comments_heads_hash,
       snapshot_key,
       runtime_snapshot_key,
       comms_snapshot_key,
       comments_snapshot_key,
       actor_label
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      revision.notebookId,
      revision.runtimeStateDocId,
      revision.notebookHeadsHash,
      revision.runtimeHeadsHash,
      revision.commsHeadsHash,
      revision.commentsHeadsHash ?? null,
      revision.snapshotKey,
      revision.runtimeSnapshotKey,
      revision.commsSnapshotKey,
      revision.commentsSnapshotKey ?? null,
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
  // First-writer-wins: blobs are content-addressed, so a duplicate put carries
  // identical bytes and must not rewrite the recorded content_type.
  await env.DB.prepare(
    `INSERT INTO notebook_blobs (
       notebook_id,
       hash,
       size,
       content_type,
       r2_key
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, hash) DO NOTHING`,
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
    `SELECT id,
            owner_principal,
            title,
            created_at,
            updated_at,
            latest_revision_id,
            cell_composition,
            preview_cells,
            language
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
            comms_heads_hash,
            comments_heads_hash,
            snapshot_key,
            runtime_snapshot_key,
            comms_snapshot_key,
            comments_snapshot_key,
            cover_blob_hash,
            cover_mime,
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
