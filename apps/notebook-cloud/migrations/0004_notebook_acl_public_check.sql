DROP TABLE IF EXISTS notebook_acl_new;

CREATE TABLE notebook_acl_new (
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
);

INSERT OR IGNORE INTO notebook_acl_new (
  notebook_id,
  subject_kind,
  subject,
  scope,
  created_at,
  updated_at,
  created_by_actor_label
)
SELECT notebook_id,
       subject_kind,
       subject,
       scope,
       created_at,
       updated_at,
       created_by_actor_label
  FROM notebook_acl
 WHERE subject_kind != 'public'
    OR (subject = 'anonymous' AND scope = 'viewer');

DROP TABLE notebook_acl;

ALTER TABLE notebook_acl_new RENAME TO notebook_acl;

CREATE INDEX IF NOT EXISTS notebook_acl_subject_idx
  ON notebook_acl (subject_kind, subject, notebook_id);
