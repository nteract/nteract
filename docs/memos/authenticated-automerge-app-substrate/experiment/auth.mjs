import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Find the production verifier without fixing the fixture's repository depth. */
function defaultIdentityModuleUrl() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(directory, "apps/notebook-cloud/src/identity.ts");
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate production identity.ts");
    directory = parent;
  }
}

function normalizedNamespace(value, fallback) {
  return value?.trim().replace(/:+$/, "") || fallback;
}

function driverLabel(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new Error("A nonempty driver label of at most 128 characters is required");
  }
  return value.trim();
}

/**
 * Trusted-host adapter, not an HTTP login endpoint. This calls the existing
 * provider verifiers; it does not implement OAuth login, PKCE, cookies, refresh,
 * API-key signature verification, or provider revocation itself.
 *
 * An OIDC login caller must already own and validate its state/PKCE transaction
 * and pass that transaction's nonce. The resulting canWrite is a credential
 * ceiling, never a document grant. Host ACLs and managed-document policy still
 * apply. Driver is session-bound display context, not verified vendor identity.
 */
export async function createAuthenticator({
  identityModuleUrl = defaultIdentityModuleUrl(),
  env,
  now = Date.now,
  apiKeySessionTtlMs = 60_000,
}) {
  if (
    !Number.isSafeInteger(apiKeySessionTtlMs) ||
    apiKeySessionTtlMs <= 0 ||
    apiKeySessionTtlMs > 60_000
  ) {
    throw new Error("API-key admission lifetime must be between 1 and 60000 ms");
  }
  const production = await import(identityModuleUrl);
  // Experimental namespace policy deliberately differs from production defaults:
  // production OIDC uses user:oidc and API-key falls back to OIDC namespace, then
  // user:anaconda. Here issuer/endpoint domains remain separate unless both are
  // explicitly configured. This is not a production identity migration. An email,
  // client-supplied principal, or matching display name never links accounts.
  const issuer = env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim().replace(/\/+$/, "");
  const endpoint = env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL?.trim();
  const config = Object.freeze({
    ...env,
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: normalizedNamespace(
      env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
      `user:oidc:${encodeURIComponent(issuer ?? "unconfigured")}`,
    ),
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: normalizedNamespace(
      env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE,
      `user:api-key:${encodeURIComponent(endpoint ?? "unconfigured")}`,
    ),
  });
  const verified = new WeakSet();
  function admit(identity) {
    production.validatePrincipal(identity.principal);
    if (!Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now()) {
      throw new Error("Credential has expired");
    }
    const result = Object.freeze(identity);
    verified.add(result);
    return result;
  }

  return Object.freeze({
    isVerifiedIdentity: (identity) => verified.has(identity),

    async authenticateOidcIdToken(token, { nonce, driver }) {
      if (typeof nonce !== "string" || !nonce) {
        throw new Error("The trusted login transaction nonce is required");
      }
      const claims = await production.verifyOidcIdToken(config, token, {
        nonce,
        nowSeconds: Math.floor(now() / 1000),
      });
      const principal = `${config.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE}:${production.encodePrincipalComponent(claims.sub)}`;
      const displayName =
        claims.name?.trim() ||
        [claims.given_name, claims.family_name].filter(Boolean).join(" ").trim() ||
        claims.preferred_username?.trim() ||
        claims.email?.trim() ||
        principal;
      return admit({
        principal,
        displayName,
        credentialKind: "oidc",
        expiresAt: claims.exp * 1000,
        canWrite: true,
        driver: driverLabel(driver),
      });
    },

    async authenticateApiKey(token, { driver, write = false }) {
      if (typeof token !== "string" || !token.trim()) throw new Error("API key is required");
      if (typeof write !== "boolean") throw new Error("write must be boolean");
      // Only generated headers reach the production verifier. No caller-supplied
      // trusted identity headers, display names, scopes, or operators are copied.
      const request = new Request("https://authenticated-spike.invalid/credential", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
          "x-scope": write ? "editor" : "viewer",
          "x-operator": "authenticated-automerge-spike",
        },
      });
      const identity = await production.authenticateAnacondaApiKeyRequest(request, config);
      return admit({
        principal: identity.principal,
        displayName: identity.metadata.displayName ?? identity.principal,
        credentialKind: "api-key",
        // whoami has no trusted expiry in the current verifier result. This is
        // a host admission lease, not the API key's claimed expiration. Its
        // provider cache lasts up to 60s; renewal is not immediate revocation.
        expiresAt: now() + apiKeySessionTtlMs,
        canWrite: identity.scope === "editor",
        driver: driverLabel(driver),
      });
    },
  });
}
