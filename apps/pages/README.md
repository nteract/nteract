# Pages

A runnable, private Pages service on celld. A browser and an agent authenticated
to the same OIDC account work on the same documents. Markdown renders through
nteract's Rust Markdown engine and shared `ProjectedMarkdownView`.

This is an initial service, not a full Spaces replacement. The account owns one
workspace Durable Object, with an independent Automerge document per Page.
There are no kernels or executable cells. Code fences are document content.

See the [design memo](../../docs/memos/celld-pages.md) for the proposed editor,
operation transports, attribution, comments, and incremental persistence work.
Live block/selection comments now share the Page CRDT and WebSocket stream.
Space-level sharing is an intended feature, following nteract notebook-room
permissions, with Pages inheriting access from their space. Private account
workspaces are the current prototype behavior; sharing is not yet enabled.
The complete product target is a collaboratively editable realtime document
with live threaded comments, following the notebook experience. Explicit saves
and polling do not satisfy that target. The integrated WYSIWYG editor edits
the same shared documents; its separate workbench remains available for research.

## Run locally

Requires Node, pnpm, Rust with `wasm32-unknown-unknown`, and celld 0.6.1 or later
with `celld dev`. From the repository root:

```sh
pnpm install
pnpm --dir apps/pages build
pnpm --dir apps/pages dev
```

Open <http://localhost:9890> and sign in. Development runs the real PKCE,
nonce validation, server token exchange, and HttpOnly session flow against
`@nteract/local-oidc`. This local provider automatically grants `dev@localhost`;
it is not a production login challenge. Both request and configured public
origin must be loopback before its routes can run.

`pnpm --dir apps/pages test` checks document and sync invariants; `typecheck`
checks the browser and Worker. With the dev server running, `pnpm --dir
apps/pages smoke` exercises real OIDC sessions and binary WebSocket peers,
including concurrent edits, comments/replies/resolution across HTTP and sync,
reconnect, and session revocation.

`PAGES_PORT` changes the port. State survives process restarts in
`dist/.celld/dev`. The build preserves that directory. Do not delete `dist` to
rebuild if you want to retain local Pages. The dev session secret is generated
in ignored `dist/.dev.vars`, retained on restart, and never sent to the browser.

## Connect an agent

Build the TypeScript SDK and stdio MCP adapter from the repository root:

```sh
pnpm --dir packages/pages-client build
pnpm --dir packages/pages-mcp build
node packages/pages-mcp/dist/connect.js https://m.runtimed.run page_<id> ChatGPT /absolute/private/connection.json
```

Open the printed approval URL in your signed-in browser. Check the Page, client
name, permissions, and expiry before approving. The URL contains a token hash,
not the credential. The CLI waits for approval and creates a new owner-only
connection file; it never overwrites an existing file. Keep that file out of Git.
Then configure the harness to run `node /absolute/repo/packages/pages-mcp/dist/cli.js`
with `PAGES_CONNECTION_FILE=/absolute/private/connection.json` in its environment.
See [the MCP package](../../packages/pages-mcp/README.md) for a configuration example.

This first adapter runs locally over stdio. It is not a remotely hosted MCP OAuth
endpoint. No browser cookie or Anaconda token is copied into the harness.
Connections can be revoked at `/?connections=1`; sign-out does not revoke them.
The client-supplied driver name is a label approved by the account holder, not
proof of a particular model or vendor. The service binds it to the admitted
credential and records edits as, for example, “ChatGPT · on behalf of Kyle Kelley.”
Agents perform guarded semantic edits and comments, not synthetic keystrokes or
raw Automerge writes. All admitted edits update the same live document.

The [TypeScript client](../../packages/pages-client/README.md) provides the same
operations without MCP. Its WebSocket event subscription resumes by sequence;
MCP exposes it through Page resource subscriptions. Content is not polled.
With the local celld server running, `pnpm --dir packages/pages-mcp test:integration`
checks approval, scoped calls, actual stdio MCP, live notifications, and revocation
using generated local fixtures. It does not access production accounts.

## Storage and identity

