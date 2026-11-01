import { html } from "./oauth.mjs";

/** The Pages index a signed-in browser lands on when a callback is stale. */
export const SIGN_IN_HOME = "/pages";
const SIGN_IN_AGAIN = "/api/auth/login?" + new URLSearchParams({ return_to: SIGN_IN_HOME });

/**
 * The browser-facing OIDC callback failure. It names no cause: the coded reason
 * is logged by the callback (`auth.server_callback.failed`). Both links stay on
 * this origin, so a phone never has to retype the hostname.
 */
export function signInFailurePage({ status, accountRejected }) {
  const message = accountRejected
    ? "This account can't use Pages. Sign in again with an allowed account."
    : "Pages couldn't finish signing you in. This can happen when sign-in starts in another browser or app, or takes too long. Start again from here.";
  return html(
    "Sign-in didn't finish",
    `<p>${message}</p><p><a class="primary setup-action" href="${SIGN_IN_AGAIN}">Sign in again</a> <a href="${SIGN_IN_HOME}">Back to Pages</a></p>`,
    status,
  );
}

export const signInCallbackOptions = { homePath: SIGN_IN_HOME, failurePage: signInFailurePage };
