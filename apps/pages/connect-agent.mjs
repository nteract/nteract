import { pagesPublicOrigin } from "./agent-guide.mjs";
import { identityProvider } from "./identity-provider.mjs";
import {
  checkAccountCommand,
  claudeCodeAddCommand,
  claudeCodeHeaderHelper,
  codexConfig,
  codexHeaderHelper,
  keyFile,
  kiloConfig,
  kiloApiKeyConfig,
  pagesAgentEnvrc,
  saveKeyCommand,
  setupPrompt,
} from "./agent-client-setup.mjs";
import { FAVICON_LINK } from "./shared/favicon.mjs";
import { PRODUCT_NAME, tabTitle } from "./shared/product.mjs";
import { STYLESHEET, THEME_SCRIPT } from "./shared/shell-assets.mjs";
import { OAUTH_REFRESH_REUSE_SECONDS } from "./shared/oauth-grant.mjs";

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

// Provider destinations come from the deployment's identity provider, never
// from request headers or a caller-supplied return URL.
export function agentConnectionSetup(env) {
  const origin = pagesPublicOrigin(env);
  const key = identityProvider(env).apiKey;
  return {
    origin,
    endpoint: origin + "/mcp",
    apiKeyUrl: key.createUrl,
    headers: `Authorization: Bearer <YOUR_${key.envVar}>\nX-Pages-Driver: <YOUR_CLIENT_NAME>\nX-Pages-Agent: <OPTIONAL_SESSION_LABEL>`,
  };
}

