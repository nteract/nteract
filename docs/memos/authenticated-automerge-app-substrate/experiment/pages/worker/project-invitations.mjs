import { invitationMatches } from "./sharing.mjs";
import { HttpError } from "./auth.mjs";

// Candidate index only: a row never authorizes a Project. Keep exact-email
// proof verification in the established invitation matcher, including OIDC's
// opaque binding. No email/principal directory is created or exposed.
async function database(env) {
  if (!env.DB) throw new HttpError(503, "Project invitation discovery unavailable");
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pages_project_invitations (
    project_id TEXT NOT NULL, invite_id TEXT NOT NULL, email TEXT NOT NULL,
    namespace TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, invite_id))`,
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS pages_project_invitation_namespace ON pages_project_invitations(namespace, expires_at)",
  ).run();
  return env.DB;
}

export async function indexProjectInvitations(env, record) {
  const db = await database(env);
  await db
    .prepare("DELETE FROM pages_project_invitations WHERE expires_at <= ?")
    .bind(Date.now())
    .run();
  for (const invite of Object.values(record.acl?.invites ?? {})) {
    await db
      .prepare(
        `INSERT INTO pages_project_invitations
      (project_id, invite_id, email, namespace, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, invite_id) DO UPDATE SET email=excluded.email,
      namespace=excluded.namespace, expires_at=excluded.expires_at`,
      )
      .bind(record.space_id, invite.id, invite.email, invite.namespace, invite.expiresAt)
      .run();
  }
}

/**
 * Deletes this Project's index rows whose invitation is no longer in
 * `record.acl.invites`: revoked, accepted or replaced. Rows for invitations
 * still pending stay. Idempotent, so a retry or replay can repeat it.
 */
export async function pruneProjectInvitations(env, record) {
  const db = await database(env);
  const live = Object.keys(record.acl?.invites ?? {});
  const result = await db
    .prepare(
      `DELETE FROM pages_project_invitations WHERE project_id = ?
      AND invite_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(record.space_id, JSON.stringify(live))
    .run();
  return result.meta?.changes ?? 0;
}

/** Deletes at most `limit` expired index rows. `now` is in milliseconds, like expires_at. */
export async function deleteExpiredProjectInvitations(env, { now, limit }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid invitation cleanup time");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Invalid invitation cleanup limit");
  const db = await database(env);
  const result = await db
    .prepare(
      `DELETE FROM pages_project_invitations WHERE rowid IN
      (SELECT rowid FROM pages_project_invitations WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
    )
    .bind(now, limit)
    .run();
  return result.meta?.changes ?? 0;
}

export async function invitedProjects(env, identity) {
  if (!identity.namespace || (!identity.verifiedEmail && !identity.emailProof)) return [];
  const db = await database(env);
  const found = new Set();
  let after = "";
  for (;;) {
    const rows =
      (
        await db
          .prepare(
            `SELECT project_id, invite_id, email, namespace, expires_at
      FROM pages_project_invitations WHERE namespace = ? AND expires_at > ?
      AND (project_id || ':' || invite_id) > ?
      ORDER BY project_id || ':' || invite_id LIMIT 100`,
          )
          .bind(identity.namespace, Date.now(), after)
          .all()
      ).results ?? [];
    for (const row of rows) {
      if (
        await invitationMatches(
          identity,
          { email: row.email, namespace: row.namespace, expiresAt: row.expires_at },
          env,
          Date.now(),
        )
      )
        found.add(row.project_id);
    }
    if (rows.length < 100) return [...found];
    const last = rows.at(-1);
    after = `${last.project_id}:${last.invite_id}`;
  }
}
