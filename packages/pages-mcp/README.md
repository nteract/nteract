# Pages MCP

Private stdio MCP adapter over the [Pages TypeScript client](../pages-client/README.md).
It exposes the same guarded operations as the browser's service, with explicit
Page IDs, idempotency keys, Markdown projections, and comment operations.

From the repository root:

```sh
pnpm --dir packages/pages-client build
pnpm --dir packages/pages-mcp build
node packages/pages-mcp/dist/connect.js https://m.runtimed.run page_<id> ChatGPT /absolute/private/connection.json
```

Open the printed URL and approve the requested Page, permissions and duration
while signed in. The CLI polls only the pending authorization for up to ten
minutes; document collaboration uses WebSocket events. It saves the credential
in a new owner-only file after approval, never in the URL or standard output.
The driver name is a client-supplied label approved by the user, not verified
vendor identity. Revoke it from the service's **Connections** screen.

Configure a harness's stdio server with absolute paths. For example, harnesses
using the common `mcpServers` JSON configuration shape can use:

```json
{
  "mcpServers": {
    "pages": {
      "command": "node",
      "args": ["/absolute/repo/packages/pages-mcp/dist/cli.js"],
      "env": { "PAGES_CONNECTION_FILE": "/absolute/private/connection.json" }
    }
  }
}
```

The adapter lists only permitted tools: `read_page`, `read_page_changes`,
`patch_page`, `edit_page`, `list_page_comments`, `manage_page_comment`, and
`reply_page_comment`. A Page resource supports read and subscribe. Resource
updates arrive from the service's semantic WebSocket, without content polling.
Every tool request still names the approved Page; connection state does not
silently choose a target for the model.

Read before editing, preserve the observed sequence and hash guards, and prefer
literal `patch_page` replacements for prose. Structural batches are atomic;
patch batches can report partial success. Inspect their `operation_results`.
Reuse the exact request and idempotency key after an unknown outcome; do not
blindly retry against a newer revision. The service applies changes to the live
Automerge document and binds operation attribution to the credential.

This is a local stdio server, not a hosted MCP endpoint or an OAuth authorization
server. It cannot create/discover Pages, obtain broader account access, execute
cells, or send raw CRDT changes. Hosted authorization and space permissions are
separate work.

For local end-to-end verification, build/start `apps/pages`, then run:

```sh
pnpm --dir packages/pages-mcp test:integration
```

The test uses generated fixtures with the loopback-only OIDC provider and an
actual stdio MCP child process. It covers approval, scoped reads/edits/comments,
idempotent retry, WebSocket events, resource notifications, and revocation.
