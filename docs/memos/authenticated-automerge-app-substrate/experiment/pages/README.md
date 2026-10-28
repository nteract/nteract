# Pages

Pages is an **actively maintained experiment** in collaborative documents for
people and agents. People write in a rich editor; agents read and edit Markdown
through HTTP or MCP. Both work on the same Automerge document, with passage
comments, presence, private images, and host-enforced sharing.

The application evaluates experimental Automerge Repo 3 and Subduction as a
shared document foundation. It has its own document model and deployment; it
does not migrate or replace nteract notebooks. APIs, editor behavior, and resource
limits may evolve as the experiment is exercised. Page8 is the current isolated
QA deployment; Page7 and earlier deployments remain frozen.

- [Architecture and motivation](../../README.md)
- [Shared integration workspace](../README.md) and [upstream provenance and patches](../UPSTREAM.md)
- [Deployment and rollback boundaries](DEPLOYMENT.md)

## Run locally

Use Node 22.13 or newer, Git, npm, and `celld` on `PATH`. The local E2E harness
requires celld 0.6.3; use that runtime to qualify the current profile. From the containing `experiment` directory:

```sh
npm run setup
npm run build --workspace @nteract/pages-native-experiment
PAGES_ASYNC_PERSISTENCE=true PAGES_COMPACT_RECORDS=true \
  npm run dev --workspace @nteract/pages-native-experiment
```

Setup fetches and verifies the pinned upstream source, installs the locked
workspace dependencies, and builds the Repo packages. The separate Pages build
must finish before `dev`; rebuild after source changes. The dev command serves
`http://localhost:9894`. Set `PAGES_PORT` to use another port.

Wordgard is the only browser editor, locally and in deployed Pages. The
`PAGES_EDITOR` comparison flag is no longer used. These flags enable background
record persistence and lossless record cleanup used by Page8; without them,
local persistence is synchronous. A Page records its storage mode at creation:
changing a persistence flag does not migrate existing local documents.

Local sign-in uses a loopback-only OIDC issuer. State persists under
`pages/dist/.celld`; local credentials and build output are ignored. The dev
issuer cannot be enabled on a public deployment by copying its flag. Browser
and Worker entry points share the workspace's pinned Automerge version and
initialize their respective WASM packaging.

## Verify changes

From `experiment`:

```sh
npm test
npm test --workspace @nteract/pages-native-experiment
npm run build --workspace @nteract/pages-native-experiment
npx playwright install chromium
npm run test:e2e:sharing --workspace @nteract/pages-native-experiment
```

The focused CI workflow runs setup, both unit-test suites, and the Pages build.
Browser E2E is a separate check. On a fresh Linux runner, install browser system
dependencies with `npx playwright install --with-deps chromium`.

The sharing E2E command builds Pages and starts an isolated celld process on an
available loopback port. Three browser profiles use the real local OIDC
code/PKCE flow to test invitations, viewer/editor roles, edits, promotion,
downgrade, revocation, reload, and reconnect. Generated API keys exercise the
normal validator, MCP, ACL, and sync paths through a test-only provider response.
That fixture rejects external fetches and is absent from the production entry;
it does not qualify Anaconda's live provider or key issuance.

E2E state and credentials are temporary; existing `dist/.dev.vars` and
`dist/.celld` are not reused. Reports, screenshots, and logs remain under
`pages/test-results/sharing-<timestamp>`. `CELLD_BIN` selects the runtime,
`PAGES_E2E_OUTPUT` selects the output directory, and `--skip-build` reuses a build.

Run targeted browser checks from `pages`:

| Check | Command | Server lifecycle |
| --- | --- | --- |
| Company-domain access | `node scripts/local-sharing-e2e.mjs --domain-view` | Starts an isolated fixture |
| Browser uploads and image permissions | `node scripts/local-sharing-e2e.mjs --images` | Starts an isolated fixture |
| MCP file import, insertion, and retries | `node scripts/local-sharing-e2e.mjs --mcp-images` | Starts an isolated fixture |
| Collaborative checkboxes | `node scripts/local-sharing-e2e.mjs --task-lists` | Starts an isolated fixture |
| Native table editing | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:tables` | Uses the running Wordgard fixture |
| Passage edits and revision deltas | `PAGES_ORIGIN=http://localhost:9894 node scripts/passages-changes-smoke.mjs` | Uses the running Wordgard fixture |
| Local creation and navigation | `PAGES_ORIGIN=http://localhost:9894 node scripts/navigation-smoke.mjs` | Uses the running Wordgard fixture |
| Editing, comments, links, diagrams, and recovery | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:editor` | Uses the running Wordgard fixture |
| History growth and typing latency | `PAGES_ORIGIN=http://localhost:9894 node scripts/latency-smoke.mjs` | Uses the running Wordgard fixture with buffered persistence |

