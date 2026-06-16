CREATE TABLE IF NOT EXISTS markdown_document_invites (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
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
  FOREIGN KEY (document_id) REFERENCES markdown_documents(id)
);

CREATE INDEX IF NOT EXISTS markdown_document_invites_pending_lookup_idx
  ON markdown_document_invites(email_normalized, status, provider_hint);

CREATE UNIQUE INDEX IF NOT EXISTS markdown_document_invites_pending_provider_unique_idx
  ON markdown_document_invites(document_id, email_normalized, provider_hint, scope)
  WHERE status = 'pending' AND provider_hint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS markdown_document_invites_pending_wildcard_unique_idx
  ON markdown_document_invites(document_id, email_normalized, scope)
  WHERE status = 'pending' AND provider_hint IS NULL;

CREATE INDEX IF NOT EXISTS markdown_document_invites_document_idx
  ON markdown_document_invites(document_id, status);

CREATE TABLE IF NOT EXISTS markdown_document_access_requests (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  requester_principal TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('editor')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'dismissed')),
  requested_by_actor_label TEXT NOT NULL,
  resolved_by_actor_label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  FOREIGN KEY (document_id) REFERENCES markdown_documents(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS markdown_document_access_requests_pending_unique_idx
  ON markdown_document_access_requests(document_id, requester_principal, scope)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS markdown_document_access_requests_document_idx
  ON markdown_document_access_requests(document_id, status, created_at);

CREATE INDEX IF NOT EXISTS markdown_document_access_requests_requester_idx
  ON markdown_document_access_requests(requester_principal, document_id, created_at);