The service reuses nteract's server OIDC and session implementation directly
from `apps/notebook-cloud/src`. It does not fork the auth protocol or copy
tokens into browser storage. Server-login deployments (the default) accept only
their own session cookie with same-origin checks or a scoped Pages agent
credential, and reject raw provider tokens.
This prevents a token issued through a shared OAuth client on another endpoint
from directly accessing Pages. Agent credentials are approved for one Page,
read/edit/comment permissions, and an expiry of at most eight hours.
Dedicated bearer-only installations must explicitly set
`PAGES_ALLOW_PROVIDER_BEARER=true`, omit `NOTEBOOK_CLOUD_OIDC_FLOW=server`,
and send an OIDC access token in
`Authorization: Bearer …`; do not use that mode with the shared preview client.
Workspace addressing binds the configured issuer and verified principal.
Client-supplied identity headers are discarded.

Inside a workspace, every Page stores:

- An Automerge document containing a title, block map, ordered block IDs, and
  comment threads keyed by stable IDs.
  Block Markdown is Automerge text; updates use `updateText`, not wholesale
  replacement of block objects. Instruction blocks are an explicit kind.
- A server sequence and the last 128 change receipts, separate from the CRDT.
- Idempotency receipts for creation and the last 128 edits.

Block IDs are stored identities. Markdown parser node IDs are disposable
rendering details within a block. Metadata remains with a block across text
edits and moves. Per-block hashes include kind, Markdown, and canonicalized
metadata; they are opaque guards, not a claim of hash compatibility with Spaces.

The workspace serializes calls across async hashing and storage. It persists
the page, sequence, receipts, and catalog together using Durable Object
storage's atomic multi-key `put`. It returns success only after persistence.
A storage exception returns `commit_status: unknown`, because an acknowledged
write and a failed reply are different things. Fleet bucket durability remains
the operator's celld configuration; local dev proves local restart recovery.

The browser owns an Automerge replica and edits rich blocks through ProseMirror,
with CodeMirror available for Markdown source blocks.
`/api/sync?page=<id>` exchanges binary Automerge sync messages over WebSocket;
there is no content polling or manual save. Tool edits and browser edits update
the same document. Text changes preserve CRDT identity, remote selections use
Automerge cursors, and remote transactions are excluded from local undo history.
Rich blocks retain their Automerge text and expose Markdown projections to tools.
Cross-block behavior and native mobile composition need further qualification.

The handshake requires a same-origin, endpoint-local session cookie. Every
incoming change must carry the admitted account's actor prefix; random suffixes
distinguish replicas, not independently verified people or agent sessions.
Schema, immutable Page identity, and storage budgets are checked on a clone
before commit. HTTP operations mint actors with the same account binding.
Older stored history remains readable without inventing historical attribution.
Sessions are checked before incoming mutations and outgoing broadcasts.

Sockets use Durable Object `acceptWebSocket` and awaited `webSocketMessage`
handlers so celld's output gate holds acknowledgments and broadcasts until the
configured durability boundary. The server sends durable heads separately from
protocol messages; the browser displays Saved only when those heads cover all
local changes. Hibernation/restart resets ephemeral sync state and reconnects
clients for a new handshake. A protocol acknowledgment alone is not Saved.
The browser keeps at most one binary frame awaiting its own durable receipt;
typing continues locally and accumulates in the next batch. Unsolicited peer
broadcasts do not release this transport window. Automerge's own in-flight
flag does not impose this bound when local heads keep advancing.

Pending binary replicas are journaled in IndexedDB, keyed by account and Page,
and merge after reconnect or reopening a tab. Cleanup compares journal revisions
so another tab's newer pending edits cannot be deleted. A recovery download is
available for rejected or unsaved work. Rejected edits can be explicitly discarded
to reopen the saved version; unreadable journal records remain downloadable.
The journal is best-effort browser storage:
quota failure is visible, and closing before its asynchronous write completes can
lose unacknowledged work. Full offline app loading is not supported. Old per-tab
source drafts remain available to copy from the previous editor. Pending document
content remains in IndexedDB after sign-out for recovery on
the same account; signing out does not remove local document copies. No OIDC
credentials enter browser storage. Raw HTML and MDX remain source text when they
need an isolated renderer.

Each stored Page value and the catalog have a 1.5 MiB budget, counting binary
bytes directly plus JSON metadata, receipts, and history, checked before persistence.
This can become the limiting factor before the 1 MiB content limit. A rejected
size check is definite and does not modify stored content.
Sync frames are capped at 2 MiB and queued input at 4 MiB per workspace. These
are wire/queue bounds, not expanded decoding bounds for compressed Automerge
input. Adversarial decompression and multi-tenant load remain unqualified;
the deployment's CPU, isolate-heap, and service-memory limits remain necessary.

