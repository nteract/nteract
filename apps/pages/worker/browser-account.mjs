import { readServerAccountEmail } from "@nteract/session";
import { recordOidcEvent } from "./auth-events.mjs";
import { rememberedServerAppSession } from "./session-memo.mjs";

// Every Pages sign-in and renewal uses the same private profile policy,
// including the browser session renewed while connecting an OAuth client.
export const browserSessionOptions = Object.freeze({
  onAuthEvent: recordOidcEvent,
  retainAccountEmail: true,
});

/** Private shell metadata for /api/auth/session, separate from the identity peers see. */
export async function browserAccountMenu(request, env, identity) {
  if (identity.credentialKind !== "oidc") return {};
  // The exchange uses the id as a placeholder for an unnamed organization.
  const names = (identity.organizations ?? [])
    .filter(({ id, name }) => name !== id && !name.includes("@"))
    .map(({ name }) => name);
  if (names.length) return { accountMenu: { organizations: names } };
  const session = await rememberedServerAppSession(env, request);
  if (session?.principal !== identity.principal) return {};
  const email = await readServerAccountEmail(env, session);
  return email ? { accountMenu: { email } } : {};
}
