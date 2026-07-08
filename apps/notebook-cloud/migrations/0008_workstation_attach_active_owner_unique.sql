CREATE TABLE IF NOT EXISTS workstation_attach_jobs (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  workstation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'accepted', 'running', 'failed', 'completed', 'cancelled')
  ),
  requested_by_actor_label TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
);

CREATE INDEX IF NOT EXISTS workstation_attach_jobs_poll_idx
  ON workstation_attach_jobs(owner_principal, workstation_id, status, requested_at);

UPDATE workstation_attach_jobs
   SET status = 'cancelled',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       error_message = 'cancelled by active workstation attach job uniqueness migration'
 WHERE status IN ('pending', 'accepted', 'running')
   AND id IN (
     SELECT id
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY notebook_id, owner_principal
                  ORDER BY requested_at DESC, updated_at DESC, id DESC
                ) AS active_rank
           FROM workstation_attach_jobs
          WHERE status IN ('pending', 'accepted', 'running')
       )
      WHERE active_rank > 1
   );

DROP INDEX IF EXISTS workstation_attach_jobs_active_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS workstation_attach_jobs_active_unique_idx
  ON workstation_attach_jobs(notebook_id, owner_principal)
  WHERE status IN ('pending', 'accepted', 'running');
