/** Picking a colleague from one of your Kilo organizations by name.
 *
 * A person who shares a Page or a Project types part of a name; Pages asks
 * Kilo for that organization's members (kilo-member-search.mjs) and shows
 * names and avatars, never an address. Granting a pick asks Kilo again by id
 * (`resolveOrganizationMember`), and the grant names the Kilo account Kilo
 * confirms, with the name Kilo sent. Nothing the browser sends about a member
 * is granted or stored.
 *
 * Both calls need three things now, checked in this order:
 *
 * 1. This deployment signs in with Kilo.
 * 2. The caller holds a lease for the organization (kilo-membership.mjs): its
 *    newest exchange named it and still counts.
 * 3. That exchange carried a member search proof. Kilo sends one from the
 *    release that added this route; with an older Kilo there is none, search
 *    is off, and sharing by email works as before.
 *
 * Kilo still checks the caller's membership live on each call. The proof
 * travels only from D1 to Kilo: it never reaches a response, an identity or a
 * log line. */
import { HttpError, json, readJson } from "./auth.mjs";
import { kiloClient } from "./kilo-config.mjs";
import { KiloProtocolError, KiloUnavailable } from "./kilo-exchange.mjs";
import {
  KiloRateLimited,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  resolveKiloMember,
  searchKiloMembers,
} from "./kilo-member-search.mjs";
import { memberSearchProof, organizationProof } from "./kilo-membership.mjs";

/** The route the share dialog searches through. */
export const ORGANIZATION_MEMBERS_PATH = "/api/organization-members";

/** Search can't run here now: this deployment doesn't use Kilo, Kilo refused
 * this deployment, or Kilo didn't answer. The dialog hides the picker. */
export const MEMBER_SEARCH_UNAVAILABLE = "member_search_unavailable";
/** Kilo lists nobody by that id in that organization now. */
export const MEMBER_NOT_FOUND = "member_not_found";
/** The caller can't search this organization now: no lease for it, or no
 * proof Kilo still accepts. Signing in again renews both, as it does for
 * sharing with the organization. */
const PROOF_REQUIRED = "organization_proof_required";

const MAX_ID_LENGTH = 255;

const unavailable = () =>
  Object.assign(
    new HttpError(
      503,
      "Searching your organization isn't available right now",
      MEMBER_SEARCH_UNAVAILABLE,
    ),
    { retryable: true },
  );
const proofRequired = () =>
  new HttpError(403, "Sign in again to search your organization", PROOF_REQUIRED);

function checkedId(value, what) {
  if (typeof value !== "string" || !value || value.length > MAX_ID_LENGTH || value !== value.trim())
    throw new HttpError(400, `Choose ${what}`, "invalid_arguments");
  return value;
}

/** The query as Kilo takes it: trimmed, 2 to 100 characters. */
export function checkedQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH)
    throw new HttpError(
      400,
      `Type ${MIN_QUERY_LENGTH} to ${MAX_QUERY_LENGTH} characters of a name`,
      "invalid_arguments",
    );
  return query;
}

/** Whether `identity` can search its organizations now: this deployment uses
 * Kilo and its newest exchange carried a proof that still counts. The share
 * dialog shows the picker only then. */
export async function memberSearchAvailable(env, identity, now = Date.now()) {
  let client;
  try {
    client = kiloClient(env);
  } catch {
    return false;
  }
  if (!client || !identity) return false;
  return (await memberSearchProof(env, identity, now)) !== null;
}

/** What one call to Kilo needs for `identity` in `organizationId`, after the
 * three checks in the header. Throws a coded HttpError for each. */
async function searchContext(env, identity, organizationId, now) {
  const client = kiloClient(env);
  if (!client)
    throw new HttpError(404, "Organization search isn't used here", MEMBER_SEARCH_UNAVAILABLE);
  if (identity?.credentialKind === "oauth" && !identity.canShare)
    throw new HttpError(403, "Pages sharing permission is required", "oauth_insufficient_scope");
  const id = checkedId(organizationId, "an organization");
  const state = (await organizationProof(env, identity, [id], now))[id];
  if (state !== "verified")
    throw new HttpError(
      403,
      state === "expired"
        ? "Your organization membership was last confirmed too long ago. Sign in again with the same account to search it"
        : "Search only an organization you belong to",
      PROOF_REQUIRED,
    );
  const proof = await memberSearchProof(env, identity, now);
  if (!proof) throw proofRequired();
  const prefix = `${client.namespace}:`;
  return {
    ...client,
    proof,
    organizationId: id,
    searcherId: decodeURIComponent(identity.principal.slice(prefix.length)),
  };
}

/** Kilo's refusal or failure as the coded HttpError Pages answers with. */
function kiloRefusal(refused) {
  if (refused === "proof") return proofRequired();
  if (refused === "not_a_member")
    return new HttpError(
      403,
      "Kilo no longer lists you in this organization. Sign in again to refresh your organizations",
      PROOF_REQUIRED,
    );
  if (refused === "request")
    return new HttpError(400, "Kilo did not accept this search", "invalid_arguments");
  return unavailable();
}

async function askKilo(call) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof KiloRateLimited)
      throw new HttpError(429, "Too many searches. Wait a moment and try again");
    if (error instanceof KiloUnavailable || error instanceof KiloProtocolError) throw unavailable();
    throw error;
  }
}

/** Members of `organization_id` whose name has a word starting with
 * `query`, as `{ members: [{ id, name, image_url }] }`, at most 10. The
 * caller's own account is left out: an owner can't share with themself. */
export async function searchOrganizationMembers(env, identity, args, now = Date.now()) {
  const query = checkedQuery(args?.query);
  const context = await searchContext(env, identity, args?.organization_id, now);
  const answer = await askKilo(() => searchKiloMembers(fetch, { ...context, query }));
  if (answer.refused) throw kiloRefusal(answer.refused);
  return {
    members: answer.members
      .filter(({ id }) => id !== context.searcherId)
      .map(({ id, name, imageUrl }) => ({ id, name, image_url: imageUrl })),
  };
}

/** The account to grant for a pick, `{ principal, displayName }`, once Kilo
 * confirms `member_id` is a member of `organization_id` now. Throws 404
 * `member_not_found` when Kilo lists nobody by that id there. */
export async function resolveOrganizationMember(env, identity, args, now = Date.now()) {
  const memberId = checkedId(args?.member_id, "a person");
  const context = await searchContext(env, identity, args?.organization_id, now);
  const answer = await askKilo(() => resolveKiloMember(fetch, { ...context, memberId }));
  if (answer.refused) throw kiloRefusal(answer.refused);
  if (!answer.member)
    throw new HttpError(
      404,
      "That person isn't a member of this organization now",
      MEMBER_NOT_FOUND,
    );
  return {
    principal: `${context.namespace}:${encodeURIComponent(answer.member.id)}`,
    displayName: answer.member.name,
  };
}

/** `POST /api/organization-members` with `{ organization_id, query }`.
 * The caller is already authenticated. */
export async function organizationMembersRoute(request, env, identity) {
  if (request.method !== "POST") throw new HttpError(405, "Use POST");
  const args = await readJson(request);
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => key !== "organization_id" && key !== "query")
  )
    throw new HttpError(400, "Send organization_id and query", "invalid_arguments");
  return json(await searchOrganizationMembers(env, identity, args));
}
