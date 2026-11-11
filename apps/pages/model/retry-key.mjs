/** Whether a write carries a retry_token with a key the host accepts, so its
 * receipt is held for the token's window and an exact retry replays. The key
 * is the caller's own nonce; the host scopes it to the token. Any other write
 * is deduplicated only while its tokenless receipt is retained, so after a
 * lost response it must be reconciled, not resent. */
export function isTokenedRequest(args) {
  const key = String(args?.idempotency_key ?? "");
  return (
    typeof args?.retry_token === "string" &&
    /^[A-Za-z0-9_-]{8,128}$/.test(key) &&
    !key.startsWith("v1_")
  );
}
