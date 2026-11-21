/** The organization directory behind a deployment's sign-in: the service that
 * says which organizations an account belongs to and who else is in them.
 *
 * Pages owns the organization lens: membership evidence and leases
 * (organization-memberships.mjs), organization sharing
 * (organization-access.mjs), and picking a colleague by name
 * (organization-members.mjs). A directory adapter sits behind it. Kilo's
 * (kilo-directory.mjs) is the first; another deployment can bring its own.
 *
 * An adapter is an object with:
 *
 * - `provider`: its name, stored with each membership record ("kilo").
 * - `namespace`: the principal namespace of the accounts it names.
 * - `evidenceSeconds`: how long, from the exchange that reported them, Pages
 *   trusts what it said about an account's organizations.
 * - `memberships(account)`: what one sign-in reported, as `{ organizations,
 *   credential }`. `organizations` is `[{ id, name }]`. `credential` is an
 *   opaque string the directory issued for that person's search on this
 *   deployment, or null. Pages stores it with the record and hands it back
 *   only to `search` and `resolve`.
 * - `search({ principal, organizationId, credential, query })`: members of
 *   the organization whose name matches `query`, for the person `principal`
 *   names.
 * - `resolve({ principal, organizationId, credential, memberId })`: whether
 *   `memberId` is a member of the organization now.
 * - `memberPrincipal(memberId)`: the principal a member's grant names.
 *
 * `search` answers `{ members }` and `resolve` answers `{ member }` (null for
 * nobody), each member `{ id, name, imageUrl }` with no address. Either may
 * answer `{ refused }` instead: `"credential"` when the directory doesn't
 * accept the person's credential, `"membership"` when the person isn't a
 * member of the organization now, or `"request"` when it doesn't accept the
 * request. Anything else is one of the errors below. */

/** The directory can't answer now: unreachable, refusing this deployment, or
 * not configured to. Searching again later may work. */
export class DirectoryUnavailable extends Error {
  constructor() {
    super("The organization directory is unavailable");
    this.name = "DirectoryUnavailable";
  }
}

/** The directory is limiting this deployment's or this person's requests.
 * `retryAfterMs` is how long it asked to wait, when it said. */
export class DirectoryRateLimited extends Error {
  constructor(retryAfterMs) {
    super("The organization directory is limiting requests");
    this.name = "DirectoryRateLimited";
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0) this.retryAfterMs = retryAfterMs;
  }
}

/** The directory answered with something Pages doesn't accept. */
export class DirectoryProtocolError extends Error {
  constructor() {
    super("The organization directory returned an invalid response");
    this.name = "DirectoryProtocolError";
  }
}
