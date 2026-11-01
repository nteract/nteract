-- One row per one-time data backfill, so a backfill never runs twice.
CREATE TABLE IF NOT EXISTS catalog_backfills (
    id TEXT PRIMARY KEY,
    outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'skipped')),
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

-- 0003_notebook_acl.sql already ran the public ACL backfill here. Record it so
-- schema initialization never re-grants revoked public access.
INSERT OR IGNORE INTO catalog_backfills (id, outcome)
VALUES ('notebook-acl-public-v1', 'skipped');