## Tool contract

`GET /api/capabilities` advertises the implemented subset and limits. Call tools
with `POST /api/tools`:

```json
{
  "operation": "read_page",
  "arguments": { "page_id": "page_observed_id", "view": "editing" }
}
```

The shape follows the observed Spaces connector: `page_id`, ordered `blocks`,
`id`, `kind`, `markdown`, `metadata`, `hash`, `title_hash`, and
`through_sequence`. This is a separate HTTP API, not an MCP server or a promise
of drop-in connector compatibility. The service does not connect to or modify
ChatGPT Pages. Existing tools need a small transport adapter.

| Operation | Supported arguments / behavior |
| --- | --- |
| `list_spaces`, `get_space` | One private space, no root Page; `space_id` is validated when supplied. |
| `list_pages` | All Pages in the bounded private workspace; no pagination needed below the 1000-Page cap. |
| `create_page` | `title`, `block_units` or `markdown`, required `idempotency_key`. Returns the created Page and snapshot. |
| `read_page` | `page_id`, `view: editing/full`, `search` literals or observed `block_ids`, optional `include_content: false`. Always includes instruction blocks in selected content and reports missing IDs. |
| `edit_page` | `page_id`, required `base_sequence`, `idempotency_key`, and `operations`. Atomic structural batch. |
| `patch_page` | Same envelope; only `patch_block_markdown`. Partial results, one receipt per operation. |
| `list_page_comments` | `page_id`, optional `state: open/resolved`, `block_id`, and `limit` (1–500, default 100). Returns `sequence`, projected `threads`, and `truncated`. |
| `manage_page_comment` | `page_id`, required `base_sequence` and `idempotency_key`; actions `add`, `reply`, `resolve`, `reopen`, `edit`, `delete_message`. |
| `reply_page_comment` | Same guards, `thread_id`, and `body`; shorthand for `reply`. |
| `read_page_changes` | `page_id`, `since_sequence`. Changed blocks, deletion IDs, complete current block order, title, and authenticated actor records; `resync_required` outside retained history. |

Edits support `set_title`, `insert_markdown` with observed `between_blocks`
anchors, `replace_block_markdown`, `delete_block`, `move_block`, and
`set_block_metadata`. Replacement/deletion/metadata require `expected_hash`.
Title changes require `expected_title_hash`. All edits require an observed
`base_sequence`, including moves. This is deliberately stricter than Spaces'
optional page sequence. Insertion can accept explicit `block_units`; a single
Markdown string stays one block and is not split by blank lines.

```json
{
  "operation": "patch_page",
  "arguments": {
    "page_id": "page_observed_id",
    "base_sequence": 7,
    "idempotency_key": "a-unique-key-for-this-exact-request",
    "operations": [{
      "op": "patch_block_markdown",
      "block_id": "observed-block-id",
      "expected_hash": "observed-hash",
      "replacements": [{ "old": "Draft", "new": "Ready for review" }]
    }]
  }
}
```

Patch literals must each occur exactly once in the original block and may not
overlap. Patch each block once per batch. Instruction blocks require explicit
whole-block editing. A rejected structural batch changes nothing; partial patch
batches return applied/rejected receipts. Do not replay successful siblings
under a new key. After an uncertain outcome retry the identical request with
the same key, or reread. A reused key with different content is rejected.
After receipt eviction an old base sequence prevents silent replay.
An entirely rejected patch batch neither writes a receipt nor advances history.

### Comments

Add a thread with `action: add`, `block_id`, and `body`. Optional exact
`selected_text` plus 1-based `occurrence` anchors a passage within that block.
Replies/resolution use `thread_id`; edits and deletion also use `message_id`.
Each mutation returns the projected `thread`, IDs, `sequence`, and the existing
commit receipt. Retry uncertain writes with the same key and exact arguments.
Unlike the observed Spaces connector, these writes require an observed sequence
and idempotency key. This is an intentionally advertised subset of its contract.

The browser exposes new threads, replies, resolve/reopen, and a resolved filter.
Select Markdown source to comment on a passage; rendered-text and cross-block
selection compose flows await the editor work. Edit/delete-message are API-only
for now. Deleted messages project an empty body and retain a tombstone; their
prior text remains in Automerge history. Reactions and thread deletion are absent.

