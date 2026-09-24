-- Coalesced delivery records are updated atomically by catalog mutations.
CREATE TABLE IF NOT EXISTS notebook_home_outbox (
    principal TEXT PRIMARY KEY,
    change_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS notebook_home_outbox_queue_idx ON notebook_home_outbox (queued_at, principal);

CREATE TRIGGER IF NOT EXISTS notebook_home_title_changed
   AFTER UPDATE OF title ON notebooks WHEN NEW.title IS NOT OLD.title
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT subject AS principal FROM notebook_acl
   WHERE notebook_id = NEW.id AND subject_kind = 'principal'
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT subject AS principal FROM notebook_acl
   WHERE notebook_id = NEW.id AND subject_kind = 'principal')
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_notebook_deleted
   BEFORE DELETE ON notebooks
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT subject AS principal FROM notebook_acl
   WHERE notebook_id = OLD.id AND subject_kind = 'principal'
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT subject AS principal FROM notebook_acl
   WHERE notebook_id = OLD.id AND subject_kind = 'principal')
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_acl_inserted
   AFTER INSERT ON notebook_acl
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT NEW.subject AS principal WHERE NEW.subject_kind = 'principal'
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT NEW.subject AS principal WHERE NEW.subject_kind = 'principal')
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_acl_deleted
   AFTER DELETE ON notebook_acl
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT OLD.subject AS principal WHERE OLD.subject_kind = 'principal'
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT OLD.subject AS principal WHERE OLD.subject_kind = 'principal')
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_acl_updated
   AFTER UPDATE ON notebook_acl
   WHEN NEW.subject IS NOT OLD.subject OR NEW.subject_kind IS NOT OLD.subject_kind
     OR NEW.scope IS NOT OLD.scope OR NEW.notebook_id IS NOT OLD.notebook_id
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT OLD.subject AS principal WHERE OLD.subject_kind = 'principal' UNION SELECT NEW.subject AS principal WHERE NEW.subject_kind = 'principal'
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT OLD.subject AS principal WHERE OLD.subject_kind = 'principal' UNION SELECT NEW.subject AS principal WHERE NEW.subject_kind = 'principal')
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_account_link_inserted
   AFTER INSERT ON principal_account_links
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT NEW.transport_principal AS principal
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT NEW.transport_principal AS principal)
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_account_link_deleted
   AFTER DELETE ON principal_account_links
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT OLD.transport_principal AS principal
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT OLD.transport_principal AS principal)
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;

CREATE TRIGGER IF NOT EXISTS notebook_home_account_link_updated
   AFTER UPDATE ON principal_account_links
   WHEN NEW.transport_principal IS NOT OLD.transport_principal
     OR NEW.canonical_principal IS NOT OLD.canonical_principal
   BEGIN 
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    SELECT OLD.transport_principal AS principal UNION SELECT NEW.transport_principal AS principal
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (SELECT OLD.transport_principal AS principal UNION SELECT NEW.transport_principal AS principal)
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id; END;
