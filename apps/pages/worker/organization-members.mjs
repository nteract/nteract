/** Picking a colleague from one of your organizations by name.
 *
 * A person who shares a Page or a Project types part of a name; Pages asks
 * the deployment's organization directory (organization-directory.mjs) for
 * that organization's members and shows names and avatars, never an address.
 * Granting a pick asks the directory again by id
 * (`resolveOrganizationMember`), and the grant names the account the
 * directory confirms, with the name it sent. Nothing the browser sends about
 * a member is granted or stored.
 *
 * Both calls need three things now, checked in this order:
 *
 * 1. This deployment's sign-in has an organization directory.
 * 2. The caller holds a lease for the organization
 *    (organization-memberships.mjs): its newest exchange named it and still
 *    counts.
 * 3. That exchange carried a directory credential. Kilo sends one from the
 *    release that added member search; with an older Kilo there is none,
 *    search is off, and sharing by email works as before.
 *
 * The directory still checks the caller's membership live on each call. The
 * credential travels only from D1 to the directory: it never reaches a
 * response, an identity or a log line. */
import { HttpError, json, readJson } from "./auth.mjs";
import {
  DirectoryProtocolError,
  DirectoryRateLimited,
  DirectoryUnavailable,
} from "./organization-directory.mjs";
import {
  directoryCredential,
  organizationDirectory,
  organizationProof,
} from "./organization-memberships.mjs";

/** A query's length after trimming. */
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

/** The route the share dialog searches through. */
export const ORGANIZATION_MEMBERS_PATH = "/api/organization-members";

/** Search can't run here now: this deployment has no organization directory,
 * or its directory can't answer. The dialog hides the picker. */
export const MEMBER_SEARCH_UNAVAILABLE = "member_search_unavailable";
/** The directory lists nobody by that id in that organization now. */
export const MEMBER_NOT_FOUND = "member_not_found";
/** The caller can't search this organization now: no lease for it, or no
 * credential the directory still accepts. Signing in again renews both, as it
 * does for sharing with the organization. */
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

/** The query as Pages takes it: trimmed, 2 to 100 characters. */
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

/** Whether `identity` can search its organizations now: this deployment has
 * an organization directory and its newest exchange carried a credential that
 * still counts. The share dialog shows the picker only then. */
export async function memberSearchAvailable(env, identity, now = Date.now()) {
  if (!identity || !organizationDirectory(env)) return false;
  return (await directoryCredential(env, identity, now)) !== null;
}

/** What one directory call needs for `identity` in `organizationId`, after
 * the three checks in the header. Throws a coded HttpError for each. */
async function searchContext(env, identity, organizationId, now) {
  const directory = organizationDirectory(env);
  if (!directory)
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
  const credential = await directoryCredential(env, identity, now);
  if (!credential) throw proofRequired();
  return {
    directory,
    input: { principal: identity.principal, organizationId: id, credential },
  };
}

/** The directory's refusal as the coded HttpError Pages answers with. */
function directoryRefusal(refused) {
  if (refused === "credential") return proofRequired();
  if (refused === "membership")
    return new HttpError(
      403,
      "Your organization no longer lists you. Sign in again to refresh your organizations",
      PROOF_REQUIRED,
    );
  return new HttpError(
    400,
    "The organization directory did not accept this search",
    "invalid_arguments",
  );
}

async function askDirectory(call) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DirectoryRateLimited)
      throw Object.assign(new HttpError(429, "Too many searches. Wait a moment and try again"), {
        ...(error.retryAfterMs && { retryAfterMs: error.retryAfterMs }),
      });
    if (error instanceof DirectoryUnavailable || error instanceof DirectoryProtocolError)
      throw unavailable();
    throw error;
  }
}

/** Members of `organization_id` whose name has a word starting with
 * `query`, as `{ members: [{ id, name, image_url }] }`, at most 10. The
 * caller's own account is left out: an owner can't share with themself. */
export async function searchOrganizationMembers(env, identity, args, now = Date.now()) {
  const query = checkedQuery(args?.query);
  const { directory, input } = await searchContext(env, identity, args?.organization_id, now);
  const answer = await askDirectory(() => directory.search({ ...input, query }));
  if (answer.refused) throw directoryRefusal(answer.refused);
  return {
    members: answer.members
      .filter(({ id }) => directory.memberPrincipal(id) !== identity.principal)
      .map(({ id, name, imageUrl }) => ({ id, name, image_url: imageUrl })),
  };
}

/** The account to grant for a pick, `{ principal, displayName }`, once the
 * directory confirms `member_id` is a member of `organization_id` now.
 * Throws 404 `member_not_found` when it lists nobody by that id there. */
export async function resolveOrganizationMember(env, identity, args, now = Date.now()) {
  const memberId = checkedId(args?.member_id, "a person");
  const { directory, input } = await searchContext(env, identity, args?.organization_id, now);
  const answer = await askDirectory(() => directory.resolve({ ...input, memberId }));
  if (answer.refused) throw directoryRefusal(answer.refused);
  if (!answer.member)
    throw new HttpError(
      404,
      "That person isn't a member of this organization now",
      MEMBER_NOT_FOUND,
    );
  return {
    principal: directory.memberPrincipal(answer.member.id),
    displayName: answer.member.name,
  };
}

/** `POST /api/organization-members` with `{ organization_id, query }`.
 * The caller is already authenticated.
 *
 * Pages sets no limit of its own here: it has no shared rate limiter, so
 * Kilo's per-deployment and per-searcher limits are the only ones. One person
 * searching hard can use up the deployment's share. */
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
  try {
    return json(await searchOrganizationMembers(env, identity, args));
  } catch (error) {
    // The directory's own wait, passed on, so the dialog doesn't search
    // again before the limit resets.
    if (error?.status !== 429 || !error.retryAfterMs) throw error;
    return Response.json(
      { error: error.message, retry_after_ms: error.retryAfterMs },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(Math.ceil(error.retryAfterMs / 1000)),
        },
      },
    );
  }
}
