# Standalone Pages on celld

**Status:** Working prototype plus proposed direction, 2026-10-17. The editor,
sharing, transports, attribution, comments, and incremental persistence below are not
implemented unless explicitly listed as current behavior.

## Purpose and deployment boundary

Build an independently deployable document service using Automerge, celld,
nteract's Markdown renderer, and its server OIDC implementation. Develop the
Pages experience without changing the notebook-cloud deployment lifecycle.
Later integration into a single offering should preserve stable document
identities and operations; it does not require a shared deployment today.

The prototype is deployed at `https://m.runtimed.run` on lab1, using the
existing Anaconda public-PKCE client. Live browser sign-in and the exact
callback completed on 2026-10-17. Any Anaconda account may sign in; each account
currently has private Pages. This is the initial behavior; the intended model
includes permissions and sharing for each space, following notebook-room
sharing. The [application README](../../apps/pages/README.md) records
the deployment configuration and verification boundaries. Pages has a separate
S3 prefix, session secret, celld 0.6.1 runtime, systemd service, and exact ingress
route. It does not use the notebook preview router or PR-close lifecycle.

## Current implementation

`apps/pages` builds its own Worker, WASM, and browser bundle. One private
workspace Durable Object serves each authenticated account, with a separate
Automerge document per Page. A Page contains a title, ordered stable block IDs,
and a block map. Blocks contain Markdown or agent instructions plus metadata.
Parser node IDs are rendering details, not persisted block identities.

The HTTP tool API implements a subset of Spaces-shaped reads, guarded edits,
literal patches, idempotency receipts, and sequence-based change reads.
Structural batches are atomic; literal patch batches report partial results.
The browser polls and performs explicit saves with conflict/draft recovery.
This is neither a drop-in Spaces connector nor an MCP server. It has no
execution, sharing, comments, raw CRDT ingress, or offline synchronization.

Server-login mode admits endpoint-local sessions and rejects raw provider
tokens, matching notebook-cloud's isolation for a shared OAuth client.
Independent agent credentials scoped to Pages remain future work. A separate
bearer-only installation requires explicit `PAGES_ALLOW_PROVIDER_BEARER=true`
and must not reuse that shared client. Missing configuration never enables
provider-bearer access, and server-login mode always rejects it.

## Space identity and sharing

Space-level sharing is a product requirement. A personal space starts private,
but an account is not the permanent boundary of collaboration. Each space has
a stable identity, an owner, and explicit membership permissions. Its Pages
inherit access from that space. Signing in with Anaconda establishes identity;
it does not grant access to other accounts' spaces.

Use nteract's [hosted sharing model](../prd/hosted-sharing-invites.md),
[sharing types](../../apps/notebook-cloud/src/sharing.ts), and
[invite storage](../../apps/notebook-cloud/src/sharing-storage.ts) as references.
Adapt the resource boundary to a space rather than copying notebook identifiers
or runtime-peer permissions. The proposed first roles are:

| Role | Space permissions |
| --- | --- |
| Owner | Manage membership and space settings; read and edit Pages. |
| Editor | Read, create, and edit Pages within the space; cannot grant access. |
| Viewer | Read Pages; cannot change content or membership. |

Invite and revoke access through authenticated principals, resolving pending
invitations through verified provider identity as notebook sharing does.
Writable document metadata and display names cannot grant membership. Public
links, ownership transfer, and per-Page permission overrides are separate
decisions; they are not implied by opening sign-in to all Anaconda accounts.
Future comments inherit space access, with comment-writing permissions specified
explicitly when that feature is introduced.

Apply the same authorization to space discovery, Page reads and mutations,
change history, future comments, subscriptions, and tool transports. Resolve
each Page's actual parent space on the server; a supplied space or Page ID is
not proof of access. Delegated agent credentials are bounded by both their
granted scope and the principal's current space membership. Revocation must
stop future reads/writes and invalidate existing subscriptions; already-read
content cannot be recalled from a client's device.

The current account-derived workspace address needs a migration to explicit
space identity and an account's accessible-space index. Preserve existing Page
and block IDs, history, actor attribution, and private ownership during that
migration. A space-owned Durable Object can keep membership checks and admitted
content mutations under one authority; if Pages move into separate objects,
define permission fencing and revocation ordering rather than relying on a
stale membership cache. Existing account-bound drafts will also need space/Page
identity and access-loss handling without transferring drafts to another user.

