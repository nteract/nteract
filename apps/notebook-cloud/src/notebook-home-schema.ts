/** Transactional, coalesced invalidations for the authorized notebook listing. */
const enqueue = (subjects: string) => `
  INSERT INTO notebook_home_outbox (principal, change_id, queued_at)
  SELECT principal, lower(hex(randomblob(16))), unixepoch() FROM (
    ${subjects}
    UNION
    SELECT transport_principal AS principal FROM principal_account_links
    WHERE canonical_principal IN (${subjects})
  ) WHERE principal IS NOT NULL
  ON CONFLICT(principal) DO UPDATE SET change_id = excluded.change_id;`;

const notebookPrincipals = (row: string) =>
  `SELECT subject AS principal FROM notebook_acl
   WHERE notebook_id = ${row}.id AND subject_kind = 'principal'`;
const aclPrincipal = (row: string) =>
  `SELECT ${row}.subject AS principal WHERE ${row}.subject_kind = 'principal'`;

export const NOTEBOOK_HOME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notebook_home_outbox (
    principal TEXT PRIMARY KEY,
    change_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS notebook_home_outbox_queue_idx ON notebook_home_outbox (queued_at, principal)`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_title_changed
   AFTER UPDATE OF title ON notebooks WHEN NEW.title IS NOT OLD.title
   BEGIN ${enqueue(notebookPrincipals("NEW"))} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_notebook_deleted
   BEFORE DELETE ON notebooks
   BEGIN ${enqueue(notebookPrincipals("OLD"))} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_acl_inserted
   AFTER INSERT ON notebook_acl
   BEGIN ${enqueue(aclPrincipal("NEW"))} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_acl_deleted
   AFTER DELETE ON notebook_acl
   BEGIN ${enqueue(aclPrincipal("OLD"))} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_acl_updated
   AFTER UPDATE ON notebook_acl
   WHEN NEW.subject IS NOT OLD.subject OR NEW.subject_kind IS NOT OLD.subject_kind
     OR NEW.scope IS NOT OLD.scope OR NEW.notebook_id IS NOT OLD.notebook_id
   BEGIN ${enqueue(`${aclPrincipal("OLD")} UNION ${aclPrincipal("NEW")}`)} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_account_link_inserted
   AFTER INSERT ON principal_account_links
   BEGIN ${enqueue("SELECT NEW.transport_principal AS principal")} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_account_link_deleted
   AFTER DELETE ON principal_account_links
   BEGIN ${enqueue("SELECT OLD.transport_principal AS principal")} END`,
  `CREATE TRIGGER IF NOT EXISTS notebook_home_account_link_updated
   AFTER UPDATE ON principal_account_links
   WHEN NEW.transport_principal IS NOT OLD.transport_principal
     OR NEW.canonical_principal IS NOT OLD.canonical_principal
   BEGIN ${enqueue("SELECT OLD.transport_principal AS principal UNION SELECT NEW.transport_principal AS principal")} END`,
] as const;
