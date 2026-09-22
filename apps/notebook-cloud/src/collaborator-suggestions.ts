import type { Env } from "./cloudflare-types.ts";
import type { AuthenticatedConnection } from "./identity.ts";
import { ensureCatalogSchema } from "./storage.ts";

export interface CollaboratorSuggestion {
  id: string;
  displayName: string;
  avatarUrl: null;
  source: "collaborator";
}

interface EligibleCollaborator {
  id: string;
  principal: string;
  display_name: string;
  last_joined_at: string;
}

const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validPeopleId(value: unknown): value is string {
  return typeof value === "string" && PERSON_ID.test(value);
}

export function collaboratorsEnabled(env: Env, identity: AuthenticatedConnection): boolean {
  return (
    Boolean(env.DB) &&
    identity.scope !== "runtime_peer" &&
    identity.principal !== "system" &&
    !identity.principal.startsWith("anonymous:")
  );
}

// Resolve only the account aliases already established by authentication. Never
// compare emails or infer that different provider subjects are the same person.
const CALLER_AND_PEOPLE = `WITH caller AS (
  SELECT ? AS transport_principal,
    COALESCE((SELECT canonical_principal FROM principal_account_links WHERE transport_principal = ?), ?) AS principal
), people AS (
  SELECT p.id, p.transport_principal,
    COALESCE(l.canonical_principal, p.transport_principal) AS principal
  FROM people_discovery_people p
  LEFT JOIN principal_account_links l ON l.transport_principal = p.transport_principal
)`;

const ELIGIBLE = `, eligible AS (
  SELECT MIN(peer.id) AS id, peer.principal,
    COALESCE(MAX(NULLIF(TRIM(cp.display_name), '')), MAX(NULLIF(TRIM(tp.display_name), '')), 'Previous collaborator') AS display_name,
    MAX(their_join.last_joined_at) AS last_joined_at
  FROM caller
  JOIN people mine ON mine.principal = caller.principal
  JOIN private_notebook_participants my_join ON my_join.person_id = mine.id
  JOIN private_notebook_participants their_join ON their_join.notebook_id = my_join.notebook_id
  JOIN people peer ON peer.id = their_join.person_id AND peer.principal != caller.principal
  JOIN notebooks n ON n.id = my_join.notebook_id
  LEFT JOIN principal_profiles cp ON cp.principal = peer.principal
  LEFT JOIN principal_profiles tp ON tp.principal = peer.transport_principal
  WHERE NOT EXISTS (SELECT 1 FROM notebook_acl public_acl WHERE public_acl.notebook_id = n.id AND public_acl.subject_kind = 'public')
    AND EXISTS (SELECT 1 FROM notebook_acl a WHERE a.notebook_id = n.id AND a.subject_kind = 'principal'
      AND a.subject IN (caller.transport_principal, caller.principal) AND a.scope IN ('viewer', 'editor', 'owner'))
    AND EXISTS (SELECT 1 FROM notebook_acl a WHERE a.notebook_id = n.id AND a.subject_kind = 'principal'
      AND a.subject IN (peer.transport_principal, peer.principal) AND a.scope IN ('viewer', 'editor', 'owner'))
  GROUP BY peer.principal
)`;

const NOT_SUPPRESSED = `NOT EXISTS (
  SELECT 1 FROM people_suggestion_suppressions s
  JOIN people owner ON owner.id = s.owner_person_id
  JOIN people target ON target.id = s.target_person_id
  WHERE (owner.principal = caller.principal AND target.principal = eligible.principal)
     OR (target.principal = caller.principal AND owner.principal = eligible.principal)
)`;

function callerBindings(identity: AuthenticatedConnection): string[] {
  return [identity.principal, identity.principal, identity.principal];
}

const PRIVATE_ACCESS = `EXISTS (
  SELECT 1 FROM notebooks n JOIN notebook_acl a ON a.notebook_id = n.id
  WHERE n.id = ? AND a.subject_kind = 'principal' AND a.scope IN ('viewer', 'editor', 'owner')
    AND (a.subject = ? OR a.subject = (SELECT canonical_principal FROM principal_account_links WHERE transport_principal = ?))
    AND NOT EXISTS (SELECT 1 FROM notebook_acl p WHERE p.notebook_id = n.id AND p.subject_kind = 'public')
)`;

