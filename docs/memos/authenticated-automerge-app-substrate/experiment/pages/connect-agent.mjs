import { pagesPublicOrigin } from "./agent-guide.mjs";
import {
  codexConfig,
  codexHeaderHelper,
  keyFile,
  kiloConfig,
  kiloApiKeyConfig,
  pagesAgentEnvrc,
  saveKeyCommand,
  setupPrompt,
} from "./agent-client-setup.mjs";
import { STYLESHEET, THEME_SCRIPT } from "./shared/shell-assets.mjs";

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

// Provider destinations are fixed, never inferred from request headers or a
// caller-supplied return URL. Unknown providers get operator setup instructions.
export function agentConnectionSetup(env) {
  const origin = pagesPublicOrigin(env);
  const production = [
    "https://anaconda.com/api/auth/sessions/whoami",
    "https://auth.anaconda.com/api/auth/sessions/whoami",
  ].includes(env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL);
  return {
    origin,
    endpoint: origin + "/mcp",
    apiKeyUrl: production ? "https://anaconda.com/app/profile/api-keys" : null,
    headers:
      "Authorization: Bearer <YOUR_ANACONDA_API_KEY>\nX-Pages-Driver: <YOUR_CLIENT_NAME>\nX-Pages-Agent: <OPTIONAL_SESSION_LABEL>",
  };
}

