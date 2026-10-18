import {
  authenticateAnacondaApiKeyRequest,
  AuthError,
  type IdentityEnvironment,
} from "../../notebook-cloud/src/identity.ts";
import type { ServerSessionEnvironment } from "../../notebook-cloud/src/oidc-session-store.ts";
import { readAgentGrant, type AgentAccess } from "./agent-access.ts";
import { hash } from "./document.ts";
import { PageError, text } from "./errors.ts";

/** Credentials never derive an account from caller-supplied identity or driver fields. */
export async function readAgentAccess(
  env: ServerSessionEnvironment & IdentityEnvironment,
  request: Request,
): Promise<AgentAccess | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  if (token.startsWith("pages_")) return readAgentGrant(env, request);
  if (!env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL) return null;
  const namespace = env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE;
  if (
    !namespace ||
    (env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE ?? namespace) !== namespace
  )
    throw new PageError(
      "auth_configuration",
      "API keys must use the browser identity namespace",
      503,
    );
  // Only server-selected scopes reach the shared validator; query/header hints
  // from a caller cannot downgrade the mutation check or change account identity.
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
    "x-scope": "viewer",
  });
  const identity = await authenticateAnacondaApiKeyRequest(
    new Request("https://pages.internal/identity", { headers }),
    env,
  );
  const permissions: AgentAccess["permissions"] = ["read"];
  headers.set("x-scope", "editor");
  try {
    await authenticateAnacondaApiKeyRequest(
      new Request("https://pages.internal/identity", { headers }),
      env,
    );
    permissions.push("edit", "comment");
  } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 403) throw error;
  }
  const driver = text(request.headers.get("X-Pages-Driver") ?? "API client", "driver", 80).trim();
  if (!driver) throw new PageError("invalid_request", "Driver must not be empty");
  const principal = JSON.stringify([env.NOTEBOOK_CLOUD_OIDC_ISSUER, identity.principal]);
  return {
    id: `key_${await hash(JSON.stringify([env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN, principal, token, driver]))}`,
    principal,
    driver,
    display_name: identity.metadata.displayName?.slice(0, 160) ?? "",
    page_id: null,
    permissions,
    expires_at: null,
  };
}
