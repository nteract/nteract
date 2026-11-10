/** Bind an operation key to its exact retry window. A replacement token cannot
 * reuse a retired key after its receipt has been collected. */
export async function retryKeyPrefix(retryToken) {
  if (typeof retryToken !== "string" || !retryToken.length || retryToken.length > 8192)
    throw new TypeError("A retry token is required");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(retryToken)),
  );
  return `v1_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}_`;
}

export async function retryKey(retryToken, nonce = crypto.randomUUID()) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{8,60}$/.test(nonce))
    throw new TypeError(
      "A retry key nonce must contain 8–60 letters, digits, underscores or hyphens",
    );
  return `${await retryKeyPrefix(retryToken)}${nonce}`;
}

/** Whether a write carries a retry_token and the v1_ key it scopes, so its
 * receipt is held for the token's window and an exact retry replays. Any
 * other write is deduplicated only while its tokenless receipt is retained,
 * so after a lost response it must be reconciled, not resent. */
export function isTokenedRequest(args) {
  return (
    typeof args?.retry_token === "string" &&
    /^v1_[a-f0-9]{64}_[A-Za-z0-9_-]{8,60}$/.test(String(args?.idempotency_key ?? ""))
  );
}
