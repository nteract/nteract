import {
  appSessionHasFreshVerifiedEmail,
  readCloudAppSession,
} from "../../notebook-cloud/src/app-session.ts";
import { AuthError, type AuthenticatedConnection } from "../../notebook-cloud/src/identity.ts";
import {
  ServerOidcIdentityRejected,
  type ServerOidcEnvironment,
} from "../../notebook-cloud/src/server-oidc.ts";

export interface OperatorEnvironment extends ServerOidcEnvironment {
  OPERATOR_ALLOWED_EMAILS?: string;
  OPERATOR_METRICS_ORIGIN?: string;
  OPERATOR_METRICS_SERVICE_TOKEN?: string;
}

/** No domain grants, headers, dev tokens, API keys or provider bearer fallback. */
export function allowedEmails(env: OperatorEnvironment): string[] {
  const emails = env.OPERATOR_ALLOWED_EMAILS?.split(",").map((v) => v.trim().toLowerCase());
  if (
    !emails?.length ||
    emails.length > 32 ||
    emails.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
  )
    throw new AuthError("Operator access is not configured", 503);
  return [...new Set(emails)];
}

export function requireAllowedIdentity(
  env: OperatorEnvironment,
  identity: AuthenticatedConnection,
): void {
  const emails = allowedEmails(env);
  const reason =
    identity.metadata.provider !== "oidc"
      ? "identity_provider"
      : identity.metadata.emailVerified !== true || !identity.metadata.email
        ? "email_unverified"
        : !emails.includes(identity.metadata.email.trim().toLowerCase())
          ? "not_allowlisted"
          : null;
  if (reason) {
    // Fixed classifications only: no email, subject, token or provider response.
    console.warn(JSON.stringify({ service: "nteract-operator", event: "access_denied", reason }));
    throw new ServerOidcIdentityRejected();
  }
}

export async function authorizeOperator(request: Request, env: OperatorEnvironment) {
  const emails = allowedEmails(env);
  const session = await readCloudAppSession(env, request);
  if (!session) throw new AuthError("Sign in to view operations", 401);
  const identity: AuthenticatedConnection = {
    principal: session.principal,
    operator: "operator",
    actorLabel: "operator",
    scope: "viewer",
    metadata: {
      provider: "app-session",
      transport: "app-session-cookie",
      principalNamespace: session.principalNamespace,
      identityVerifiedAt: session.identityVerifiedAt,
      verifiedEmailBinding: session.verifiedEmailBinding,
    },
  };
  for (const email of emails) {
    if (await appSessionHasFreshVerifiedEmail(env, identity, email))
      return { displayName: session.displayName ?? "Operator", expiresAt: session.expiresAt };
  }
  throw new AuthError("Operator access denied; sign in with an allowed account", 403);
}