The first implementation should qualify owner/editor/viewer behavior for both
browser and API access, invitation acceptance, revocation during an open session,
cross-space ID substitution, and migration of existing private Pages. Sharing
is not enabled by this design update or on the initial deployment.

## Editor: blocks inside a document

Design toward WYSIWYG within blocks and selections that span blocks. Block
boundaries should not force isolated editor instances. The textarea interface
is a prototype, not the target editing architecture; editor choice and visual
design remain open.

Represent a selection with stable start/end block IDs, positions within their
canonical source, direction, and an observed document revision. Source positions
need an explicit encoding and mapping to rendered Markdown. DOM offsets and
transient parser node IDs are not durable anchors. Evaluate Automerge cursors
for persistent text positions; define behavior for deleted text and blocks.

Cross-block replacement, paste, split/join, and deletion should be one logical
operation with atomic validation. Undo should group that operation rather than
the individual block mutations. IME composition, keyboard navigation, accessibility,
Markdown round trips, rich inline content, and selections crossing noneditable
instruction blocks need editor prototypes before choosing a library. Whether
Markdown text alone is sufficient for lossless rich editing remains open; avoid
an independently authoritative rich-text tree beside Markdown.

## Operations and transports

Keep the semantic operation layer independent of presentation and transport.
The first UI can expose fewer operations than the API. Preserve observed IDs,
hash guards, idempotency, explicit commit outcomes, and capability discovery.

| Adapter | Proposed purpose |
| --- | --- |
| HTTP | Reads, bounded mutations, retries, and automation without an open editor |
| WebSocket | The same operations plus resumable committed-change subscriptions and ephemeral presence |
| WebMCP | Tools exposed by the signed-in page, calling the same operation client as the UI |

