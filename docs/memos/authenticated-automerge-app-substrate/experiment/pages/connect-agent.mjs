import { pagesPublicOrigin } from "./agent-guide.mjs";

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
      <p>Choose an expiration, then save the key in your client's secret settings. It is shown only once.</p>
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
  <section aria-labelledby="setup-key"><h2 id="setup-key"><span>1</span> Create an API key</h2>${keyInstructions}</section>
  <section aria-labelledby="setup-client"><h2 id="setup-client"><span>2</span> Add Pages to your client</h2>
    <p>Add a remote MCP server using <strong>Streamable HTTP</strong>.</p>
    <div class="setup-field-label"><h3>Server URL</h3><button type="button" class="setup-copy" data-copy="mcp-endpoint" aria-label="Copy server URL" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-endpoint">${escapeHtml(setup.endpoint)}</code></pre>
    <div class="setup-field-label"><h3>Headers</h3><button type="button" class="setup-copy" data-copy="mcp-headers" aria-label="Copy headers" hidden>Copy</button></div>
    <pre class="setup-value"><code id="mcp-headers">${escapeHtml(setup.headers)}</code></pre>
    <p class="setup-note">Replace the placeholders in your client with your key and its name, such as Codex or Kilo. Keep the key in the client's secret settings, outside chats and documents. Signing in to Pages does not sign in your MCP client.</p>
    <p class="setup-copy-status" role="status" aria-live="polite"></p>
  </section>
  <section aria-labelledby="setup-try"><h2 id="setup-try"><span>3</span> Try it together</h2>
    <p>Ask your agent: <q>List my Pages.</q> Open a Page in your browser, then ask the agent to make an edit. You'll see its changes in the same document.</p>
    <p class="setup-note">For CLI setup, tool details, and troubleshooting, read the <a href="/llms.txt">agent guide</a>.</p>
  </section>
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
