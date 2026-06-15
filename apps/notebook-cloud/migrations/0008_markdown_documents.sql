CREATE TABLE IF NOT EXISTS markdown_documents (
  id TEXT PRIMARY KEY,
  owner_principal TEXT NOT NULL,
  title TEXT,
  body_doc_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  latest_revision_id TEXT
);

CREATE TABLE IF NOT EXISTS markdown_document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  body_heads_hash TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (document_id) REFERENCES markdown_documents(id)
);

CREATE TABLE IF NOT EXISTS markdown_document_acl (
  document_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'public')),
  subject TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('viewer', 'editor', 'owner')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_actor_label TEXT NOT NULL,
  PRIMARY KEY (document_id, subject_kind, subject, scope),
  FOREIGN KEY (document_id) REFERENCES markdown_documents(id),
  CHECK (subject_kind != 'public' OR (subject = 'anonymous' AND scope = 'viewer'))
);

CREATE INDEX IF NOT EXISTS markdown_document_acl_subject_idx
  ON markdown_document_acl (subject_kind, subject, document_id);
