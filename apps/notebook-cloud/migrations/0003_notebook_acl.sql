CREATE TABLE IF NOT EXISTS notebook_acl (
  notebook_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'public')),
  subject TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('viewer', 'editor', 'runtime_peer', 'owner')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_actor_label TEXT NOT NULL,
  PRIMARY KEY (notebook_id, subject_kind, subject, scope),
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
);

CREATE INDEX IF NOT EXISTS notebook_acl_subject_idx
  ON notebook_acl (subject_kind, subject, notebook_id);

INSERT OR IGNORE INTO notebook_acl (
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
  FROM notebooks;

INSERT OR IGNORE INTO notebook_acl (
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
 WHERE latest_revision_id IS NOT NULL;
