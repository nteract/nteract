CREATE TABLE IF NOT EXISTS notebook_access_requests (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS notebook_access_requests_pending_unique_idx
  ON notebook_access_requests(notebook_id, requester_principal, scope)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS notebook_access_requests_notebook_idx
  ON notebook_access_requests(notebook_id, status, created_at);

CREATE INDEX IF NOT EXISTS notebook_access_requests_requester_idx
  ON notebook_access_requests(requester_principal, notebook_id, created_at);
