CREATE TABLE IF NOT EXISTS principal_profiles (
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
);

CREATE INDEX IF NOT EXISTS principal_profiles_email_idx
  ON principal_profiles(provider, email_normalized)
  WHERE email_verified = 1;

CREATE TABLE IF NOT EXISTS notebook_invites (
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
);

CREATE INDEX IF NOT EXISTS notebook_invites_pending_lookup_idx
  ON notebook_invites(email_normalized, status, provider_hint);

CREATE UNIQUE INDEX IF NOT EXISTS notebook_invites_pending_provider_unique_idx
  ON notebook_invites(notebook_id, email_normalized, provider_hint, scope)
  WHERE status = 'pending' AND provider_hint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notebook_invites_pending_wildcard_unique_idx
  ON notebook_invites(notebook_id, email_normalized, scope)
  WHERE status = 'pending' AND provider_hint IS NULL;

CREATE INDEX IF NOT EXISTS notebook_invites_notebook_idx
  ON notebook_invites(notebook_id, status);