Use `PAGES_ASYNC_PERSISTENCE=true` for the latency check. The editor checks
exercise the same Wordgard path used by deployed Pages.

Choose one `local-sharing-e2e.mjs` feature flag per run. Its image importer fixture
supplies a synthetic ChatGPT download response; actual client file handoff needs
live verification. Synthetic browser tests also do not establish real OS IME,
mobile-keyboard, object-store failover, or deployment reliability.

## Document and editor

A Page contains its title, stable ordered block IDs, rich text, and comments in
Automerge. Markdown is the import/export and tool projection. A dedicated title
is displayed above the body; agents should not repeat it as an opening heading.
Authoring receipts warn about likely duplicates without removing or hiding text.

Wordgard is the sole editor and applies native text splices, marks, and
structural spans. The shared Markdown codec still uses ProseMirror schema and
traversal libraries for import/export, validation, and passage-address mapping.
It does not own an editor or mediate Wordgard keystrokes. Keeping that codec
preserves existing documents, comment anchors, and MCP operations while the
browser editor is simplified; replacing it requires a separate compatibility
pass. Each Pages block has its own continuous editor. Moves update fractional positions without recreating the block or its
text object, preserving comment and selection anchors. Concurrent positions use
block IDs as deterministic ties. Cross-Pages-block selections remain unsupported.
The binding's upstream attribution is in [WORDGARD-NOTICE](viewer/WORDGARD-NOTICE).

The interface keeps navigation and account actions outside the document, with
contextual formatting, a searchable Pages list, and System/Light/Dark appearance
using nteract's shared tokens. Theme preferences are browser-local. **Copy as
Markdown** in Share exports the title and content, including private image
references; it does not publish the Page or change asset access.

- **Comments:** select a passage and choose Comment, or press Cmd/Ctrl+Alt+M.
  Highlighted passages and thread quotes navigate between text and discussion.
  Draft anchors capture native object identity and text cursors; deleted or
  replaced passages reject submission rather than moving a comment elsewhere.
  Replies survive responsive rail/sheet changes; changing Pages clears local drafts.
- **Links:** click for Open, Edit, and Remove; Cmd/Ctrl-click opens directly and
  Cmd/Ctrl+K edits. Incoming edits update or dismiss the link control, and URL
  policy applies both to stored content and navigation.
- **Code and diagrams:** three backticks on an empty paragraph followed by Enter
  or Space creates code; a language can follow the backticks. Mermaid renders
  through nteract's Pele renderer and SVG sanitizer. Compact Edit diagram,
  Preview, and Copy diagram code controls switch the local view. Source and
  language are shared content; rendered SVG is not stored. Cmd/Ctrl+Enter
  continues in a paragraph. Pages does not execute code.
- **Tables:** native row/cell markers live in the same rich-text field as prose.
  Insert table chooses dimensions; Table options changes rows and columns. Tab
  moves between cells and appends a row at the end. The first row is the header.
  Preserved Markdown tables convert only through an explicit, undoable Edit
  table action; unsupported syntax stays preserved. Column resizing/moving and
  merged cells are not implemented.
- **Task lists:** use Task list or type `- [ ] ` / `- [x] `. Enter creates an
  unchecked item; an empty item returns to prose. Native list-item markers store
  checked state independently of the text, so checkbox and text edits can merge.
  Markdown preserves nested tasks. Read-only Pages disable checkbox changes.

## Opening, recovery, and ownership

Canonical links are `/p/<page_id>`; browser Back/Forward restores the corresponding
Page and legacy query links normalize. Direct links work independently of the
catalog but never bypass Page permissions.

Browser creation allocates the Page and history locally, persists them to
IndexedDB, and opens the editor while authenticated registration proceeds.
Retries reuse the same ID, immutable bootstrap, key, and server retry token.
Account-scoped checkpoints let other tabs recover pending work; each tab has its
own native signing identity/database, protected by Web Locks. Checkpoints merge
Automerge history, and local deletion tombstones prevent stale tabs from reviving
removed entries. Browser storage eviction is outside the recovery guarantee.
An existing local replica can open before network sync; this does not guarantee
an offline cold start of application assets or authentication.

