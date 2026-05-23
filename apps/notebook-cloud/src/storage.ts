import type { AuthenticatedConnection } from "./identity.ts";
import type { Env } from "./cloudflare-types.ts";

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

export interface RoomEventRow {
  id: string;
  notebook_id: string;
  peer_id: string;
  actor_label: string;
  connection_scope: string;
  frame_type: number;
  byte_length: number;
  received_at: string;
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
  `CREATE TABLE IF NOT EXISTS room_events (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    connection_scope TEXT NOT NULL,
    frame_type INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
  )`,
];

// Prototype-local schema memo. The Worker binds every room to the same D1
// database; production multi-binding hosts should scope this per binding.
let schemaReady: Promise<void> | undefined;

export function snapshotKey(notebookId: string, headsHash: string): string {
  return `n/${encodePathComponent(notebookId)}/snapshots/${encodePathComponent(headsHash)}.am`;
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

  schemaReady ??= Promise.all(
    SCHEMA_STATEMENTS.map((statement) => env.DB!.prepare(statement).run()),
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaReady = undefined;
      throw error;
    });

  await schemaReady;
}

export async function ensureNotebook(
  env: Env,
  notebookId: string,
  identity: AuthenticatedConnection,
): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  await env.DB.prepare(
    `INSERT INTO notebooks (id, owner_principal, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(notebookId, identity.principal, new Date().toISOString())
    .run();
}

export async function recordRoomEvent(
  env: Env,
  event: {
    notebookId: string;
    peerId: string;
    actorLabel: string;
    connectionScope: string;
    frameType: number;
    byteLength: number;
    receivedAt: string;
  },
): Promise<void> {
  if (!env.DB) {
    return;
  }

  await ensureCatalogSchema(env);
  await env.DB.prepare(
    `INSERT INTO room_events (
       id,
       notebook_id,
       peer_id,
       actor_label,
       connection_scope,
       frame_type,
       byte_length,
       received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      event.notebookId,
      event.peerId,
      event.actorLabel,
      event.connectionScope,
      event.frameType,
      event.byteLength,
      event.receivedAt,
    )
    .run();
}

export async function recordRevision(
  env: Env,
  revision: {
    notebookId: string;
    notebookHeadsHash: string;
    runtimeHeadsHash: string | null;
    snapshotKey: string;
    runtimeSnapshotKey: string | null;
    actorLabel: string;
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
       notebook_heads_hash,
       runtime_heads_hash,
       snapshot_key,
       runtime_snapshot_key,
       actor_label
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      revision.notebookId,
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

export async function listRoomEvents(
  env: Env,
  notebookId: string,
  limit: number,
): Promise<RoomEventRow[]> {
  if (!env.DB) {
    return [];
  }

  await ensureCatalogSchema(env);
  const result = await env.DB.prepare(
    `SELECT id,
            notebook_id,
            peer_id,
            actor_label,
            connection_scope,
            frame_type,
            byte_length,
            received_at
       FROM room_events
       WHERE notebook_id = ?
       ORDER BY received_at DESC
       LIMIT ?`,
  )
    .bind(notebookId, limit)
    .all<RoomEventRow>();

  return result.results ?? [];
}

function encodePathComponent(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "%252F");
}
