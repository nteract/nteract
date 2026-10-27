import { pagesPublicOrigin } from "./agent-guide.mjs";
import {
  codexConfig,
  codexHeaderHelper,
  keyFile,
  kiloConfig,
  saveKeyCommand,
  setupPrompt,
} from "./agent-client-setup.mjs";

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
    headers: "Authorization: Bearer <YOUR_ANACONDA_API_KEY>\nX-Pages-Driver: <YOUR_CLIENT_NAME>",
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
<title>Connect an agent · Pages</title><link rel="stylesheet" href="/app.css"><link rel="describedby" type="text/plain" href="/llms.txt"></head>
<body><header class="app-header"><a class="brand" href="/">Pages</a><a class="setup-guide-link" href="/llms.txt">Agent guide</a></header>
<main class="agent-setup">
  <h1>Connect an agent</h1>
  <p class="setup-intro">Let your agent read, edit, and comment on your Pages.</p>
  <p>Choose your client's connection method below. Your agent can prepare the settings while you authorize access.</p>
  <details class="setup-details"><summary>Give your agent the setup steps</summary>
    <pre class="setup-value"><code id="setup-prompt">${escapeHtml(setupPrompt(setup.origin))}</code></pre>
    <button type="button" class="setup-copy" data-copy="setup-prompt" data-copy-message="Setup instructions copied. Paste them into your agent chat." hidden>Copy setup instructions</button>
  </details>
  <section aria-labelledby="setup-oauth"><h2 id="setup-oauth">ChatGPT and cloud clients</h2>
    <p>Add a custom MCP server in your client's connection settings, choose <strong>OAuth</strong>, and enter this server URL:</p>
    <pre class="setup-value"><code id="oauth-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <button type="button" class="setup-copy" data-copy="oauth-endpoint" data-copy-message="Server URL copied. Add it to your client's MCP connections and choose OAuth." hidden>Copy server URL</button>
    <p>Follow the client's sign-in link, check your Pages account and permissions, then approve access. You don't need to create or transfer an API key.</p>
    <p class="setup-note">This deployment supports the ChatGPT OAuth client. Client metadata and permissions are discovered automatically. If your client asks for manual details or reports a different callback, follow the <a href="/llms.txt">agent guide</a>. Other OAuth clients need deployment support.</p>
  </section>
  <h2>Clients using an API key</h2>
  <p>For the Kilo and Codex recipes below, create and save a key first. Your agent can prepare a config draft while you do this; tell it when the key is ready. Keep the key out of chat.</p>
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
      <pre class="setup-value"><code id="kilo-config">${escapeHtml(kiloConfig(setup.origin))}</code></pre>
      <button type="button" class="setup-copy" data-copy="kilo-config" data-copy-message="Kilo config copied. Merge it into global config after saving your key." hidden>Copy Kilo config</button>
      <p><code>oauth: false</code> keeps this recipe on API-key authentication. Don't use <code>kilo mcp auth</code> with this recipe. Reload the server or restart Kilo, then ask it to list your Pages.</p>
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
      <p class="setup-note">This works without desktop shell environment variables. Remote execution placement needs its own credential setup. <a href="https://developers.openai.com/codex/mcp">Codex configuration reference</a></p>
    </details>
    <details class="setup-details" id="other-client"><summary>Other MCP clients</summary>
    <p>Add a remote MCP server using <strong>Streamable HTTP</strong>.</p>
    <div class="setup-field-label"><h3>Server URL</h3><button type="button" class="setup-copy" data-copy="mcp-endpoint" aria-label="Copy server URL" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <div class="setup-field-label"><h3>Headers</h3><button type="button" class="setup-copy" data-copy="mcp-headers" aria-label="Copy headers" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-headers">${escapeHtml(setup.headers)}</code></pre>
    <p class="setup-note">Replace the placeholders in your client with your key and its name, such as Codex or Kilo. Keep the key in the client's secret settings, outside chats and documents. Signing in to Pages does not sign in your MCP client.</p>
    </details>
  </section>
  <section aria-labelledby="setup-try"><h2 id="setup-try"><span>4</span> Check the connection</h2>
    <p>Ask your agent: <q>List my Pages.</q> A successful response, even an empty list, means you're connected. A config file or a client status label alone doesn't verify access.</p>
    <p class="setup-note">If authentication fails, check that the key is saved, unexpired, and belongs to this deployment's Anaconda environment. Missing access to one Page can also mean it hasn't been shared with that account.</p>
    <p class="setup-note">For CLI setup, tool details, and troubleshooting, read the <a href="/llms.txt">agent guide</a>.</p>
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