WebMCP exposes browser-side JavaScript tools; it is not a backend sync protocol.
The [current draft](https://webmachinelearning.github.io/webmcp/) uses
`document.modelContext`; isolate feature detection and lifecycle handling in
the adapter. Browser execution context does not establish a separately verified
agent identity. A remote MCP adapter can be added independently.

For WebSocket commands, correlate request IDs with the existing idempotency
keys. Emit committed events only after the corresponding persistence boundary.
Resume by sequence, deduplicate replay, and return an explicit resync requirement
when retention is exceeded. Bound queues and disconnect slow consumers with a
recoverable cursor. Presence has a TTL and is not part of durable content history.
Revocation/expiry must terminate or reauthorize subscriptions; browser upgrades
need same-origin checks. Do not place reusable credentials in WebSocket URLs.

The first socket protocol can carry semantic operations. Accepting raw Automerge
sync is a separate capability requiring actor admission, document/schema checks,
permission enforcement, and recovery tests. A socket alone does not add offline
editing or authorize client-supplied changes.

## Attribution and illumination

Separate the account authorizing an operation, its human/agent session, and its
operation ID. Bind admitted actor identities to authenticated credentials or a
server-issued session/delegation. Caller-supplied agent names and transport labels
may aid display but cannot prove authorship or grant permissions. Specify the
delegated credential's page/workspace scope, permitted operations, expiry, and
revocation before enabling independent agent writes.

Current Pages history records the authenticated account for a batch; Automerge
actors are not yet bound to that account/session. Do not derive trusted text
authorship from those existing actors. A migration must retain old attribution
as unknown or batch-level evidence rather than inventing historical authors.

Reuse nteract's separation between text-patch events and temporary editor
decorations: see [text-attribution.ts](../../src/components/editor/text-attribution.ts)
and [runtimed-wasm](../../crates/runtimed-wasm/src/lib.rs). Its current helper
associates each patch with the set of actors in the received change batch; that
is useful illumination, not exact character-level forensic provenance.
Pages events should identify affected blocks/ranges and their before/after
revision so marks can be mapped safely, suppressed for replay, and distinguished
from the durable operation history. Deletions and moves need their own visual
representation rather than a fabricated inserted-text range.

## Comments

Reuse the authored-change model in
[CommentsDoc](../../crates/comments-doc/AGENTS.md): thread/message creators and
resolvers derive from admitted Automerge authorship, not writable author fields.
Keep actor checks at every ingress path, including semantic API operations and
any future raw sync path. An actor ID is not authentication by itself.

The thread/message model is reusable, but `NotebookCommentRef` and
`CommentAnchor` currently carry notebook/cell semantics. Add explicit Page,
block, and block-source-range targets rather than disguising blocks as cells.
Start with create/reply/resolve/reopen operations and stable thread/message IDs.
Allow comments to survive a deleted target as explicitly orphaned/page-level
threads; do not silently attach them to unrelated text. Range recovery must
distinguish exact matches, ambiguous matches, and missing targets.

A separate comments document inside the same Page authority is a candidate,
not a settled schema. Decide whether content and comments share a commit cursor
or have explicit separate cursors, and define deletion/anchoring consistency.
The Rust model cannot simply be imported into this JavaScript Worker: evaluate
a small WASM interface or extraction of a shared core before copying it.

## Persistence closer to the primitives

The prototype loads binary Automerge on each request, projects/hashes all blocks,
and saves the entire document on each edit. A stored Page value also contains
retained events, receipts, and the original creation result. The account catalog
is rewritten with each edit. These choices made the first contract easy to
exercise but should not become the keystroke-level editing path.

Candidate storage design:

1. Load a binary snapshot and subsequent changes on activation; retain the
   materialized document while active, with bounded memory/eviction behavior.
2. Append admitted binary Automerge changes and operation receipts in the same
   storage transaction. Advance durable heads and the commit sequence together.
   Publish success/events only after celld's durability boundary; invalidate
   speculative cached state after failed or uncertain persistence.
3. Compact to a snapshot at measured byte/change thresholds. Publish the new
   snapshot before removing only the chunks it includes. Compaction is storage
   maintenance, not history deletion or a new user operation.
4. Keep catalog projections separate from document bytes and avoid rehashing
   untouched blocks. Define freshness/repair if the catalog moves across an
   object boundary; a per-Page Durable Object is a candidate for concurrency
   and sharing, not a transparent substitution for the current account-wide
   transaction.

[AutomergeDocumentStore](../../crates/automerge-store/src/lib.rs) provides a
useful contract for incremental chunks, durable heads, application state, and
compaction. Its standalone SQLite connection should not be transplanted into
celld; implement against the runtime-owned storage boundary. This reference
does not claim that every current notebook persistence path uses that crate.

Celld 0.6.1's storage serializer accepts typed binary values via V8 serialization
and stores them in SQLite. Its replication layer persists SQLite changes to the
configured backing bucket. Avoid adding a second application-level S3/R2 write
path for ordinary edits without a measured need. Attachments, immutable exports,
and archival policies may still need distinct objects. In-memory application
state is never the sole durable authority. See [celld's storage model](https://celld.dev/docs/).

The prototype's 1.5 MiB JSON-expanded record budget is an application guard,
not a measured celld serialization limit. Cloudflare's legacy KV and current
SQLite-backed storage have different [limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
Record actual runtime/version constraints separately from product quotas;
do not preserve old free-plan workarounds or remove real limits by assumption.

### Evidence and next measurement

An initial local probe of a 96-block reference Page applied 50 single-character
appends. Full Automerge saves totaled approximately 1.32 MB, while incremental
changes totaled 10.4 KB. Replaying the changes recovered identical causal heads
and content. This is payload evidence, not a measured latency, cost, or bucket
traffic improvement; increments exclude receipts and checkpoint overhead.
The reference content is not included in this repository.

Run `pnpm --dir apps/pages probe:storage` for a self-contained generated-content
comparison and recovery assertion. Its payloads differ from the reference Page;
random IDs/actors and timings vary. Node V8 serialization sizes are estimates,
not celld wire or SQLite/LTX write measurements.

Before replacing persistence, compare full saves and incremental storage on
actual celld with identical edit/read histories, both warm and cold. Measure
CPU, memory, commit latency, SQLite/LTX bytes, backing-bucket requests/bytes,
and restore time. Include concurrent writers, Unicode, large blocks, history
growth, uncertain acknowledgements, restarts during compaction, and interrupted
recovery. Verify no acknowledged operation or attribution is lost. Compare R2
and S3 only under explicit equivalent durability settings; local dev persistence
does not qualify either remote backend.

## Suggested slices

1. Independently deploy and qualify the current browsing/editing prototype.
2. Introduce stable space identities, inherited Page permissions, and sharing
   with a migration from the initial private workspaces.
3. Establish actor/session identity, scoped API credentials, and durable receipts.
4. Measure and implement incremental persistence with recovery qualification.
5. Add WebSocket subscriptions and change illumination using the shared events.
6. Prototype document-wide WYSIWYG selection and introduce comment operations.
7. Add WebMCP/remote MCP adapters over the established operation contract.

Editor exploration can proceed independently. None of these slices requires
changing notebook-cloud's release cadence or making the first UI expose every
API capability.
