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

// How long the verifier answers from one account lookup per token:
// ANACONDA_API_KEY_CACHE_TTL_MS in @cloud/identity.ts, which isn't exported.
// This must not be shorter than that value.
const PROVIDER_ANSWER_MS = 60_000;
// The verifier decides between its cached answer and a new lookup in the same
// synchronous step in which `verify` records the call's start, so the two
// clocks differ by far less than this.
const PROVIDER_CLOCK_SKEW_MS = 1000;
// Token -> when the call that may have started the verifier's current lookup
// began, oldest first. An entry lives as long as that lookup can be answered
// from.
const lookupStarts = new Map();

/** When the account answer for `token` that a call starting at `now` gets
 * stops being current. The verifier answers from one lookup for up to
 * PROVIDER_ANSWER_MS after that lookup started and doesn't say when that was,
 * so this models it per token: a call inside a recorded window is answered
 * from the lookup that opened the window, and a call just past the window may
 * get either answer, so it gets the older deadline and opens a new window. A
 * lookup that really started later, or failed, only makes the deadline earlier
 * than it had to be. */
export function providerAnswerUntil(token, now) {
  for (const [key, start] of lookupStarts) {
    if (start + PROVIDER_ANSWER_MS + PROVIDER_CLOCK_SKEW_MS > now) break;
    lookupStarts.delete(key);
  }
  const start = lookupStarts.get(token);
  if (start !== undefined && now < start + PROVIDER_ANSWER_MS) return start + PROVIDER_ANSWER_MS;
  // Re-inserted so the map stays ordered by start.
  lookupStarts.delete(token);
  lookupStarts.set(token, now);
  return (start ?? now) + PROVIDER_ANSWER_MS;
}

// What the verifier throws for a valid key whose scopes stop short of the one
// asked for.
const SCOPE_REFUSED = "Anaconda API key scopes do not allow requested scope";

/** The account an API key stands for, as an editor when the key's scopes allow
 * it and as a viewer otherwise, with `answerUntil`: when the provider answer
 * behind it, and so its verified email, stops being current (a cached answer
 * keeps its first deadline). `authorization` is the request's header as sent
 * and `token` the key inside it. Throws the verifier's error unchanged.
 * Its status tells a refused key (401) from a provider that is down or rate
 * limiting (503); auth.mjs turns each into its own refusal. */
export async function verifyApiKey(request, env, { token, authorization }) {
  // Caller identity/scope/operator headers are never forwarded to the verifier.
  const verify = (scope) =>
    // The provider cache keys on the token, whatever the scheme's case.
    apiKeyLookup(token, async () => {
      const answerUntil = providerAnswerUntil(token, Date.now());
      const connection = await authenticateAnacondaApiKeyRequest(
        new Request(request.url, {
          headers: {
            Authorization: authorization,
            "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
            "x-scope": scope,
            "x-operator": "pages-api",
          },
        }),
        env,
      );
      return { ...connection, answerUntil };
    });
  try {
    return await verify("editor");
  } catch (error) {
    if (error.message !== SCOPE_REFUSED) throw error;
    return verify("viewer");
  }
}