/** Called once after an authorized room upgrade succeeds; never on room frames. */
export async function recordPrivateNotebookParticipation(
  env: Env,
  identity: AuthenticatedConnection,
  notebookId: string,
): Promise<void> {
  if (!env.DB || !collaboratorsEnabled(env, identity)) return;
  await ensureCatalogSchema(env);
  const now = new Date().toISOString();
  const access = [notebookId, identity.principal, identity.principal];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people_discovery_people (id, transport_principal, created_at)
      SELECT ?, ?, ? WHERE ${PRIVATE_ACCESS} ON CONFLICT(transport_principal) DO NOTHING`).bind(
      crypto.randomUUID(),
      identity.principal,
      now,
      ...access,
    ),
    env.DB.prepare(`INSERT INTO private_notebook_participants (notebook_id, person_id, last_joined_at)
      SELECT ?, id, ? FROM people_discovery_people WHERE transport_principal = ? AND ${PRIVATE_ACCESS}
      ON CONFLICT(notebook_id, person_id) DO UPDATE SET last_joined_at = excluded.last_joined_at`).bind(
      notebookId,
      now,
      identity.principal,
      ...access,
    ),
  ]);
}

export async function searchCollaborators(
  env: Env,
  identity: AuthenticatedConnection,
  query: string,
  limit = 10,
): Promise<CollaboratorSuggestion[]> {
  if (!env.DB || !collaboratorsEnabled(env, identity)) return [];
  await ensureCatalogSchema(env);
  const normalized = query.trim().toLowerCase();
  if (normalized.length > 80 || limit < 1) return [];
  // instr/substr are literal comparisons: '%' and '_' never become wildcards.
  const result = await env.DB.prepare(`${CALLER_AND_PEOPLE}${ELIGIBLE}
    SELECT eligible.* FROM eligible, caller WHERE ${NOT_SUPPRESSED}
      AND (? = '' OR substr(lower(display_name), 1, length(?)) = ? OR instr(lower(display_name), ' ' || ?) > 0)
    ORDER BY last_joined_at DESC, display_name, id LIMIT ?`)
    .bind(
      ...callerBindings(identity),
      normalized,
      normalized,
      normalized,
      normalized,
      Math.min(limit, 10),
    )
    .all<EligibleCollaborator>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    displayName: row.display_name.slice(0, 128),
    avatarUrl: null,
    source: "collaborator",
  }));
}

/** Recheck both current private access and suppression at the moment of selection. */
export async function resolveCollaborator(
  env: Env,
  identity: AuthenticatedConnection,
  personId: string,
): Promise<string | null> {
  if (!env.DB || !collaboratorsEnabled(env, identity) || !validPeopleId(personId)) return null;
  await ensureCatalogSchema(env);
  const row = await env.DB.prepare(`${CALLER_AND_PEOPLE}${ELIGIBLE}
    SELECT eligible.principal FROM eligible, caller
    WHERE eligible.principal = (SELECT principal FROM people WHERE id = ?) AND ${NOT_SUPPRESSED}`)
    .bind(...callerBindings(identity), personId)
    .first<{ principal: string }>();
  return row?.principal ?? null;
}

export async function hideCollaborator(
  env: Env,
  identity: AuthenticatedConnection,
  personId: string,
): Promise<string | null> {
  if (!env.DB || !collaboratorsEnabled(env, identity) || !validPeopleId(personId)) return null;
  await ensureCatalogSchema(env);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`${CALLER_AND_PEOPLE}${ELIGIBLE}
      INSERT INTO people_discovery_people (id, transport_principal, created_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM eligible WHERE principal = (SELECT principal FROM people WHERE id = ?))
      ON CONFLICT(transport_principal) DO NOTHING`).bind(
      ...callerBindings(identity),
      crypto.randomUUID(),
      identity.principal,
      now,
      personId,
    ),
    env.DB.prepare(`${CALLER_AND_PEOPLE}${ELIGIBLE}
      INSERT INTO people_suggestion_suppressions (id, owner_person_id, target_person_id, created_at)
      SELECT ?, owner.id, target.id, ? FROM people owner, people target, caller
      WHERE owner.transport_principal = caller.transport_principal AND target.id = ?
        AND EXISTS (SELECT 1 FROM eligible WHERE eligible.principal = target.principal)
        AND NOT EXISTS (SELECT 1 FROM people_suggestion_suppressions s
          JOIN people o ON o.id = s.owner_person_id JOIN people t ON t.id = s.target_person_id
          WHERE o.principal = caller.principal AND t.principal = target.principal)
      ON CONFLICT(owner_person_id, target_person_id) DO NOTHING`).bind(
      ...callerBindings(identity),
      crypto.randomUUID(),
      now,
      personId,
    ),
  ]);
  const row = await env.DB.prepare(`${CALLER_AND_PEOPLE}
    SELECT s.id FROM people_suggestion_suppressions s
    JOIN people owner ON owner.id = s.owner_person_id JOIN people target ON target.id = s.target_person_id, caller
    WHERE owner.principal = caller.principal AND target.principal = (SELECT principal FROM people WHERE id = ?)
    ORDER BY s.id LIMIT 1`)
    .bind(...callerBindings(identity), personId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function listHiddenCollaborators(
  env: Env,
  identity: AuthenticatedConnection,
  after: string | null,
): Promise<{
  hidden: Array<{ id: string; personId: string; displayName: string; avatarUrl: null }>;
  nextCursor: string | null;
}> {
  if (!env.DB || !collaboratorsEnabled(env, identity)) return { hidden: [], nextCursor: null };
  await ensureCatalogSchema(env);
  const rows = await env.DB.prepare(`${CALLER_AND_PEOPLE}${ELIGIBLE}
    SELECT s.id, target.id AS person_id, COALESCE(eligible.display_name, 'Hidden person') AS display_name
    FROM people_suggestion_suppressions s
    JOIN people owner ON owner.id = s.owner_person_id JOIN people target ON target.id = s.target_person_id
    LEFT JOIN eligible ON eligible.principal = target.principal, caller
    WHERE owner.principal = caller.principal AND s.id > ? ORDER BY s.id LIMIT 21`)
    .bind(...callerBindings(identity), after ?? "")
    .all<{ id: string; person_id: string; display_name: string }>();
  const result = rows.results ?? [];
  const hidden = result.slice(0, 20).map((row) => ({
    id: row.id,
    personId: row.person_id,
    displayName: row.display_name.slice(0, 128),
    avatarUrl: null,
  }));
  return { hidden, nextCursor: result.length > 20 ? hidden[hidden.length - 1].id : null };
}

export async function unhideCollaborator(
  env: Env,
  identity: AuthenticatedConnection,
  id: string,
): Promise<void> {
  if (!env.DB || !collaboratorsEnabled(env, identity) || !validPeopleId(id)) return;
  await ensureCatalogSchema(env);
  await env.DB.prepare(`${CALLER_AND_PEOPLE}
    DELETE FROM people_suggestion_suppressions WHERE id = ? AND owner_person_id IN (
      SELECT people.id FROM people, caller WHERE people.principal = caller.principal
    )`)
    .bind(...callerBindings(identity), id)
    .run();
}
