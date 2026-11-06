import { assertSessionKeyring, SessionKeyringError } from "@cloud/session-keyring.ts";

/**
 * A 500 for every request, `/health` included, while
 * `NOTEBOOK_CLOUD_APP_SESSION_KEYS` is malformed; null otherwise. Checking at
 * the entry point turns a bad rotation into a failed health check instead of
 * a deployment where some paths sign and others refuse. The log names the
 * problem; `SessionKeyringError` never carries a secret.
 */
export function sessionKeysFailure(env) {
  try {
    assertSessionKeyring(env);
    return null;
  } catch (error) {
    if (!(error instanceof SessionKeyringError)) throw error;
    console.error("[pages-native]", {
      service: "nteract-pages-native",
      event: "config.session_keys_invalid",
      reason: error.message,
      timestamp: new Date().toISOString(),
    });
    return Response.json(
      { error: "Pages is misconfigured", code: "server_misconfigured" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