Thread/message authors and resolvers derive from admitted Automerge object IDs,
never editable author fields. Only the author account may edit/delete a message.
Timestamps are client-supplied display metadata, not a trusted audit clock.
Concurrent replies merge by ID; body edits preserve text identity; deletion hides
concurrent body edits. Resolve/reopen uses an attributed replacement register.

Selection targets contain opaque Automerge cursors and their source text object
IDs, not Yjs positions. The head identifies the last selected character; context
projects exclusive UTF-16 end offsets. Appending after a selection does not expand
it. Deleting its final character or replacing its text object detaches the thread
conservatively, retaining the discussion without attaching it to unrelated text.
Deleted blocks appear under Comments on removed content. The projection bounds
quoted text to 4,000 UTF-16 code units. Pages allow 500 threads, 500 messages per
thread, and 16,000 bytes per message, within the existing document/storage budgets.

Legacy Pages initialize one shared comments map under the workspace queue, before
replicas connect. This advances the server sequence once; clients holding an old
sequence must reread. Content identities/history and idempotency receipts survive. A bounded 4 KiB
migration allowance keeps near-limit legacy Pages readable; ordinary writes
continue to enforce the original budget.
Protocol `nteract-pages-automerge-v2` prevents old clients from treating comments
as unsupported document fields; refresh already-open tabs after upgrading.
Comments use the same durability receipts and IndexedDB recovery as text edits.
They remain private to the account until space membership is implemented.

Not implemented: multi-user sharing, nested/multiple Spaces,
attachments, native artifacts, scratch streams, excerpts, in-block content-edit/Yjs anchors,
semantic reconciliation, task dispatch, or execution. No wording in a Page or
instruction block grants runtime authority. Read the capability endpoint before
adapting a tool workflow that expects these features.

## Deployment

### Optional editor workbench

