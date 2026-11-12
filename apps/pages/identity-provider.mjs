/** The identity provider a deployment signs people and agents in with.
 *
 * Everything Pages says or checks that depends on the provider comes from this
 * description: its name, the credential a coding agent sends, where a person
 * creates one, the file and variables the setup recipes use, whether the
 * provider vouches for an email address, and the company domains an owner may
 * open a Page to. The agent guide (/llms.txt), the connect page, the setup
 * recipes and the auth refusals read it; none of them names a provider itself
 * (test/identity-provider.test.mjs holds them to that).
 *
 * Two providers exist. A deployment with `PAGES_KILO_APP_URL` set signs in
 * with Kilo accounts; every other deployment signs in with Anaconda.
 * `identityProvider` picks between them from the deployment's settings.
 *
 * `apiKey` is null for a provider with no long-lived keys. Readers of the
 * description branch on it: the guide and the connect page leave out their
 * API-key sections, the setup prompt asks for OAuth only, and `authenticate`
 * refuses a bearer that is not a Pages OAuth access token without asking the
 * provider about it. A reader that needs a key's name or path reads it from
 * `apiKey` only after checking it is not null. */

// The production Anaconda account service. A deployment that verifies keys
// anywhere else has no known page where a person creates one.
const ANACONDA_PRODUCTION_USERINFO = [
  "https://anaconda.com/api/auth/sessions/whoami",
  "https://auth.anaconda.com/api/auth/sessions/whoami",
];
const ANACONDA_KEY_HOME_PATH = ".config/pages/anaconda-api-key";

// The agent guide's steps for creating a key, after its own heading and link
// to the connect page.
const ANACONDA_CREATE_GUIDE = `For production Anaconda, open https://anaconda.com/app/profile/api-keys and sign
in with the same account you use for Pages. Choose Create API Key, name it for
your client (for example "Pages - Kilo"), and set:

- User Resources: Read and write for editing (cloud:read + cloud:write), or
  Read-only for reading (cloud:read).
- Platform Channels: No access. Pages does not need package repository access.
- Expiration: choose the duration you need.

Copy the newly created key into your MCP client's secret/header configuration;
Anaconda shows the secret only when it is created. Naming a key for Pages does
not scope it exclusively to Pages: User Resources is an Anaconda account scope.
Pages also enforces the account's per-Page viewer/editor/owner permissions.
Official instructions: https://www.anaconda.com/docs/anaconda-platform/user/api-keys

If you already use the anaconda-auth CLI, it can supply an explicitly authorized
key through its supported command. This is optional; do not install it just for
MCP setup. The browser route above is the default:

\`\`\`sh
export ANACONDA_API_KEY="$(anaconda auth api-key --at anaconda.com)"
\`\`\`

The last command captures the key without printing it. The CLI normally requests
repository access too; the browser flow above lets you create a dedicated key
with just User Resources. CLI documentation: https://anaconda.github.io/anaconda-auth/

The account URL and CLI commands above are for production Anaconda. For a staging
deployment, use its Anaconda account site and matching CLI --at domain instead;
a production key will not work. If the client already has ANACONDA_AUTH_API_KEY,
it can use that value as the bearer key; ANACONDA_API_KEY is the variable name in
these examples. The service receives the header, not the environment variable.`;

const anacondaConnectInstructions = (createUrl) =>
  createUrl
    ? `<p>Sign in to Anaconda with the account you use for Pages, then create a key named for your client.</p>
      <dl class="setup-permissions">
        <div><dt>User Resources</dt><dd>Read and write <span>(or Read-only)</span></dd></div>
        <div><dt>Platform Channels</dt><dd>No access</dd></div>
      </dl>
      <p>Choose an expiration and copy the key. It is shown only once. Save it in step 2 before closing the Anaconda tab.</p>
      <a class="primary setup-action" href="${createUrl}" target="_blank" rel="noopener noreferrer">Create API key <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>
      <p class="setup-note">This key has Anaconda User Resources permissions, not just Pages access. Each Page's sharing permissions still apply.</p>`
    : `<p>Ask the deployment owner for the API-key setup instructions for this identity provider. This deployment does not use the standard production Anaconda key endpoint.</p>
      <p class="setup-note">Production and staging credentials are separate. Use a key for this deployment's provider.</p>`;

const KILO = Object.freeze({
  id: "kilo",
  /** What people call the provider, in running text. */
  label: "Kilo",
  /** Email domains an owner may open a Page to for viewing. Kilo has none. */
  companyDomains: Object.freeze([]),
  /** The long-lived credential coding agents and scripts send as a bearer.
   * Null when the provider has no such credential: agents connect by OAuth. */
  apiKey: null,
  /** Whether every account carries an email address the provider has
   * verified. Kilo vouches for an address only on accounts where it holds
   * proof (kilo-exchange.mjs), so here only those accounts can accept an
   * invitation by email. */
  verifiedEmail: false,
});

/** The description of the provider this deployment signs in with. */
export function identityProvider(env) {
  if (env?.PAGES_KILO_APP_URL) return KILO;
  return anacondaProvider(env ?? {});
}

function anacondaProvider(env) {
  const createUrl = ANACONDA_PRODUCTION_USERINFO.includes(
    env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL,
  )
    ? "https://anaconda.com/app/profile/api-keys"
    : null;
  return {
    id: "anaconda",
    /** What people call the provider, in running text. */
    label: "Anaconda",
    /** Email domains an owner may open a Page to for viewing. A deployment
     * turns each on with PAGES_COMPANY_VIEW_DOMAINS; it cannot add others. */
    companyDomains: ["anaconda.com"],
    /** Whether every account carries an email address the provider has
     * verified. Where it is false, only the accounts the provider vouches for
     * can accept an invitation by email. */
    verifiedEmail: true,
    /** The long-lived credential coding agents and scripts send as a bearer. */
    apiKey: {
      name: "Anaconda API key",
      /** The variable the recipes read the key from, and the one the
       * provider's own CLI sets. */
      envVar: "ANACONDA_API_KEY",
      alternateEnvVar: "ANACONDA_AUTH_API_KEY",
      /** Where the recipes keep the key: under the home directory, and as a
       * person writes it. */
      homePath: ANACONDA_KEY_HOME_PATH,
      keyFile: "~/" + ANACONDA_KEY_HOME_PATH,
      /** The page where a person creates a key, or null when this deployment's
       * provider environment has no known one. */
      createUrl,
      createGuide: ANACONDA_CREATE_GUIDE,
      /** Step 1 of the connect page, as HTML. */
      connectInstructions: anacondaConnectInstructions(createUrl),
    },
  };
}
