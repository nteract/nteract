CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  owner_principal TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  latest_revision_id TEXT
);

CREATE TABLE IF NOT EXISTS notebook_revisions (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  notebook_heads_hash TEXT NOT NULL,
  runtime_heads_hash TEXT,
  snapshot_key TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
);

CREATE TABLE IF NOT EXISTS notebook_blobs (
  notebook_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  r2_key TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (notebook_id, hash),
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
);

CREATE TABLE IF NOT EXISTS room_events (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  connection_scope TEXT NOT NULL,
  frame_type INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
);
