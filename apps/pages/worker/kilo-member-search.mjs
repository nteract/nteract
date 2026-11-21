/** What Pages asks of Kilo to search the members of one of a person's
 * organizations by name, and to confirm one member at grant time.
 *
 * One route, server to server, on the deployment secret like the exchange
 * (kilo-exchange.mjs), plus the searcher's `member_search_proof` from their
 * own exchange. The secret says which deployment asks; the proof says on whose
 * behalf. Kilo checks the searcher's membership live on every call.
 *
 *     { audience, searcher_id, organization_id, proof, query }
 *     { audience, searcher_id, organization_id, proof, member_id }
 *
 * Both answer `{ members: [{ id, name, image_url }] }`: up to 10 matches for
 * a query, and the one member or none for an id. Ids are raw Kilo user ids.
 *
 * Kilo never sends an address, and Pages refuses one anyway: an entry whose
 * name is empty or holds an `@` is dropped, as is an entry without a usable
 * id. `image_url` is kept only as an `https:` URL.
 *
 * The module holds no state and logs nothing. Error messages are fixed text,
 * so the proof, the secret, a query or a name can't reach a log through
 * them. */
import { KiloProtocolError, KiloUnavailable, readLimited } from "./kilo-exchange.mjs";

/** Where Pages searches an organization's members. */
export const KILO_MEMBER_SEARCH_PATH = "/api/pages-auth/organization-members";
/** A query's length after trimming, as Kilo accepts it. */
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;
/** The most members one answer holds. */
export const MAX_MEMBERS = 10;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ID_LENGTH = 255;
const MAX_NAME_LENGTH = 200;
const MAX_IMAGE_URL_LENGTH = 2048;

/** Kilo answered 429: this deployment or this searcher asked too often. */
export class KiloRateLimited extends Error {
  constructor() {
    super("Kilo is limiting member searches");
    this.name = "KiloRateLimited";
  }
}

/** Kilo's refusals, by status and `error`. Anything else is a protocol
 * error. */
const REFUSALS = Object.freeze({
  "400:invalid_request": "request",
  "401:invalid_client": "client",
  "401:invalid_proof": "proof",
  "403:not_a_member": "not_a_member",
});

const discard = async (response) => {
  try {
    await response.body?.cancel();
  } catch {}
};

async function readJson(response) {
  try {
    return JSON.parse(new TextDecoder().decode(await readLimited(response)));
  } catch (error) {
    if (error instanceof KiloUnavailable) throw error;
    throw new KiloProtocolError();
  }
}

function imageUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_IMAGE_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Kilo's `members`, as `[{ id, name, imageUrl }]` in Kilo's order and at
 * most `MAX_MEMBERS`. An entry Pages can't show, or one that could show an
 * address, is dropped; a repeated id keeps its first entry. Anything but an
 * array is a protocol error, since Kilo answers `[]` for nobody. */
export function kiloMembers(value) {
  if (!Array.isArray(value)) throw new KiloProtocolError();
  const members = new Map();
  for (const entry of value) {
    if (members.size === MAX_MEMBERS) break;
    const id = entry?.id;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > MAX_ID_LENGTH ||
      id !== id.trim() ||
      members.has(id)
    )
      continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH || /[@＠]/u.test(name)) continue;
    members.set(id, { id, name, imageUrl: imageUrl(entry.image_url) });
  }
  return [...members.values()];
}

/** Searches `organizationId` for members whose name has a word starting with
 * `query`, on behalf of `searcherId`, whose `proof` comes from their own
 * exchange. The caller trims `query` and checks its length.
 *
 * Returns `{ members }` as `kiloMembers` reads them, or `{ refused }`:
 * `"request"` (400 `invalid_request`), `"client"` (401 `invalid_client`),
 * `"proof"` (401 `invalid_proof`: forged, expired, or another person's or
 * deployment's) or `"not_a_member"` (403: the searcher's account is gone or
 * blocked, or holds no membership of its own in a live organization). Throws
 * `KiloRateLimited` on 429, `KiloUnavailable` when Kilo can't answer
 * (including 503 while its rate-limit rules are missing), and
 * `KiloProtocolError` for anything else. */
export function searchKiloMembers(
  fetcher,
  { appUrl, secret, audience, searcherId, organizationId, proof, query, timeoutMs },
) {
  return ask(fetcher, {
    appUrl,
    secret,
    timeoutMs,
    body: {
      audience,
      searcher_id: searcherId,
      organization_id: organizationId,
      proof,
      query,
    },
  });
}

/** Asks Kilo whether `memberId` is a member of `organizationId` now, on
 * behalf of `searcherId`. Returns `{ member }`, null when Kilo lists nobody
 * by that id, or `{ refused }` as `searchKiloMembers` does; throws as it
 * does. An answer naming anyone but `memberId` is a protocol error. */
export async function resolveKiloMember(
  fetcher,
  { appUrl, secret, audience, searcherId, organizationId, proof, memberId, timeoutMs },
) {
  const answer = await ask(fetcher, {
    appUrl,
    secret,
    timeoutMs,
    body: {
      audience,
      searcher_id: searcherId,
      organization_id: organizationId,
      proof,
      member_id: memberId,
    },
  });
  if (answer.refused) return answer;
  if (answer.members.length > 1 || answer.members.some(({ id }) => id !== memberId))
    throw new KiloProtocolError();
  return { member: answer.members[0] ?? null };
}

async function ask(fetcher, { appUrl, secret, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetcher(new URL(KILO_MEMBER_SEARCH_PATH, appUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      // Inspected, never followed: the secret and proof stay at the
      // configured origin.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new KiloUnavailable();
  }
  const { status } = response;
  if (status === 429) {
    await discard(response);
    throw new KiloRateLimited();
  }
  if (status >= 500) {
    await discard(response);
    throw new KiloUnavailable();
  }
  if (status === 400 || status === 401 || status === 403) {
    const refused = REFUSALS[`${status}:${(await readJson(response))?.error}`];
    if (!refused) throw new KiloProtocolError();
    return { refused };
  }
  if (status !== 200) {
    await discard(response);
    throw new KiloProtocolError();
  }
  return { members: kiloMembers((await readJson(response))?.members) };
}