```text
Browser Repo + Wordgard                 Authorized HTTP / MCP operations
            | authenticated binary sync             |
            +--------------------+-------------------+
                                 |
                         Page Durable Object
                         Repo + Subduction
                         host-owned access/control state
                                 |
                    PageRecords Durable Object (buffered mode)
                                 |
                         ctx.storage / runtime
                                 |
                     celld SQLite/LTX + fleet bucket
                      or Cloudflare SQLite Durable Objects
```

Catalog objects index owned/shared Pages; D1 stores server sessions and MCP OAuth
state. Ownership, ACLs, signing-key bindings, credential leases, and deletion are
host state outside the document. Unknown document fields are preserved; projecting
known content is not authority to rewrite the whole schema.

The byte-store adapter delegates persistence to `ctx.storage`. The runtime owns
replication and recovery; the application does not create a second SQLite store
or upload a new document snapshot for every edit. Images have a separate private
blob binding. See [upstream integration contracts](../UPSTREAM.md) and celld's
[durability guarantees](https://celld.dev/docs/guarantees/).

## Authentication and sharing

Browser sessions reuse nteract's Anaconda OIDC flow; API keys reuse its provider
verification and capability bounds. Configure OIDC and API-key principal
namespaces explicitly when they represent the same account. The native handshake
binds a proven peer signing key to that authenticated account. Storage and
presence policies enforce access; disabled editor controls are not authorization.

Pages also serves OAuth for `/mcp`. Its predefined ChatGPT and Kilo clients require
exact callbacks, PKCE S256, resource validation, sign-in, and consent. Arbitrary
client metadata fetching and dynamic registration are disabled. Codes are
single-use; access tokens last ten minutes, with rotating refresh tokens bounded
by an absolute thirty-day grant. Correctly bound code/refresh replay revokes its
family. Provider tokens stay on the server. Refresh does not refresh verified
email evidence, and MCP tokens cannot authorize raw HTTP assets, sharing, or sync.

`/connect` and the public `/llms.txt` are the maintained client setup guides.
They cover OAuth, API-key alternatives, and driver attribution. Agents can prepare
non-secret configuration while a person authorizes the connection; a successful
`list_pages` call verifies access. A driver label is a description, not verified
vendor identity or a permission grant.

A Page starts private. Its immutable owner manages access and deletion, editors
write/comment, and viewers read. Each operation intersects the Page role with
credential scopes. Email invitations expire after seven days, become stable
principal grants only after verified provider email admission, and do not send
email. Pending invitations cannot authorize sockets or override a newer role.
There is no public/anonymous access, commenter-only role, or ownership transfer.

Company-domain viewing is an optional, read-only fallback. Deployment configuration
and the owner's Page setting must both allow it; only `anaconda.com` is currently
recognized. Existing Pages remain Restricted. Verified domain proof expires after
six hours without fresh identity verification, including active sockets. OAuth
refresh cannot extend that proof. Explicit revocation overrides domain access;
removing the audience revokes fallback access without creating permanent members.

ACL updates use a revision and idempotency key. Increases wait for durable
confirmation; reductions apply immediately. Downgrade/removal retires affected
native writer keys and disconnects peers. A new grant cannot revive those keys.
Dirty browser replicas pause with a downloadable draft rather than silently
re-signing rejected offline edits. Previously accepted history remains available;
revocation cannot retract downloaded documents or images. Historical signer
provenance does not authenticate arbitrary actor strings inside imported history.

Browser sessions renew while open and on return to the tab. Native sockets retain
the expiry observed on admission and reconnect with current credentials. API-key
sockets renew bounded leases through provider verification; caching means provider
revocation is not instantaneous. A pending or late check cannot revive an expired,
disconnected, or changed grant. Page ACL enforcement is independent of sign-in renewal.

Membership, invitation, connection, and lifetime signing-key counts are bounded;
retired keys remain recorded to prevent regained authority. See [access.mjs](worker/access.mjs) and the Worker tests for membership admission
and the associated resource limits. Sharing
receipts retain the latest 256 results; older retries must still pass the revision
guard, and receipt capacity never prevents revocation. Comment author labels are
editable document data, not an audit log; author-only comment editing is not implemented.

## Private images

Browser upload, screenshot paste, and file drop send PNG, JPEG, or static WebP to
`POST /api/pages/:pageId/assets`. Only a stable Page-scoped reference and alt text
enter Automerge. Image bytes use the private `PAGES_ASSETS` R2 binding, backed by
the fleet object store on celld. Immutable hash-addressed assets avoid repeated
uploads; they do not consume the document history budget.

Uploads check current edit permission before transfer and again before returning
the asset. Transfer does not hold the Page mutation queue. Browser insertion
captures a CRDT cursor and refuses to redirect a completed upload into a replaced
block or revoked editor. `GET`/`HEAD /api/pages/:pageId/assets/:sha256` check current
read access before lookup, then return verified raster MIME, `nosniff`, and
`Cache-Control: private, no-store`. No public bucket, persistent presigned URL,
or cross-Page hash lookup is exposed.

Current limits are 5 MiB per image, 8192 pixels per side, and 25 million pixels;
the HTTP request ceiling is 6 MiB. SVG, HTML, GIF, APNG, and animated WebP are not
accepted. Container validation is not full pixel decoding. Removed images and
interrupted uploads may leave private objects: immediate deletion would break
undo or offline references. Asset garbage collection and copying assets between
Pages/deployments require a separate lifecycle implementation.

For agents, importing bytes and inserting content are separate operations:

1. API-key clients upload raw bytes to the asset endpoint. ChatGPT uses
   `import_page_image({page_id, file})` with its client-provided file descriptor.
   The importer requires read/write OAuth scope and Page edit access, accepts
   bounded HTTPS downloads from `files.oaiusercontent.com` without redirects,
   and returns `asset_id`, reference, MIME, dimensions, and size. A file ID alone
   is not a download URL. Temporary source URLs are not stored in the document.
2. Read the current Page, then call guarded `edit_page` with `insert_image`,
   `asset_id`, alt text, and optional `after_block_id` (omitted appends; `null`
   prepends). The host verifies the asset belongs to this Page and creates a
   dedicated image block. Its receipt returns the actual `block_id`, asset
   reference, updated heads, and Page URL. Exact retries reuse that result.
3. Read back the block. Upload success alone is not insertion or proof of rendering.

The MCP schema declares `_meta["openai/fileParams"]` for the client handoff. No
base64 argument or extra API key is needed for that route. Client catalog refresh
may be necessary; a generated ChatGPT image must actually be exposed as a
transferable file. The importer does not provide image-reading capability or
imply pixel access from a Markdown reference.

## Persistence and resource limits

Local Repo completion means local history is recoverable. Remote edit visibility,
native peer heads, and an online connection do not prove durable storage.
`POST /api/saved?page=<id>` waits for the host's Repo/backend and captured record
batches to cross the configured durability barrier before acknowledging heads.
The browser retains pending state through bounded receipt retries; sign-in failure
pauses them until renewal. A client timeout does not cancel or reorder persistence.

With `PAGES_ASYNC_PERSISTENCE=true`, the live Page keeps a bounded in-memory record
replica and sends batches to a separate `PageRecords` object, normally after one
second or on a receipt request. Its output gate does not block ordinary outgoing
edits and presence. Control state and API intents remain durable on the live Page,
so admission and API writes may still encounter storage latency. Failed batches
remain retryable beneath newer values. After a crash, the host recovers persisted
records and browser replicas resynchronize later history. A generation lease
rejects stale pre-crash batches.

Versioned binary records preserve signed native envelopes and Automerge changes;
legacy hex records remain readable. `PAGES_COMPACT_RECORDS=true` enables
conservative cleanup only after a retained fragment is durably proven to contain
all changes in a redundant record. API intent reservations prevent removal of
records needed for replay. This is lossless packing, **not history truncation**;
offline peers retain their merge history. See [UPSTREAM.md](../UPSTREAM.md) for
the pinned native fixes, storage-index ownership, codec, and cleanup contracts.

The current resource envelope remains 16 MiB of aggregate native history and
900 KiB per record, with a 1,900,000-byte stored-frame-plus-key guard. The transport
allows individual frames up to 32 MiB and bounds its receive queue at 32 MiB/256
messages. These guards do not bound all decoded WASM state, runtime-owned outgoing
queues, or total isolate memory. Binary encoding alone does not qualify larger
histories, Cloudflare memory use, or cheaper object-store operation.

API admission reserves exact records through the same writer used by native
ingress before journaling an intent. Recovery validates pending changes before
modifying the serving document. An older over-capacity intent leaves accepted
history readable but blocks writes with an explicit recovery error; it is never
silently discarded or rebuilt from JSON. Rollbacks must retain both binary record
readers and the `PageRecords` binding for buffered Pages.

Resident WebSockets reconnect after restart. Hibernation, cross-host ownership
transfer, power-loss/bucket failover, and larger resource envelopes need separate
qualification. Runtime adaptations such as the Worker-only CBOR Uint8Array path
are source-checked and regression-tested; a passing storage probe alone does not
qualify ephemeral presence. Diagnostics exclude provider messages, credentials,
request bodies, and document content.

## HTTP and MCP tools

`POST /api/tools` accepts `{operation, arguments}`; `POST /mcp` exposes the same
Page operations through Streamable HTTP MCP. MCP accepts a Pages OAuth access
token or Anaconda API key in `Authorization: Bearer ...`; `X-Pages-Driver` is an
optional client label. OAuth scopes and current Page permissions apply on every
call. The public `/llms.txt` is the tool usage and authentication reference.

Other endpoints include `/api/access` for sharing, `/api/connect` for native
admission details, `/api/sync` for binary WebSockets, and `/api/saved` for durable
receipts. OAuth metadata is public at
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`; authorization, token exchange/refresh,
and revocation use `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`.

Reads capture content and heads together. Agents can select blocks, exact heading
sections, literal hits with neighboring nodes, or revision-bound node ranges.
`include_content:false` provides a paginated outline; explicit read projections
use bounded response budgets and never silently truncate content. Partial slices
are suitable for literal edits, not whole-block replacement. `list_page_comments`
reads filtered threads separately. Legacy `read_page({page_id})` remains unbounded
for cached clients.

`read_page_changes({page_id,since_heads})` returns a complete net delta at one
captured revision: changed native nodes, address-only deletions, title changes,
and compact comment changes. Stable native identity avoids treating later
paragraphs as changed when an earlier one is inserted. It is not an event/audit
log and does not supply historical person/client attribution or deleted message
bodies. Unknown history returns `resync_required`; oversized deltas return
`changes_budget_exceeded`, never partial success. Advance saved heads only after
consuming a successful response or resynchronizing with focused reads.

Mutations require observed `base_heads` and an idempotency key. The default
`conflict_scope:"page"` requires exact current heads. `patch_page` can use
`conflict_scope:"target"` for `replace_match`-only batches: native identity maps
historical literal ranges into current text, checking text, marks, and structure.
Optional `node_index` narrows the match at the base revision. Unrelated edits,
even within the same block, survive. Deleted/reinserted text is a new target;
overlapping batch targets are rejected. Structural/Markdown changes retain the
exact-head guard. Conflicts provide bounded addresses for focused rereading.
Guards check the preparation snapshot; native changes can still merge during
persistence. Tool mutations do not simulate typing or lock out peers.

`edit_page` supports structural operations including `insert_markdown`,
`move_block`, and `insert_image`. Placement uses stable `after_block_id` values,
`null` to prepend, or omission to append; fractional positions are internal.
Content warnings, inserted image IDs, and other receipt results are captured at
the operation's actual heads and are not recomputed during retry.

### Retry contract

After a conflict, reread before constructing new work. For an uncertain outcome,
retry the **identical token, key, and payload**. Page reads/deltas supply
`retry_token` and `retry_key_prefix`; catalog listing supplies create/delete
authority. Append a UUID to the returned prefix for a new operation.

Tokens last seven days. Expired completed requests return `410 retry_expired`
without executing, even after receipt collection; reconcile the old outcome
before deliberately submitting new work. Pending intents never expire and retain
their original replay authority. The journal first persists the causal base and
encoded changes, then replays identical CRDT change IDs after interruption.
Exact record reservations protect those changes from concurrent ingress and cleanup.

The versioned journal bounds active receipts at 1,000 entries/8 MiB and pending
work at 64 entries/4 MiB. Capacity causes explicit backpressure. Collection removes
expired completed receipts with a durable monotonic clock floor, not arbitrary
keys. Legacy receipts retain a separate 1,000-entry cap; browser edits do not
consume this budget. Catalog deletion tombstones remain permanent. See the
[operation journal](worker/operation-journal.mjs) and its integration tests.

### Progress and presence

`report_page_progress` creates an independent host-memory session with a private
lease token. Only its caller can update or clear it; status expires within 60
seconds and requires current edit access. It creates no document changes or
receipts. Optional passage targets use native cursor anchors and detach when
the passage is replaced/deleted. Restart and access changes clear activity;
external credential revocation is observed on a later authentication check.

`read_page_presence` returns recent browser selections and agent activity without
the body or edit authority; `read_page({include_presence:true,...})` includes the
same projection. Peer identity comes from authenticated admission, while driver
labels and progress text remain claims. Selection is not proof of typing, and
progress is not proof of a completed edit. Counts, message sizes, and wire bytes
are bounded. The UI clears its quiet activity disclosure on connection/access loss.
