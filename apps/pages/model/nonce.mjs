/** A write's nonce: 6–64 letters, digits, `_` or `-`, new for each request.
 * The host keeps the write's receipt under the account, the receipt lane and
 * the nonce, so a write with a well-formed nonce is safe to repeat with the
 * same nonce and arguments: a retry returns the receipt. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
export const validNonce = (nonce) => typeof nonce === "string" && NONCE_PATTERN.test(nonce);
export const hasNonce = (args) => validNonce(args?.nonce);
