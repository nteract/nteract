/** Kilo as an organization directory (organization-directory.mjs).
 *
 * Kilo reports an account's organizations with each exchange
 * (kilo-exchange.mjs), and, from the release that added member search, a
 * `member_search_proof`: a token Kilo signs naming the person and this
 * deployment's audience, good for 8 hours. That proof is the directory
 * credential Pages stores with the record. The exchange's
 * `directory.capabilities` says what Kilo offers this deployment: Kilo
 * advertises `member_search`, and mints the proof, only once its operators
 * turn search on.
 *
 * Search and resolve are one route, server to server, on the deployment
 * secret like the exchange, plus the searcher's proof. The secret says which
 * deployment asks; the proof says on whose behalf. Kilo checks the searcher's
 * membership live on every call.
 *
 *     POST /api/pages-auth/organization-members
 *     { audience, searcher_id, organization_id, proof, query }
 *     { audience, searcher_id, organization_id, proof, member_id }
 *
 * Both answer `{ members: [{ id, name, image_url }] }`: up to 10 matches for
 * a query, and the one member or none for an id. Ids are raw Kilo user ids.
 * Kilo's refusals, by status and `error`: 400 `invalid_request`, 401
 * `invalid_client`, 401 `invalid_proof`, 403 `not_a_member`. 429 is its rate
 * limit, and 503 means its rate-limit rules don't exist yet.
 *
 * Kilo never sends an address, and Pages refuses one anyway: an entry whose
 * name is empty or holds an `@` is dropped, as is an entry without a usable
 * id. `image_url` is kept only as an `https:` URL.
 *
 * The module holds no state and logs nothing. Error messages are fixed text,
 * so the proof, the secret, a query or a name can't reach a log through
 * them. */
import {
  KILO_MEMBERSHIP_SECONDS,
  kiloAccountId,
  kiloClient,
  kiloPrincipal,
  kiloPrincipalNamespace,
} from "./kilo-config.mjs";
import { KiloUnavailable, readLimited } from "./kilo-exchange.mjs";
import {
  DirectoryProtocolError,
  DirectoryRateLimited,
  DirectoryUnavailable,
  knownCapabilities,
} from "./organization-directory.mjs";

/** Where Pages searches an organization's members. */
export const KILO_MEMBER_SEARCH_PATH = "/api/pages-auth/organization-members";
/** The most members one answer holds. */
export const MAX_MEMBERS = 10;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ID_LENGTH = 255;
const MAX_NAME_LENGTH = 200;
const MAX_IMAGE_URL_LENGTH = 2048;

/** Kilo's refusals, by status and `error`, as the directory's. `invalid_client`
 * is this deployment's misconfiguration, so it reads as unavailable. Anything
 * else is a protocol error. */
const REFUSALS = Object.freeze({
  "400:invalid_request": "request",
  "401:invalid_proof": "credential",
  "403:not_a_member": "membership",
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
    if (error instanceof KiloUnavailable) throw new DirectoryUnavailable();
    throw new DirectoryProtocolError();
  }
}

/** Kilo's `Retry-After`, as whole seconds, in milliseconds, at most an hour;
 * undefined for anything else. */
function retryAfterMs(header) {
  if (!/^\d{1,4}$/.test(header?.trim() ?? "")) return undefined;
  const seconds = Number(header.trim());
  return seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
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
  if (!Array.isArray(value)) throw new DirectoryProtocolError();
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

/** One call to Kilo's member route with `body` and the deployment secret.
 * Answers `{ members }` or `{ refused }`; throws the directory's errors. */
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
    throw new DirectoryUnavailable();
  }
  const { status } = response;
  if (status === 429) {
    await discard(response);
    throw new DirectoryRateLimited(retryAfterMs(response.headers.get("retry-after")));
  }
  if (status >= 500) {
    await discard(response);
    throw new DirectoryUnavailable();
  }
  if (status === 400 || status === 401 || status === 403) {
    const error = (await readJson(response))?.error;
    if (status === 401 && error === "invalid_client") throw new DirectoryUnavailable();
    const refused = REFUSALS[`${status}:${error}`];
    if (!refused) throw new DirectoryProtocolError();
    return { refused };
  }
  if (status !== 200) {
    await discard(response);
    throw new DirectoryProtocolError();
  }
  return { members: kiloMembers((await readJson(response))?.members) };
}

/** Kilo as this deployment's organization directory. `fetcher` replaces
 * `fetch` in tests. */
export function kiloDirectory(env, { fetcher = (...args) => fetch(...args), timeoutMs } = {}) {
  const namespace = kiloPrincipalNamespace(env);
  /** The deployment's Kilo client, or DirectoryUnavailable when it has none
   * or a misconfigured one. */
  const client = () => {
    let config;
    try {
      config = kiloClient(env);
    } catch {
      throw new DirectoryUnavailable();
    }
    if (!config) throw new DirectoryUnavailable();
    return config;
  };
  const common = ({ principal, organizationId, credential }) => {
    const { appUrl, secret, audience } = client();
    const searcherId = kiloAccountId(namespace, principal);
    if (searcherId === null) throw new DirectoryProtocolError();
    return {
      appUrl,
      secret,
      timeoutMs,
      body: {
        audience,
        searcher_id: searcherId,
        organization_id: organizationId,
        proof: credential,
      },
    };
  };
  return Object.freeze({
    provider: "kilo",
    namespace,
    evidenceSeconds: KILO_MEMBERSHIP_SECONDS,
    /** What an exchange (kilo-exchange.mjs) reported for the account. */
    memberships(account) {
      return {
        organizations: account.organizations ?? [],
        credential: account.memberSearchProof ?? null,
        capabilities: knownCapabilities(account.directoryCapabilities),
      };
    },
    memberPrincipal: (memberId) => kiloPrincipal(namespace, memberId),
    async search({ query, ...input }) {
      const call = common(input);
      return ask(fetcher, { ...call, body: { ...call.body, query } });
    },
    async resolve({ memberId, ...input }) {
      const call = common(input);
      const answer = await ask(fetcher, { ...call, body: { ...call.body, member_id: memberId } });
      if (answer.refused) return answer;
      if (answer.members.length > 1 || answer.members.some(({ id }) => id !== memberId))
        throw new DirectoryProtocolError();
      return { member: answer.members[0] ?? null };
    },
  });
}
