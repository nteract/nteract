import {
  codexConfig,
  codexHeaderHelper,
  keyFile,
  kiloConfig,
  kiloApiKeyConfig,
  saveKeyCommand,
} from "./agent-client-setup.mjs";

/** Public onboarding contains no account or document data. URLs come only from
 * deployment configuration, never a request Host or forwarded header. */
export function pagesPublicOrigin(env) {
  const url = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Configure the public Pages origin before serving agent instructions");
  return url.origin;
}

export function agentGuide(env) {
  const origin = pagesPublicOrigin(env);
  return `# Pages

## Start here: connect your agent

MCP endpoint: ${origin}/mcp. Human setup: ${origin}/connect.
Choose the client section below before investigating authentication:

- ChatGPT / cloud clients using the ChatGPT OAuth client: add the endpoint and
  complete browser authorization. No API key is needed for this flow.
- Kilo Desktop / CLI: use the OAuth recipe below and ask the human to complete
  browser sign-in. No API key is needed.
- Codex Desktop / CLI: use the local API-key recipe below.
- Other clients: use an Anaconda API key if they support bearer headers. This
  prototype accepts the ChatGPT and configured Kilo OAuth clients; arbitrary registration
  is not enabled. Ask for client support instead of trying unrelated login flows.

Ask the human for their step early, and prepare non-secret configuration in
parallel. Only a successful list_pages call proves the connection works.

### ChatGPT / cloud connection (OAuth)

Add a custom MCP server in the client's connection or plugin settings:

- Server URL: ${origin}/mcp
- Authentication: OAuth with discovery / client metadata (CIMD)
- Permissions: pages:read; add pages:write for editing. Each Page's current
  sharing permissions still apply. The consent screen also explains that the
  connection can remain active for up to 30 days.

The human follows the client's authorization link, signs in to Pages with
Anaconda, checks the account and requested permissions, and approves. Pages
issues credentials for this deployment's MCP endpoint; the client never receives
an Anaconda API key or provider refresh token. Do not copy browser cookies.

Discovery: ${origin}/.well-known/oauth-protected-resource/mcp and
${origin}/.well-known/oauth-authorization-server. The supported ChatGPT client ID
is https://chatgpt.com/oauth/client.json, with callback
https://chatgpt.com/connector_platform_oauth_redirect. The predefined public
client pages-chatgpt uses that same callback when a client ID is requested.
PKCE S256 is required; no client secret is used. Do not invent a callback URL.
If the client shows a different callback or registration error, report it for
deployment configuration rather than asking the human for an API key it can't use.

Newly approved connections receive rotating refresh tokens, including clients
that do not request offline_access. The original 30-day deadline never extends
on refresh; reconnect when requested. Connections approved before this change
without offline_access need one new authorization to enable renewal.
OAuth credentials work on /mcp only, not the JSON API, sharing API, or native sync.
After authorization, call list_pages from the actual connected chat. Dot's
availability depends on its connection UI; a configured plugin alone isn't proof.

### Kilo Desktop / CLI (OAuth, recommended)

Ask the human early to complete browser authorization. Meanwhile, merge this
non-secret configuration into GLOBAL ~/.config/kilo/kilo.jsonc (respect
XDG_CONFIG_HOME if customized). Preserve all other servers and settings. This
is the Desktop/CLI format, not the older VS Code extension's mcpServers format.

\`\`\`json
${kiloConfig(origin)}
\`\`\`

If migrating the existing Pages entry, remove its Authorization header and
replace oauth: false with the oauth object above. Keep X-Pages-Driver and any
unrelated headers/settings. Do not delete the old key file: removing the header
is enough to stop this connection using it, and other clients may still need it.

Run kilo mcp auth pages. The human follows the browser link, signs in, checks the
account and permissions, and approves. If no browser opens, give the human the
link Kilo prints; do not retrieve browser cookies or search for credentials.
Reload the Pages server or restart Kilo Desktop, then call list_pages from the
actual chat. kilo mcp list is a diagnostic, not proof of authenticated tool use.
If authorization reports a callback mismatch, report the URL without tokens;
do not substitute a guessed client ID or silently fall back to an old key.

This deployment's public client is pages-kilo, with exact callback
http://127.0.0.1:19876/mcp/oauth/callback, PKCE S256, and no client secret.
The explicit clientId is required; dynamic registration is not enabled. Request
pages:read pages:write offline_access for editing and reconnect after expiry.
Configuration and the OAuth exchange were checked with Kilo CLI 7.4.21 and
Desktop's bundled CLI 7.8.17. Do not inspect binaries to set up this recipe.
Official configuration: https://kilo.ai/docs/automate/mcp/using-in-cli

### API-key connection: first ask the human

For clients using the API-key recipes, follow this order:

1. Check whether a key is already explicitly configured for Pages (a supplied
   secret path/header or ANACONDA_API_KEY / ANACONDA_AUTH_API_KEY). Check presence
   without displaying its value. The recipes below use ${keyFile}.
2. If no key is available, ask the human immediately:
   "Pages needs a separate Anaconda API key. Please open ${origin}/connect,
   create a key, and save it privately using that page's instructions. Tell me
   when it is ready; do not paste it into this chat. I'll prepare the connection
   settings while you do that."
   In parallel, prepare the private directory, a config draft outside the active
   client config, and the non-secret Codex helper if needed. Check the client
   version and preserve its existing settings. Wait for the key before merging
   an active secret reference, enabling MCP, or attempting authentication.
   A browser session alone does not configure an API-key client. Do not create an empty key file,
   enable a connection without a key, install an Anaconda CLI just for setup,
   inspect client binaries, or search app/keyring storage to find credentials.
3. After the human saves the key, merge the client recipe below into their
   existing configuration. Preserve unrelated settings and existing servers.
   If they supplied another secret path, use that path consistently instead.
4. Reload the client's MCP connection, then call list_pages. Only a successful
   authenticated tool call proves it works; a saved config is not a connection.
   An empty Pages list is a successful result. Until then report the exact stage:
   prepared and waiting for a key, configured but not verified, or connected.

Do not paste keys into chat, print resolved config/headers, or put credentials in
URLs. For 401, check key presence, expiry, and provider environment once, then ask
the human to replace the key through /connect. For Kilo, use the separate OAuth migration recipe above if switching methods. For
403, check User Resources scopes and Page sharing permissions. Do not retry in a loop.

### Save the key privately (human step, macOS/Linux)

Create the key through /connect, then run this in your own terminal. Python 3
prompts with input hidden and writes a user-only file. Paste only the raw key,
not an environment-variable assignment. Nothing is sent to the agent or this page.
This replaces the key in ${keyFile}; clients using that file will use the new key.
If Python 3 is unavailable, ask the agent to prepare an equivalent private local
file and enter the key yourself; no CLI installation is required.

\`\`\`sh
${saveKeyCommand}
\`\`\`

### Kilo Desktop / CLI (API-key fallback)

Once the key file is nonempty, merge this into the GLOBAL
~/.config/kilo/kilo.jsonc (respect XDG_CONFIG_HOME if customized). This is the
Kilo Desktop/CLI format, not the legacy VS Code mcpServers format. Secret file
references belong in global config; project configs may drop variable headers.
The file contains the raw key only. oauth: false keeps this recipe on API-key
authentication; kilo mcp auth is not the setup path for this recipe.

\`\`\`json
${kiloApiKeyConfig(origin)}
\`\`\`

Reload the Pages server in Kilo or restart the desktop app. kilo mcp list is a
connection diagnostic; also call list_pages from the actual session using it.
If a key is already supplied through an environment variable, you may replace
the Authorization value with "Bearer {env:ANACONDA_API_KEY}" (or the explicitly
configured ANACONDA_AUTH_API_KEY). Do this only when the running Kilo process
actually inherits that variable. A shell-only variable does not establish that
Desktop has it; otherwise ask the human to save the key through /connect. Do not
silently use a nonexistent file just because an environment variable was found.
Official configuration: https://kilo.ai/docs/automate/mcp/using-in-cli

### Codex Desktop / CLI (local HTTP connection)

Use the same private file. Have the agent save this non-secret helper as
~/.config/pages/mcp-headers.py. Codex runs it to obtain the header; do not run it
in an agent terminal or print its output, which contains the key.

\`\`\`python
${codexHeaderHelper}
\`\`\`

Merge this into ~/.codex/config.toml (or the configured CODEX_HOME). Replace
both path placeholders with real absolute paths; use command -v python3 to
locate the interpreter. Keep the quotes around paths with spaces.

\`\`\`toml
${codexConfig(origin)}
\`\`\`

http_headers_helper is supported in current Codex (checked with CLI 0.156.1).
This recipe avoids shell environment inheritance in a desktop app. Do not also
set bearer_token_env_var or a literal Authorization header: those take precedence.
For an older Codex, use the supported bearer_token_env_var = "ANACONDA_API_KEY"
option only when that variable is actually available to the running client, or
ask the human to update. Never put the key value in config. Restart/reload MCP,
then call list_pages. codex mcp get/list checks config only, not authentication.
Official configuration: https://developers.openai.com/codex/mcp

## Documents and permissions

Realtime documents for people and agents. Markdown tools, comments, and browser
edits use the same document. Pages start private. The owner can invite signed-in
people as viewers or editors. If enabled by the deployment, the owner can also
allow signed-in people with a verified company email domain to view by link.
Pages stay Restricted until the owner chooses that audience. Personal email
providers are never offered, and ownership need not move to a company account. Editors
can write and comment, viewers can read, and only the owner can manage access or
delete a Page. Credential scope further limits the account's Page permissions.

## Authentication

Browser: ${origin}/ — choose Sign In, or open ${origin}/api/auth/login.
Agents can authorize supported OAuth clients as described above, or use an
Anaconda API key for the same provider environment as browser
Sign In. Production and staging keys are not interchangeable. Browser sign-in
cookies and API keys are separate credentials; an OIDC access token is not an
API key.

### Get an API key

Human setup page: ${origin}/connect

For production Anaconda, open https://anaconda.com/app/profile/api-keys and sign
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
these examples. The service receives the header, not the environment variable.

Agents: use a credential explicitly configured for this service or ask the account
owner to complete the setup above. Do not search browser profiles, app databases,
or keyring files for credentials. Keep keys out of chat, documents, URLs, and logs.

### Configure the client

Send these headers on API and MCP requests:

\`\`\`http
Authorization: Bearer <ANACONDA_API_KEY>
X-Pages-Driver: ChatGPT
Content-Type: application/json
\`\`\`

Use your application's name for X-Pages-Driver (for example Codex or Kilo).
The verified key supplies the account and author name; the driver is a client
label, not proof of a vendor or a permission grant. Keys need cloud:read for
reading or cloud:write for reading and editing. API clients can omit Origin;
a foreign Origin is rejected. Browser cookie writes require this site's Origin.

## Sharing

Open a shared Page link once while signed in to accept its pending email invitation.
The email must be verified by the configured identity provider. Accepted access is
bound to the account ID and works through browser, native sync, and MCP. Invitations
expire after seven days. The service does not send email; the owner shares the link.
list_pages includes owned Pages, accepted shared Pages, and company-shared Pages
the account has opened by link while access is still allowed. No anonymous link access
or Space inheritance is implemented in this pass.

GET ${origin}/api/access?page=<page_id> returns your effective access; owners also
receive members, pending invitations, and the host's domainOptions/domainView.
Owners may POST to the same endpoint with
an action, expected_revision from access.revision, and a new idempotency_key.
Actions are invite (email, role: viewer or editor), set_role (principal, role: viewer,
editor or null to remove), revoke_invite (invite_id), and set_domain_view (domain
from domainOptions, or null for Restricted). Company access is always view-only;
individual editor grants still work, and explicit removals override the domain.
Browser/OAuth company proof expires after six hours without fresh sign-in;
refreshing an OAuth token does not renew that identity proof. A 409 requires reading
access again. An uncertain request can be retried with its identical key and body.

## Images

In the browser, use Insert image, paste a screenshot, or drop an image into an
editable block. PNG, JPEG, and static WebP are supported up to 5 MiB; dimensions
are limited to 8192 pixels per side and 25 million pixels. An upload completes
before its reference is inserted into the shared document.

Images are private Page assets, separate from Automerge history. The document
contains a stable relative URL and alt text, never image bytes or an expiring
signed URL. Each image read checks the Page's current permissions. Do not
replace these URLs with public hosting or put base64 image data in Markdown.

An API-key client can POST raw image bytes to
${origin}/api/pages/<page_id>/assets with its configured bearer header and image
Content-Type. The response contains asset_id, asset_url (also url for existing
clients), mime_type, size, width, and height. Repeating the same upload to that
Page returns the same asset reference. GET or HEAD of the returned path also
requires this Page's current read permission.

ChatGPT can transfer an attached image through import_page_image. Pass page_id
and the file descriptor supplied by ChatGPT: file has download_url and file_id,
with optional mime_type and file_name. The tool advertises openai/fileParams so
ChatGPT can supply the file; do not invent a download URL from its file ID.
The current importer accepts only HTTPS files.oaiusercontent.com downloads and
does not follow redirects or accept arbitrary remote URLs. Do not pass base64
image data, a local/sandbox path, or a temporary ChatGPT link as the document's
image reference.

import_page_image requires pages:read and pages:write plus current Page edit
access. It copies the bytes into private Page storage and returns asset_id,
asset_url, mime_type, size, width, and height. It does not insert content.
Repeating an import of identical bytes to the same Page reuses the asset.
No additional API key or public hosting is needed. If ChatGPT does not expose this tool yet, refresh the connection's
tool list. Newly generated images must be available as transferable files in
that client; this handoff still needs a separate live ChatGPT trial. An uploaded
attachment and a generated image are not interchangeable proof of support.
If the client cannot supply a file descriptor, ask the human to upload through
Pages' image control instead of inserting a broken placeholder link.

After either import or byte upload, call read_page and insert the returned
asset_id through edit_page. The dedicated insert_image operation creates one
rich-text block containing the image. Supply descriptive alt text; after_block_id
is optional (omitted appends; null prepends). The asset must already exist in
this Page's private storage; an asset from another Page must be copied first.

\`\`\`json
{
  "operation": "edit_page",
  "arguments": {
    "page_id": "<page_id>",
    "base_heads": ["<head from read_page>"],
    "retry_token": "<retry_token from read_page>",
    "idempotency_key": "<retry_key_prefix><new UUID>",
    "operations": [{
      "op": "insert_image",
      "asset_id": "<asset_id from import or upload>",
      "alt": "Describe what the image shows",
      "after_block_id": "<preceding block ID from read_page>"
    }]
  }
}
\`\`\`

The receipt returns result.inserted_images with the actual block_id, asset_id,
asset_url, and alt, plus updated heads and the Page url. The MCP structured
result matches its text receipt. Save the exact edit request and retry it after
an uncertain result: it returns the original receipt without another block or
file download, even if the temporary source link has expired. A fresh insertion
requires a new read and operation key. Verify the block through read_page and
the authenticated Page; an upload receipt alone does not mean it was inserted.

OAuth credentials remain restricted to /mcp; they do not authorize the raw-image
HTTP endpoint above. MCP can import files and preserve image references, but it
does not return image pixels. A reference from read_page is not evidence that an
agent has seen the image. Copying a document to another deployment also requires
transferring its private assets; copying Markdown alone is insufficient.

## JSON tools

POST ${origin}/api/tools with {"operation":"<name>","arguments":{...}}.
Start by listing and reading:

\`\`\`json
{"operation":"list_pages","arguments":{}}
\`\`\`

\`\`\`json
{"operation":"read_page","arguments":{"page_id":"<page_id from list_pages>"}}
\`\`\`

read_page returns title, ordered blocks, comments, heads, retry_token, retry_key_prefix, and
retry_until. Keep the returned page_id and block IDs. list_pages also returns a
retry_token for catalog operations (create_page and delete_page). Browser link: ${origin}/p/<page_id>.

- create_page: title, optional markdown, and idempotency_key.
- read_page: page_id.
- patch_page: replace_match for literal visible-text edits; patch_block_markdown for Markdown syntax edits.
- edit_page: set_title, replace_block_markdown, insert_markdown, insert_image,
  move_block, or delete_block operations.
- manage_page_comment: add, reply, resolve, reopen, edit, or delete_message.
- import_page_image: page_id and a ChatGPT-supplied file descriptor; returns a
  private asset_id and asset_url for a subsequent insert_image edit. See Images above.
- delete_page: delete the Page and comments. There is no restore operation.

Read before editing. Document edits and deletion require page_id,
base_heads from the latest read_page, and idempotency_key. Include retry_token
from read_page for edits/comments; use the list_pages token for create/delete.
Append a new UUID to retry_key_prefix from the same result for
each new request (keys accept 8–128 letters, digits, underscores, or hyphens).

A targeted edit:

\`\`\`json
{
  "operation": "patch_page",
  "arguments": {
    "page_id": "<page_id>",
    "base_heads": ["<head from read_page>"],
    "idempotency_key": "<retry_key_prefix><new UUID>",
    "retry_token": "<retry_token from read_page>",
    "operations": [{
      "op": "replace_match",
      "block_id": "<block ID from read_page>",
      "match_text": "exact existing text",
      "replacement": "replacement text"
    }]
  }
}
\`\`\`

replace_match searches visible text without Markdown delimiters. It may cross
formatting marks within a paragraph or code block, but cannot cross paragraph,
code block, or embedded-node boundaries. replacement is literal text, not Markdown.
Use optional context_before/context_after to distinguish repeated text; context
must be in the same segment, between this occurrence and its neighboring matches.
Exactly one match is required; zero or multiple matches reject the entire batch.
Successful receipts include result.edits with matched: 1 for each replace_match.
Replacement text keeps formatting shared by the entire matched range, including
link destinations and titles. Formatting present on only part of the match does
not spread across the replacement. Untouched characters, marks, and comment
anchors retain their CRDT identities.

For formatting or structural edits, use patch_block_markdown with replacements
[{"old":"exact Markdown","new":"replacement Markdown"}]. Each old string must
occur exactly once in that block's Markdown. Regex replacement is not supported.
Copy the whole heads array, even when it has more than one entry. On a stale-revision error,
read again, reconsider the edit, and use a new key. After a timeout or unknown
outcome, retry the exact request body, key, token, account, and driver label.

Retry tokens keep completed-operation receipts bounded without making old retries
execute again. The server returns retry_until when issuing a token. An expired
request returns HTTP 410 with code retry_expired and does not execute. Read the
current Page/catalog to reconcile its outcome; never automatically replace an
expired token or key and resend an uncertain operation. Pending admitted edits
remain recoverable with their original request. Keys bind to their exact token: replacing or stripping that token cannot reuse an expired key. Legacy
requests without a token retain their receipts, with a separate lifetime cap of 1,000 operations. Use the
token protocol for ongoing work.

For insert_markdown, insert_image, and move_block, after_block_id is the preceding block's ID;
null places the block first, and omission appends it. For a comment, use action
add with block_id and body. Add selected_text to anchor it to a passage in that
block; occurrence is one-based and defaults to 1. Replies use thread_id and body;
editing or deleting a message also uses message_id. Comment author labels are
editable document content, not an audit log.

## Hosted MCP

Endpoint: ${origin}/mcp (Streamable HTTP, POST).
Use the same authentication headers plus:

\`\`\`http
Accept: application/json, text/event-stream
\`\`\`

Initialize with an MCP client, then call tools/list for the current input schemas.
For example, tools/call uses this JSON-RPC shape:

\`\`\`json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}
\`\`\`

The same operations and guards apply. Results contain JSON in content[].text;
check result.isError even when HTTP succeeds. resources/list returns document
links and resources/read reads those URLs. Supported OAuth clients use a Pages
access token; other clients use an Anaconda API key. Both authenticate with
Authorization: Bearer, using the connection instructions above.

Tool edits sync into the browser editor and carry the account/driver label.
Each tool batch is atomic: it does not stream keystrokes or publish an agent cursor.
Browser peers publish cursor presence separately. Use these tools for document work; /api/sync is a binary native client protocol,
not a JSON editing endpoint.
`;
}

export function agentGuideResponse(request, env) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const body = agentGuide(env);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      Link: '</llms.txt>; rel="self"; type="text/plain"',
    },
  });
}
