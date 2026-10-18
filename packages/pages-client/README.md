# Pages client

Private TypeScript workspace package for the standalone [Pages service](../../apps/pages/README.md).
It exposes semantic HTTP operations and a Node WebSocket subscription; it does
not embed a native runtime or maintain another Automerge replica.

```ts
import { PagesClient } from "@nteract/pages-client";
import { loadConnection, watchPage } from "@nteract/pages-client/node";

const config = await loadConnection(process.env.PAGES_CONNECTION_FILE!);
const client = new PagesClient(config.origin, { token: config.token });
const { content } = await client.readPage(config.page_id);
const block = content.blocks[0];
const result = await client.patchPage({
  page_id: config.page_id,
  base_sequence: content.through_sequence,
  idempotency_key: crypto.randomUUID(),
  operations: [{
    op: "patch_block_markdown",
    block_id: block.id,
    expected_hash: block.hash,
    replacements: [{ old: "an observed phrase", new: "a revised phrase" }],
  }],
});
// Inspect operation_results: a patch batch can commit only its successful edits.
console.log(result.operation_results);

const subscription = watchPage(config, event => {
  // A retained-history gap requires readPage again; otherwise inspect changes.
  console.log(event.through_sequence, event.resync_required);
}, { sinceSequence: result.through_sequence, onError: console.error });
// Later: subscription.close();
```

Obtain a connection with the [MCP package's CLI](../pages-mcp/README.md), or use
`prepareConnection` and `saveConnection` from the Node entry point. Approval URLs
contain only a credential hash. Never log the returned `config.token`, place it
in a URL, or commit its file. Files are created exclusively with mode `0600`;
POSIX reads reject files accessible to other users. Windows deployments must
ensure equivalent filesystem ACLs.

A credential authorizes one Page and a subset of read/edit/comment operations.
The server derives principal and approved driver identity. Callers cannot set
attribution using tool arguments. Expiry/revocation closes event subscriptions;
start a new approval flow to reconnect. Signing out of the browser leaves the
granted connection active until its expiry or revocation.

Mutations are never retried automatically. On an uncertain transport outcome,
read back or retry the exact payload and idempotency key. A stale guard requires
a fresh read and a deliberate new operation. Retained receipts are bounded; see
service capabilities. HTTP redirects are rejected to avoid forwarding credentials.

`watchPage` sends a bearer header, resumes with the observed sequence, and
reconnects with backoff. The initial message is catch-up, not necessarily a new
edit. Changes are committed semantic events; agent cursor presence is not
simulated. The core HTTP entry point can also be used with browser session auth.