export function connectAgentResponse(request, env) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const setup = agentConnectionSetup(env);
  const keyInstructions = setup.apiKeyUrl
    ? `<p>Sign in to Anaconda with the account you use for Pages, then create a key named for your client.</p>
      <dl class="setup-permissions">
        <div><dt>User Resources</dt><dd>Read and write <span>(or Read-only)</span></dd></div>
        <div><dt>Platform Channels</dt><dd>No access</dd></div>
      </dl>
      <p>Choose an expiration and copy the key. It is shown only once. Save it in step 2 before closing the Anaconda tab.</p>
      <a class="primary setup-action" href="${setup.apiKeyUrl}" target="_blank" rel="noopener noreferrer">Create API key <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>
      <p class="setup-note">This key has Anaconda User Resources permissions, not just Pages access. Each Page's sharing permissions still apply.</p>`
    : `<p>Ask the deployment owner for the API-key setup instructions for this identity provider. This deployment does not use the standard production Anaconda key endpoint.</p>
      <p class="setup-note">Production and staging credentials are separate. Use a key for this deployment's provider.</p>`;
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an agent · Pages</title><script src="${THEME_SCRIPT}"></script><link rel="stylesheet" href="${STYLESHEET}"><link rel="describedby" type="text/plain" href="/llms.txt"></head>
<body><header class="app-header"><a class="brand" href="/">Pages</a><a class="setup-guide-link" href="/llms.txt">Agent guide</a></header>
<main class="agent-setup">
  <h1>Connect an agent</h1>
  <p class="setup-intro">Let your agent read, edit, and comment on your Pages.</p>
  <p>Coding agents, CLIs, and scripts connect with an Anaconda API key. ChatGPT and other interactive cloud clients sign in with OAuth. Your agent can prepare the settings while you create a key or authorize access.</p>
  <details class="setup-details"><summary>Give your agent the setup steps</summary>
    <pre class="setup-value"><code id="setup-prompt">${escapeHtml(setupPrompt(setup.origin))}</code></pre>
    <button type="button" class="setup-copy" data-copy="setup-prompt" data-copy-message="Setup instructions copied. Paste them into your agent chat." hidden>Copy setup instructions</button>
  </details>
  <h2 id="setup-api-key-clients">Coding agents and scripts: use an API key</h2>
  <p>Use an API key for Kilo, Claude Code, Codex, scripts, and anything that runs long or unattended. The key works until the expiration you choose. Any number of agents and processes can share it, and nothing needs to refresh it.</p>
  <p>Create and save the key first. Your agent can prepare a config draft while you do this; tell it when the key is ready. Keep the key out of chat.</p>
  <section aria-labelledby="setup-key"><h2 id="setup-key"><span>1</span> Create an API key</h2>${keyInstructions}</section>
  <section aria-labelledby="setup-save"><h2 id="setup-save"><span>2</span> Save it privately</h2>
    <p>Kilo and Codex can use the same local key file: <code>${keyFile}</code>. Your agent configures the connection; you enter the key.</p>
    <details class="setup-details"><summary>Save the key on macOS or Linux</summary>
      <p>Copy this command into your own terminal. It uses Python 3 to ask for the key with input hidden. Paste the raw key when prompted, then press Enter.</p>
      <pre class="setup-value"><code id="save-key-command">${escapeHtml(saveKeyCommand)}</code></pre>
      <button type="button" class="setup-copy" data-copy="save-key-command" data-copy-message="Command copied. Run it in your own terminal, then paste the key at the hidden prompt." hidden>Copy save command</button>
      <p class="setup-note">This replaces the key in that file and allows only your user to read or write it. If you don't have Python 3, ask your agent to prepare a private local file and enter the key there yourself. The key never goes through this page.</p>
    </details>
    <p>Once saved, tell your agent: <q>The key is ready in ${keyFile}. Finish setup and call list_pages to verify it.</q></p>
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
      <p>Use a current Codex release with local HTTP header helpers (checked with CLI 0.156.1). Remove any previous <code>bearer_token_env_var</code> or Authorization header for this server; they take precedence. Reload MCP, then ask it to list your Pages.</p>
      <p>To label sessions, add <code>env_http_headers = { "X-Pages-Agent" = "PAGES_AGENT" }</code>. Codex reads the label from that environment variable.</p>
      <p class="setup-note">This works without desktop shell environment variables. Remote execution placement needs its own credential setup. <a href="https://developers.openai.com/codex/mcp">Codex configuration reference</a></p>
    </details>
    <details class="setup-details" id="other-client"><summary>Claude Code and other MCP clients</summary>
    <p>Add a remote MCP server using <strong>Streamable HTTP</strong>.</p>
    <div class="setup-field-label"><h3>Server URL</h3><button type="button" class="setup-copy" data-copy="mcp-endpoint" aria-label="Copy server URL" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <div class="setup-field-label"><h3>Headers</h3><button type="button" class="setup-copy" data-copy="mcp-headers" aria-label="Copy headers" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-headers">${escapeHtml(setup.headers)}</code></pre>
    <p class="setup-note">Replace the placeholders in your client with your key and its name, such as Claude Code. Drop <code>X-Pages-Agent</code> if you don't want a session label. Keep the key in the client's secret settings, outside chats and documents. Signing in to Pages does not sign in your MCP client.</p>
    </details>
    <details class="setup-details" id="session-labels"><summary>Name each session</summary>
      <p>Two headers name the agent in a Page. <code>X-Pages-Driver</code> is the harness, such as Kilo. <code>X-Pages-Agent</code> is a short session label, such as "release agent", at most 80 characters. A blank value means no label. A caret then reads "Kyle's Kilo · release agent".</p>
      <p>Both labels are self-declared. Pages always shows them under the account the key authenticates. They don't change who made an edit or what the key can access.</p>
      <p>The Kilo recipe above uses one shared entry with <code>"X-Pages-Agent": "{env:PAGES_AGENT}"</code>. Kilo fills in the variable when it loads config. Set it per worktree, for example in the worktree's <code>.envrc</code>:</p>
      <pre class="setup-value"><code id="pages-agent-envrc">${escapeHtml(pagesAgentEnvrc)}</code></pre>
      <button type="button" class="setup-copy" data-copy="pages-agent-envrc" data-copy-message="Label line copied. Add it to the worktree's .envrc, then start Kilo from that shell." hidden>Copy .envrc line</button>
      <p>Start Kilo from a shell that has the variable. When it's unset, Kilo sends an empty header, and Pages shows no label.</p>
      <p class="setup-note">Labels are optional. Each MCP session already gets its own caret through <code>Mcp-Session-Id</code>, so two unlabeled sessions on one key still show separately.</p>
    </details>
  </section>
  <section aria-labelledby="setup-try"><h2 id="setup-try"><span>4</span> Check the connection</h2>
    <p>Ask your agent: <q>List my Pages.</q> A successful response, even an empty list, means you're connected. A config file or a client status label alone doesn't verify access.</p>
    <p class="setup-note">If it fails, check that the key is saved, unexpired, and belongs to this deployment's Anaconda environment. Missing access to one Page can also mean it hasn't been shared with that account.</p>
    <p class="setup-note">For CLI setup, tool details, and troubleshooting, read the <a href="/llms.txt">agent guide</a>.</p>
  </section>
  <section aria-labelledby="setup-oauth"><h2 id="setup-oauth">ChatGPT and cloud clients: use OAuth</h2>
    <p>Add a custom MCP server in your client's connection settings, choose <strong>OAuth</strong>, and enter this server URL:</p>
    <pre class="setup-value"><code id="oauth-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <button type="button" class="setup-copy" data-copy="oauth-endpoint" data-copy-message="Server URL copied. Add it to your client's MCP connections and choose OAuth." hidden>Copy server URL</button>
    <p>Follow the client's sign-in link, check your Pages account and permissions, then approve access. You don't need to create or transfer an API key.</p>
    <p>Access tokens last 10 minutes. Each refresh token works once and is replaced on use. The client refreshes on its next request, so nothing has to run in the background. The connection ends 30 days after you approve it, however often it refreshes. After that, authorize again.</p>
    <p><strong>Don't share one OAuth connection between processes.</strong> If two processes hold the same stored tokens and both refresh, Pages treats the second refresh as a replayed token and revokes the whole connection. For several agents, worktrees, or CLI runs at once, use an API key.</p>
    <p class="setup-note">This deployment supports the ChatGPT OAuth client. Client metadata and permissions are discovered automatically. If your client asks for manual details or reports a different callback, follow the <a href="/llms.txt">agent guide</a>. Other OAuth clients need deployment support.</p>
    <details class="setup-details" id="kilo-oauth"><summary>Kilo with OAuth (one Kilo process at a time)</summary>
      <p>If several Kilo processes share one set of OAuth credentials, such as Kilo Desktop and the CLI, or several worktrees running at once, concurrent refreshes can revoke the connection. Use the API-key recipe above for that. OAuth fits a single Kilo process when you don't want to manage a key.</p>
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
