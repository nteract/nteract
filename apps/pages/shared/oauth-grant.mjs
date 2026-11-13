/** How long an OAuth grant lives with refresh. Grants keep a snapshot of the
 * session's email proof for this long, and quota and domain rules check those
 * proofs without an age limit, so a session key must keep verifying for this
 * long after it stops signing (scripts/deployment/session-keys.mjs). */
export const OAUTH_REFRESH_SECONDS = 30 * 24 * 60 * 60;

/** How long after a refresh token is spent it may be spent again. A client that
 * keeps one stored token set for several processes (a CLI beside a desktop
 * app, or one per worktree) presents the same refresh token from each of them
 * when their refreshes overlap. Inside this window every one of them gets its
 * own token pair and the grant stays. A use after the window is replay, and
 * revokes the grant. The cost is that a stolen refresh token used this soon
 * after the client's own refresh is not detected. */
export const OAUTH_REFRESH_REUSE_SECONDS = 30;