The separate [editor spike PR](https://github.com/nteract/nteract/pull/4453)
provides a generated-content research fixture. Build its pinned source with
`npm ci && npm test && npm run build` in `experiments/pages-editor`, then set
`PAGES_EDITOR_WORKBENCH_DIST` to that build's absolute `dist` path when running
the Pages build. The three static files are mounted at
`/editor-spike/preview.htm`, with the main service's CSP. Only those named files
are copied; source maps, local state, and source checkouts are excluded. A build
without the variable removes this optional generated directory.

This preview uses two replicas in one browser, resets on reload, and has no
account-Page transport or persistence. It does not migrate existing documents
or claim production presence. Record both source revisions in deployment
receipts. A real document integration still needs an explicit Markdown adapter
or coordinated rich-text schema migration.

The build writes a self-contained celld project to `dist`: Worker JavaScript,
Automerge WASM, Markdown WASM, viewer assets, and `wrangler.json`. Deploy that
directory to a **separate celld fleet/store**; a fleet has one application.
Do not reuse a running notebook fleet's deployment destination.

Set these Worker variables in the deployment configuration/secrets, following
the existing nteract OIDC provider configuration:

```text
NOTEBOOK_CLOUD_OIDC_FLOW=server
NOTEBOOK_CLOUD_PUBLIC_ORIGIN=https://pages.example.com
NOTEBOOK_CLOUD_OIDC_ISSUER=https://your-issuer.example.com
NOTEBOOK_CLOUD_OIDC_CLIENT_ID=your-client-id
NOTEBOOK_CLOUD_OIDC_AUDIENCE=your-api-audience
NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=your-provider-namespace
NOTEBOOK_CLOUD_APP_SESSION_SECRET=<a-new-random-secret-at-least-32-characters>
```

Register `https://pages.example.com/oidc` with the provider. Confidential clients
can also set `NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET` and
`NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD` as in nteract. Never enable
`NOTEBOOK_CLOUD_LOCAL_OIDC` for a public deployment. Terminate TLS at ingress.
The D1 binding is for auth transactions and sessions; Pages use Durable Object
storage. No public deployment is created by build or dev.

### Live `m.runtimed.run` deployment

Use the production Anaconda public-PKCE client already configured for
`*.runtimed.run`, with the following public settings (verified against the
existing host configuration and provider discovery on 2026-10-17):

```text
NOTEBOOK_CLOUD_OIDC_FLOW=server
NOTEBOOK_CLOUD_PUBLIC_ORIGIN=https://m.runtimed.run
NOTEBOOK_CLOUD_OIDC_REDIRECT_URI=https://m.runtimed.run/oidc
NOTEBOOK_CLOUD_OIDC_ISSUER=https://auth.anaconda.com/api/auth
NOTEBOOK_CLOUD_OIDC_CLIENT_ID=1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0
NOTEBOOK_CLOUD_OIDC_AUDIENCE=anaconda,1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0
NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=runtimed-pages-anaconda
NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD=none
NOTEBOOK_CLOUD_OIDC_USERINFO=true
```

The initial deployment on 2026-10-17 ran application revision
`c4a5cceaad48e6955f2c6cd2a7ff2956223045aa` (celld deployment version
`cad376b1fcf3e067`). Any Anaconda account may sign in; workspaces remain private
to each account. A fresh persistent session secret was generated on the host.
No local development state or private reference document was uploaded.

The CRDT rollout on the same date used application revision
`44740c901804931503fe4f376ad26836073b1295`, celld version
`da40b87bf4fa8fac`. It preserves the original OIDC configuration, session secret,
and S3 prefix. The optional, memory-only editor workbench is available at
<https://m.runtimed.run/editor-spike/preview.htm>, built separately from spike
revision `0c554757e65ada690930785d45d151a8233e0682` (PR #4453). Its generated
fixture is not connected to private Pages and resets on reload.

Live browser checks verified title editing, sustained typing, two-tab delivery,
pending-journal recovery, Unicode, and Saved status after convergence. The
rollout caught and fixed premature release of shared Automerge handles and
unbounded client send cadence under bucket durability; both have regression
tests. Public viewer, WASM, and workbench hashes match the release manifest.
The workbench converged its two in-browser replicas and fit a narrow viewport;
this does not qualify native mobile keyboard/IME behavior or live comments.

The comments rollout uses application revision
`07e24ccac6890afbb9c646f2fc2ad3365b0d2673`, celld version
`c6ce59dd23facddf`, adopted on 2026-10-17. It preserves the same auth settings,
secret, and S3 prefix. Public viewer, Automerge WASM, and editor-workbench hashes
match the release manifest. Live two-tab checks verified thread creation,
replies, resolution/reopening, durable Saved state, and reload persistence.
Existing Pages retain their content while acquiring the comments map. Refresh
old tabs for protocol v2. This rollout does not enable shared-space access.

| Component | Deployment |
| --- | --- |
| Host / service | lab1 / `nteract-pages.service`, dedicated `nteract-pages` Unix user |
| Runtime | `/opt/nteract-pages/celld`, celld 0.6.1; official Linux release verified with GitHub artifact attestation |
| Runtime archive SHA-256 | `79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b` |
| Fleet / state | `s3://nteract-celld-lab-621741996708/standalone/pages`, `CELLD_DURABILITY=bucket` |
| Worker / operator listeners | `127.0.0.1:9471` / `127.0.0.1:19471` |
| Local cache | `/var/lib/nteract-pages/cache`; S3 is the durable authority |
| Release files | `/opt/nteract-pages/releases/<source-sha>`; manifest and runtime attestation in `/opt/nteract-pages` |
| Session secret / deployment receipt | Root-only `/etc/nteract-pages` |
| Limits | 1 GiB systemd memory ceiling, one CPU, 128 MiB V8 heaps, 2 MiB ingress bodies |

Cloudflare DNS points this exact hostname to lab1's existing tunnel. Its exact
ingress rules precede the wildcard preview rule and admit only the viewer
assets, root page, OIDC callback, and implemented API routes. Other paths
return 404, including development and celld operator endpoints. The separately
owned `inet nteract_pages` nftables table restricts both service listeners to
root and the Pages service user. Cloudflared runs as root. Other preview users
cannot connect directly, even from the same host.

The shared celld binary remains 0.5.1. Existing controller, router, and operator
processes were unchanged; cloudflared was restarted to load the focused route
addition. Pages is deployed manually and does not track PR pushes or disappear
when a PR closes. Do not use the notebook preview installer to update it.

For updates, rebuild and verify an exact source revision, preserve the Worker
variables and session secret, and deploy only to the Pages prefix with its
pinned runtime. Record the new deployment version. A code rollback redeploys a
retained release to that same prefix; it does not undo state migrations.
Stopping `nteract-pages.service` preserves S3 state. Route withdrawal should
remove only the two exact Pages ingress entries and its owned DNS record;
never restore an old whole-tunnel configuration over later unrelated changes.

Live checks established browser Anaconda login and callback, Page creation,
title and Markdown editing, rendered content surviving a reload, rejected
anonymous/cross-origin/raw-bearer writes, private operator
routes, and denied listener access from the preview Unix user. A synthetic Page
was created through the private operator listener, then restored after stopping
the service and moving its local cache aside. This proves recovery from S3 for
that Page, not multi-node failover or a load/cost qualification. An early request
during the restart returned `NodeUnavailable`; the read succeeded once the new
node was ready. Readiness should be checked before admitting traffic on restart.

## Verification

```sh
pnpm --dir apps/pages test
pnpm --dir apps/pages typecheck
pnpm --dir apps/pages build
# With the dev service running:
pnpm --dir apps/pages smoke
# Generated-content payload comparison; no service or credentials required:
pnpm --dir apps/pages probe:storage
```

The tests cover concurrent text merging, stale guards, atomic rollback, partial
patches, Unicode, stable identity, idempotency, storage failure, HTTP call
serialization, change cursors, workspace separation, and CSRF boundaries.

## Realtime WYSIWYG spike

The stacked editor branch mounts ProseMirror on the same browser PageReplica
and `/api/sync` transport. New browser prose blocks use the versioned
`automerge-rich-text-v1` representation. Existing Markdown blocks convert through
the guarded `enable_rich_text` operation; instruction blocks keep their source
editor. Stable block IDs and metadata are retained.

New Pages open directly in the editor: click the prose and type. One document
toolbar applies to the focused block. There is no per-block Edit/Done mode.
Older source Pages offer one Edit this page action, converting their prose in
guarded batches. Instructions remain directly editable source. The action warns
when existing selected-passage comments will lose their original highlight.

Enter creates a paragraph (or list item) inside the current rich-text block;
it does not create another addressable Page block. The Block action is for
separate sections that tools can target and move. Comments sit alongside their
block on wide screens, with an expandable entry above the text on narrow screens.
Selected-passage comments keep their quoted context. Exact inline positioning
and selection spanning multiple Page blocks remain follow-up work.
Agent-instruction blocks remain supported by the API and existing content stays
editable, but the writing UI does not offer a separate insertion button for them.

Rich content lives in `richText` (Automerge marks and block markers). The old
`markdown` field is immutable import provenance. HTTP snapshots export the rich
field as Markdown; semantic Markdown tool edits update the rich field too.
This avoids two independently editable copies. Unknown imported syntax stays
opaque. The app advertises supported text formats and uses sync protocol v3,
so older source-only clients stop at the handshake instead of corrupting rich
content. Deployment must update the Worker and browser together.

Presence uses bounded, ephemeral messages over the authenticated Page socket,
with server-assigned session identity and CRDT cursor endpoints. It is not
stored in the Page history. Peer selections expire after 30 seconds and only
render once their causal heads are available. Current sharing remains limited
to devices on the same account.

The ProseMirror binding is pinned to 0.2.0, including its internal position-map
helpers. A scoped remote-join repair is retained from the isolated fixture.
Paragraphs within a Page block support range editing, formatting and undo;
selection across Page blocks is deferred. Real-device IME and accessibility
qualification remain outstanding. The Markdown parser dependency is pinned to
14.2.0 because newer registry metadata requested an unavailable linkify-it
version during installation, including when using its published tarball URL.
The dependency audit flags markdown-it GHSA-253c-mchw-3w2r and linkify-it
GHSA-v245-v573-v5vm. Both affect linkification, which this CommonMark parser
explicitly disables. Replace the fallback with patched dependencies before
promoting this spike. The repository-wide audit also has pre-existing findings.

Passage comments use the authoritative text object: rich blocks anchor to
`richText`, source blocks to `markdown`. Comments on the source before conversion
remain available but detach, rather than quietly quoting stale provenance.

Run `PAGES_ORIGIN=http://localhost:9893 node apps/pages/scripts/editor-smoke.mjs`
from the repository root against a running local service. It creates generated
fixtures and verifies two-browser editing, presence, passage comments, undo,
offline convergence, reload, and a narrow viewport. It does not qualify iOS IME.
Comment tests cover ownership at raw ingress, concurrent messages/statuses,
selection detachment, migration, idempotency, failure rollback, and restart.
