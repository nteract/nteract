/** Public onboarding contains no account or document data. URLs come only from
 * deployment configuration, never a request Host or forwarded header. */
export function agentGuide(env) {
  const url = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Configure the public Pages origin before serving agent instructions");
  const origin = url.origin;
  return `# Pages

Realtime documents for people and agents. Markdown tools, comments, and browser
edits use the same document. Pages start private. The owner can invite signed-in
people as viewers or editors; document links alone do not grant access. Editors
can write and comment, viewers can read, and only the owner can manage access or
delete a Page. API-key scope further limits the account's Page permissions.

## Authentication

Browser: ${origin}/ — choose Sign In, or open ${origin}/api/auth/login.
Agents: use an Anaconda API key for the same provider environment as browser
Sign In. Production and staging keys are not interchangeable. Browser sign-in
cookies and API keys are separate credentials; an OIDC access token is not an
API key.

### Get an API key

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

If you already use the anaconda-auth CLI, retrieve its key through the supported
command. Install the CLI and sign in first if needed:

\`\`\`sh
conda install anaconda-auth
anaconda auth login --at anaconda.com
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
list_pages includes owned Pages and accepted shared Pages. No anonymous link access
or Space inheritance is implemented in this pass.

GET ${origin}/api/access?page=<page_id> returns your effective access; owners also
receive members and pending invitations. Owners may POST to the same endpoint with
an action, expected_revision from access.revision, and a new idempotency_key.
Actions are invite (email, role: viewer or editor), set_role (principal, role: viewer,
editor or null to remove), and revoke_invite (invite_id). A 409 requires reading
access again. An uncertain request can be retried with its identical key and body.

## JSON tools

POST ${origin}/api/tools with {"operation":"<name>","arguments":{...}}.
Start by listing and reading:

\`\`\`json
{"operation":"list_pages","arguments":{}}
\`\`\`

\`\`\`json
{"operation":"read_page","arguments":{"page_id":"<page_id from list_pages>"}}
\`\`\`

read_page returns title, ordered blocks, comments, and heads. Keep the returned
page_id and block IDs. Browser link: ${origin}/p/<page_id>.

- create_page: title, optional markdown, and idempotency_key.
- read_page: page_id.
- patch_page: replace_match for literal visible-text edits; patch_block_markdown for Markdown syntax edits.
- edit_page: set_title, replace_block_markdown, insert_markdown, move_block,
  or delete_block operations.
- manage_page_comment: add, reply, resolve, reopen, edit, or delete_message.
- delete_page: delete the Page and comments. There is no restore operation.

Read before editing. All mutations of an existing Page require page_id,
base_heads from the latest read_page, and idempotency_key. Use a new UUID for
each new request (keys accept 8–128 letters, digits, underscores, or hyphens).

A targeted edit:

\`\`\`json
{
  "operation": "patch_page",
  "arguments": {
    "page_id": "<page_id>",
    "base_heads": ["<head from read_page>"],
    "idempotency_key": "<new UUID>",
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
outcome, retry the exact request body, key, account, and driver label.

For insert_markdown and move_block, after_block_id is the preceding block's ID;
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
links and resources/read reads those URLs. This endpoint does not provide an
interactive MCP OAuth setup; configure the API-key Authorization header.

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
