CREATE TABLE IF NOT EXISTS oidc_login_transactions (
  state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL,
  context TEXT NOT NULL, sealed TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oidc_login_expiry ON oidc_login_transactions(expires_at);
CREATE TABLE IF NOT EXISTS oidc_server_sessions (
  id TEXT PRIMARY KEY, context TEXT NOT NULL, session_json TEXT NOT NULL,
  sealed TEXT NOT NULL, access_expires_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oidc_session_expiry ON oidc_server_sessions(idle_expires_at);
