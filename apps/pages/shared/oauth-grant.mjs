/** How long an OAuth grant lives with refresh. Grants keep a snapshot of the
 * session's email proof for this long, and quota and domain rules check those
 * proofs without an age limit, so a session key must keep verifying for this
 * long after it stops signing (scripts/deployment/session-keys.mjs). */
export const OAUTH_REFRESH_SECONDS = 30 * 24 * 60 * 60;
