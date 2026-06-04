CREATE TABLE IF NOT EXISTS principal_account_links (
  transport_principal TEXT PRIMARY KEY,
  canonical_principal TEXT NOT NULL,
  provider TEXT NOT NULL,
  email_normalized TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS principal_account_links_canonical_idx
  ON principal_account_links(canonical_principal);
