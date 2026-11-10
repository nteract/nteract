/** Checking an agent's API key with the deployment's identity provider.
 *
 * Anaconda is the only provider (identity-provider.mjs), so this asks its
 * account service through the notebook cloud's verifier. A second provider
 * with keys of its own is chosen here; auth.mjs only sees `verifyApiKey`. */
import { authenticateAnacondaApiKeyRequest } from "@cloud/identity.ts";
import { isolateSingleFlight } from "./isolate-setup.mjs";

// One lookup per token at a time in this isolate (isolate-setup.mjs). The hold
// outlasts the verifier's own cache of a lookup, which it keeps for 60 s
// (ANACONDA_API_KEY_CACHE_TTL_MS in @cloud/identity.ts).
const apiKeyLookup = isolateSingleFlight({ holdMs: 65_000 });

// What the verifier throws for a valid key whose scopes stop short of the one
// asked for.
const SCOPE_REFUSED = "Anaconda API key scopes do not allow requested scope";

/** The account an API key stands for, as an editor when the key's scopes allow
 * it and as a viewer otherwise. `authorization` is the request's header as
 * sent and `token` the key inside it. Throws the verifier's error unchanged.
 * Its status tells a refused key (401) from a provider that is down or rate
 * limiting (503); auth.mjs turns each into its own refusal. */
export async function verifyApiKey(request, env, { token, authorization }) {
  // Caller identity/scope/operator headers are never forwarded to the verifier.
  const verify = (scope) =>
    // The provider cache keys on the token, whatever the scheme's case.
    apiKeyLookup(token, () =>
      authenticateAnacondaApiKeyRequest(
        new Request(request.url, {
          headers: {
            Authorization: authorization,
            "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
            "x-scope": scope,
            "x-operator": "pages-api",
          },
        }),
        env,
      ),
    );
  try {
    return await verify("editor");
  } catch (error) {
    if (error.message !== SCOPE_REFUSED) throw error;
    return verify("viewer");
  }
}
