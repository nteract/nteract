/** Where sign-in methods other than generic OIDC plug into the gateway.
 *
 * The gateway and the OAuth consent route call these functions and no
 * provider module directly. A deployment turns on at most one method; each
 * returns null or undefined when it isn't the one, and the first to answer
 * wins. Every browser-session renewal passes `browserSessionProvider`, so a
 * session a provider issued is never renewed through the OIDC token endpoint. */
import { handleKiloSignIn, kiloSessionProvider } from "./kilo-handoff.mjs";
import { handleTailscaleSignIn, tailscaleSessionProvider } from "./tailscale-signin.mjs";

/** The renewal provider for this deployment's browser sessions, or undefined
 * when it signs in with OIDC. */
export function browserSessionProvider(env, request) {
  return tailscaleSessionProvider(env, request) ?? kiloSessionProvider(env, request);
}

/** Answers `/api/auth/login` and the sign-in callback for a provider that
 * owns them, or null so the OIDC routes answer. */
export async function handleProviderSignIn(request, env) {
  return (await handleTailscaleSignIn(request, env)) ?? (await handleKiloSignIn(request, env));
}