export function connectAgentResponse(request, env) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const setup = agentConnectionSetup(env);
  const provider = identityProvider(env);
  const key = provider.apiKey;
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(tabTitle("Connect an agent"))}</title>${FAVICON_LINK}<script src="${THEME_SCRIPT}"></script><link rel="stylesheet" href="${STYLESHEET}"><link rel="describedby" type="text/plain" href="/llms.txt"></head>
<body><header class="app-header"><a class="brand" href="/">${escapeHtml(PRODUCT_NAME)}</a><a class="setup-guide-link" href="/llms.txt">Agent guide</a></header>
<main class="agent-setup">
  <h1>Connect an agent</h1>
  <p class="setup-intro">Let your agent read, edit, and comment on your Pages.</p>
  <p>Coding agents, CLIs, and scripts connect with an ${key.name}. ChatGPT and other interactive cloud clients sign in with OAuth. Your agent can prepare the settings while you create a key or authorize access.</p>
  <details class="setup-details"><summary>Give your agent the setup steps</summary>
    <pre class="setup-value setup-prose"><code id="setup-prompt">${escapeHtml(setupPrompt(setup.origin))}</code></pre>
    <button type="button" class="setup-copy" data-copy="setup-prompt" data-copy-message="Setup instructions copied. Paste them into your agent chat." hidden>Copy setup instructions</button>
  </details>
  <h2 id="setup-api-key-clients">Coding agents and scripts: use an API key</h2>
  <p>Use an API key for Kilo, Claude Code, Codex, scripts, and anything that runs long or unattended. The key works until the expiration you choose. Any number of agents and processes can share it, and nothing needs to refresh it.</p>
  <p>Create and save the key first. Your agent can prepare a config draft while you do this; tell it when the key is ready. Keep the key out of chat.</p>
  <section aria-labelledby="setup-key"><h2 id="setup-key"><span>1</span> Create an API key</h2>${key.connectInstructions}</section>
  <section aria-labelledby="setup-save"><h2 id="setup-save"><span>2</span> Save it privately</h2>
    <p>Kilo, Claude Code, and Codex can use the same local key file: <code>${keyFile}</code>. Your agent configures the connection; you enter the key.</p>
    <p>For multiple accounts, use an account-specific filename such as <code>${keyFile}-rgbkrk</code>; the path above remains the default. Inspect filenames, not secrets, in <code>~/.config/pages</code>, and ask before reusing or replacing an existing key. Use the chosen path consistently in the save command, Kilo file reference, and the Codex and Claude Code helpers. Use a separate helper filename per account so existing clients keep their key.</p>
    <details class="setup-details"><summary>Save the key on macOS or Linux</summary>
      <p>Copy this command into your own terminal. It uses Python 3 to ask for the key with input hidden. Paste the raw key when prompted, then press Enter.</p>
      <pre class="setup-value"><code id="save-key-command">${escapeHtml(saveKeyCommand)}</code></pre>
      <button type="button" class="setup-copy" data-copy="save-key-command" data-copy-message="Command copied. Run it in your own terminal, then paste the key at the hidden prompt." hidden>Copy save command</button>
      <p class="setup-note">This refuses to overwrite an existing file and allows only your user to read or write a new one. Change the path in the command for an account-specific file. If you don't have Python 3, ask your agent to prepare an equivalent private local file without overwriting an existing key and enter the key there yourself. The key never goes through this page.</p>
    </details>
    <p>Once saved, tell your agent the chosen filename, not the key: <q>The key is ready. Finish setup, reload MCP or start a new session, then call list_pages to verify it.</q></p>
  </section>
  <section aria-labelledby="setup-client"><h2 id="setup-client"><span>3</span> Connect your client</h2>
    <p>Your agent can apply the matching recipe below after the key is saved. It should preserve your other settings.</p>
    <details class="setup-details" id="kilo"><summary>Kilo Desktop / CLI</summary>
      <p>Merge into <code>~/.config/kilo/kilo.jsonc</code>, the global config (or your customized XDG config directory). Use this after the key file exists and is nonempty.</p>
      <pre class="setup-value"><code id="kilo-api-key-config">${escapeHtml(kiloApiKeyConfig(setup.origin))}</code></pre>
      <button type="button" class="setup-copy" data-copy="kilo-api-key-config" data-copy-message="Kilo config copied. Merge it into global config after saving your key." hidden>Copy API-key config</button>
      <p><code>oauth: false</code> keeps this recipe on API-key authentication. Don't use <code>kilo mcp auth</code> with this recipe. If your Pages entry uses OAuth today, replace its <code>oauth</code> object with <code>oauth: false</code> and add the <code>Authorization</code> header. Reload the server or restart Kilo, then ask it to list your Pages.</p>
      <p><code>X-Pages-Agent</code> is an optional session label. See <a href="#session-labels">Name each session</a> below.</p>
      <p class="setup-note">This is the Desktop/CLI format. Project configs and the older VS Code extension use different rules. <a href="https://kilo.ai/docs/automate/mcp/using-in-cli">Kilo configuration reference</a></p>
    </details>
    <details class="setup-details" id="codex"><summary>Codex Desktop / CLI</summary>
      <p>Ask your agent to save this helper as <code>~/.config/pages/mcp-headers.py</code>. It contains no secret. Codex runs it to read your key; don't run it in chat or print its output.</p>
      <pre class="setup-value"><code id="codex-helper">${escapeHtml(codexHeaderHelper)}</code></pre>
      <button type="button" class="setup-copy" data-copy="codex-helper" data-copy-message="Helper code copied. Save it as ~/.config/pages/mcp-headers.py; Codex runs it privately." hidden>Copy header helper</button>
      <p>Merge this into <code>~/.codex/config.toml</code> (or your configured CODEX_HOME). Replace both placeholders with absolute paths, using <code>command -v python3</code> to locate Python.</p>
      <pre class="setup-value"><code id="codex-config">${escapeHtml(codexConfig(setup.origin))}</code></pre>
      <button type="button" class="setup-copy" data-copy="codex-config" data-copy-message="Codex config copied. Fill in the two absolute paths before merging it into your config." hidden>Copy Codex config</button>
      <p>Use a current Codex release with local HTTP header helpers. Remove any previous <code>bearer_token_env_var</code> or Authorization header for this server; they take precedence. Reload MCP, then ask it to list your Pages.</p>
      <p>To label sessions, add <code>env_http_headers = { "X-Pages-Agent" = "PAGES_AGENT" }</code>. Codex reads the label from that environment variable.</p>
      <p class="setup-note">This works without desktop shell environment variables. Remote execution placement needs its own credential setup. <a href="https://developers.openai.com/codex/mcp">Codex configuration reference</a></p>
    </details>
    <details class="setup-details" id="claude-code"><summary>Claude Code</summary>
      <p>Ask your agent to save this helper as <code>~/.config/pages/claude-code-headers.py</code>. It contains no secret. Claude Code runs it to read your key; don't run it in chat or print its output.</p>
      <pre class="setup-value"><code id="claude-code-helper">${escapeHtml(claudeCodeHeaderHelper)}</code></pre>
      <button type="button" class="setup-copy" data-copy="claude-code-helper" data-copy-message="Helper code copied. Save it as ~/.config/pages/claude-code-headers.py; Claude Code runs it privately." hidden>Copy header helper</button>
      <p>Then register the server at user scope. Replace both placeholders with absolute paths that contain no spaces, using <code>command -v python3</code> to locate Python.</p>
      <pre class="setup-value"><code id="claude-code-add">${escapeHtml(claudeCodeAddCommand(setup.origin))}</code></pre>
      <button type="button" class="setup-copy" data-copy="claude-code-add" data-copy-message="Command copied. Fill in the two absolute paths, then run it in your terminal." hidden>Copy add command</button>
      <p>Claude Code runs the helper on every connection and gives it 10 seconds. The helper's <code>Authorization</code> header replaces any static one, and Claude Code doesn't fall back to OAuth for this server. User scope skips the folder-trust prompt that project-scoped <code>.mcp.json</code> entries need before a helper runs.</p>
      <p>Don't use <code>claude mcp add --header "Authorization: Bearer ..."</code>. It writes your key into <code>~/.claude.json</code>.</p>
      <p>Until the key is saved, <code>claude mcp get pages</code> reports "Needs authentication". After you save it, reload MCP or start a new session, then ask Claude Code to list your Pages.</p>
      <p>To label sessions, set <code>PAGES_AGENT</code> in the environment you start Claude Code from. The helper sends it as <code>X-Pages-Agent</code>. See <a href="#session-labels">Name each session</a> below.</p>
      <p class="setup-note">Configuration alone doesn't verify access. Check the connection in step 4. <a href="https://code.claude.com/docs/en/mcp">Claude Code MCP reference</a></p>
    </details>
    <details class="setup-details" id="other-client"><summary>Other MCP clients</summary>
    <p>Use this for clients without a header helper. Add a remote MCP server using <strong>Streamable HTTP</strong>.</p>
    <div class="setup-field-label"><h3>Server URL</h3><button type="button" class="setup-copy" data-copy="mcp-endpoint" aria-label="Copy server URL" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <div class="setup-field-label"><h3>Headers</h3><button type="button" class="setup-copy" data-copy="mcp-headers" aria-label="Copy headers" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-headers">${escapeHtml(setup.headers)}</code></pre>
    <p class="setup-note">Replace the placeholders in your client with your key and its name, such as Cursor. Drop <code>X-Pages-Agent</code> if you don't want a session label. Keep the key in the client's secret settings, outside chats and documents. Signing in to Pages does not sign in your MCP client.</p>
    </details>
    <details class="setup-details" id="session-labels"><summary>Name each session</summary>
      <p>Two headers name the agent in a Page. <code>X-Pages-Driver</code> is the harness, such as Kilo. <code>X-Pages-Agent</code> is a short session label, such as "release agent", at most 80 characters. A blank value means no label. A caret then reads "Kyle's Kilo · release agent".</p>
      <p>Both labels are self-declared. Pages always shows them under the account the key authenticates. They don't change who made an edit or what the key can access.</p>
      <p>The Kilo recipe above uses one shared entry with <code>"X-Pages-Agent": "{env:PAGES_AGENT}"</code>. Kilo fills in the variable when it loads config. Set it per worktree, for example in the worktree's <code>.envrc</code>:</p>
      <pre class="setup-value"><code id="pages-agent-envrc">${escapeHtml(pagesAgentEnvrc)}</code></pre>
      <button type="button" class="setup-copy" data-copy="pages-agent-envrc" data-copy-message="Label line copied. Add it to the worktree's .envrc, then start Kilo from that shell." hidden>Copy .envrc line</button>
      <p>Start Kilo from a shell that has the variable. When it's unset, Kilo sends an empty header, and Pages shows no label.</p>
      <p>The Claude Code helper and the Codex <code>env_http_headers</code> line read the same <code>PAGES_AGENT</code> variable. Start those clients from a shell that has it.</p>
      <p class="setup-note">Labels are optional. Each MCP session already gets its own caret through <code>Mcp-Session-Id</code>, so two unlabeled sessions on one key still show separately.</p>
    </details>
    <details class="setup-details" id="client-model"><summary>Name your client and model</summary>
      <p>Two more optional headers tell Pages which harness and model made a request. <code>X-Pages-Client</code> is <code>&lt;harness&gt;/&lt;version&gt;</code>, such as <code>claude-code/2.1.0</code>. <code>X-Pages-Model</code> is the model id, such as <code>anthropic/claude-opus-5.5</code>.</p>
      <p>Pages records them in usage telemetry only. They never affect access. Send printable ASCII, at most 120 characters each; longer values are truncated. Without <code>X-Pages-Client</code>, Pages uses the MCP client's name and version from <code>initialize</code>. MCP has no model field, so send <code>X-Pages-Model</code> when you know it.</p>
    </details>
  </section>
  <section aria-labelledby="setup-try"><h2 id="setup-try"><span>4</span> Check the connection</h2>
    <p><strong>Reload MCP or start a new session, then call <code>list_pages</code> from that session.</strong> A successful response, even an empty list, means you're connected. A config file or a client status label alone doesn't verify access.</p>
    <p>Check the returned <code>account</code> before proceeding if it is unexpected. <code>list_pages</code> and authenticated <code>GET /whoami</code> return the same account summary: <code>principal</code>, <code>display_name</code> (which may be null), and <code>email</code> only when the provider supplies a verified email. <code>/whoami</code> also returns credential <code>kind</code> and <code>can_write</code>, not expiry. Write scope does not override Page sharing permissions.</p>
    <details class="setup-details"><summary>Check an API key's account over HTTP</summary>
      <p>After confirming the chosen key, run this private-file check with Python 3. Change its path to your account-specific filename. It refuses redirects and prints only the account and credential summary, never the key or response error bodies. This checks HTTP authentication without changing any Pages; it does not replace MCP reload and <code>list_pages</code> verification.</p>
      <pre class="setup-value"><code id="check-account-command">${escapeHtml(checkAccountCommand(setup.origin))}</code></pre>
      <button type="button" class="setup-copy" data-copy="check-account-command" data-copy-message="Account check copied. Confirm the key file path before running it in your terminal." hidden>Copy account check</button>
    </details>
    <p class="setup-note"><code>quota.count</code> counts active owned Pages, excluding shared Pages; <code>quota.trash_count</code> counts your trashed Pages separately. Counts include pending creations and lifecycle reservations in owned catalog slots. These are account-wide counts, not the number of results shown. A null <code>content_updated_at</code> means no content edit time is recorded, including for new Pages and legacy Pages; don't invent an edit timestamp from other dates.</p>
    <p class="setup-note">If it fails, check that the key is saved, unexpired, and belongs to this deployment's ${provider.label} environment. Missing access to one Page can also mean it hasn't been shared with that account.</p>
    <p class="setup-note">For CLI setup, tool details, and troubleshooting, read the <a href="/llms.txt">agent guide</a>.</p>
  </section>
  <section aria-labelledby="setup-oauth"><h2 id="setup-oauth">ChatGPT and cloud clients: use OAuth</h2>
    <p>Add a custom MCP server in your client's connection settings, choose <strong>OAuth</strong>, and enter this server URL:</p>
    <pre class="setup-value"><code id="oauth-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <button type="button" class="setup-copy" data-copy="oauth-endpoint" data-copy-message="Server URL copied. Add it to your client's MCP connections and choose OAuth." hidden>Copy server URL</button>
    <p>Follow the client's sign-in link, check your Pages account and permissions, then approve access. You don't need to create or transfer an API key.</p>
    <p>Access tokens last 10 minutes. Each refresh token is replaced on use. The client refreshes on its next request, so nothing has to run in the background. The connection ends 30 days after you approve it, however often it refreshes. After that, authorize again.</p>
    <p><strong>Several processes can share one OAuth connection.</strong> Kilo Desktop, the CLI, and your worktrees use the same stored tokens, and when two of them refresh in the same moment each gets its own. Don't copy the stored tokens to another machine. A refresh token used more than ${OAUTH_REFRESH_REUSE_SECONDS} seconds after another process spent it is treated as replayed, and Pages revokes the whole connection. For unattended work, use an API key: nothing has to refresh it.</p>
    <p class="setup-note">This deployment supports the ChatGPT OAuth client. Client metadata and permissions are discovered automatically. If your client asks for manual details or reports a different callback, follow the <a href="/llms.txt">agent guide</a>. Other OAuth clients need deployment support.</p>
    <details class="setup-details" id="kilo-oauth"><summary>Kilo with OAuth</summary>
      <p>OAuth fits Kilo when you don't want to manage a key. Kilo Desktop, the CLI, and your worktrees share one connection. It ends after 30 days and you authorize again; the API-key recipe above has no such limit.</p>
      <p>Merge into <code>~/.config/kilo/kilo.jsonc</code> (or your customized XDG config directory), preserving other settings.</p>
      <pre class="setup-value"><code id="kilo-config">${escapeHtml(kiloConfig(setup.origin))}</code></pre>
      <button type="button" class="setup-copy" data-copy="kilo-config" data-copy-message="Kilo OAuth config copied. Merge it into global config, then run kilo mcp auth pages." hidden>Copy Kilo config</button>
      <p>For an existing Pages connection, remove its <code>Authorization</code> header and replace <code>oauth: false</code> with the OAuth settings above. Keep <code>X-Pages-Driver</code>. Leave the old key file alone; other clients may use it.</p>
      <pre class="setup-value"><code id="kilo-login">kilo mcp auth pages</code></pre>
      <button type="button" class="setup-copy" data-copy="kilo-login" data-copy-message="Login command copied. Run it and follow the browser sign-in link." hidden>Copy login command</button>
      <p>Complete the browser sign-in and approve access. Reload the Pages server or restart Kilo Desktop, then ask it to list your Pages. If it later needs authorization, run the login command again.</p>
      <p class="setup-note">Use the configured client ID shown above; no client secret or API key is needed. <a href="/llms.txt">Full recipe and troubleshooting</a></p>
    </details>
  </section>
  <p class="setup-copy-status" role="status" aria-live="polite"></p>
</main><script type="module" src="/connect.js"></script></body></html>`;
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
