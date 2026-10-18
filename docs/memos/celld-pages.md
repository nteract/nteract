# Standalone Pages on celld

**Status:** Realtime CRDT prototype plus proposed direction, 2026-10-17.
Private Pages implement rich editing, live comments, named presence, transient
change illumination, and scoped agent operations. Sharing and incremental
persistence remain planned.

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
a block map, and comment threads. Blocks contain Markdown or agent instructions plus metadata.
Parser node IDs are rendering details, not persisted block identities.

The HTTP tool API implements a subset of Spaces-shaped reads, guarded edits,
literal patches, idempotency receipts, and sequence-based change reads.
Structural batches are atomic; literal patch batches report partial results.
The browser edits a real Automerge replica through ProseMirror (rich blocks)
or CodeMirror (source blocks) and exchanges
binary sync messages with the workspace over WebSocket. There is no content
polling or explicit save. HTTP tool changes broadcast to the same live replicas.
IndexedDB retains pending changes for reconnect/reopening; durable-head controls
distinguish acknowledged work from local edits. Server handlers use celld's
WebSocket output gate and recheck endpoint sessions before writes and broadcasts.
See the [README](../../apps/pages/README.md#storage-and-identity) for admission,
recovery, and durability limits. This is a Spaces-shaped subset, not a drop-in
Spaces connector. A local stdio MCP adapter and TypeScript SDK expose its guarded
operations. Comments use that same document and sync stream. Execution,
sharing, and offline app loading are absent.

Server-login mode admits endpoint-local sessions and rejects raw provider
tokens, matching notebook-cloud's isolation for a shared OAuth client.
Independent agent credentials are approved through an endpoint session and
bound to one Page, its account, operations, and an expiry. A separate
bearer-only installation requires explicit `PAGES_ALLOW_PROVIDER_BEARER=true`
and must not reuse that shared client. Missing configuration never enables
provider-bearer access, and server-login mode always rejects it.

## Required complete experience

The delivery target is a fully editable realtime document with comments and
space-level sharing, reusing the capabilities already present in notebooks.
The current visual design and private realtime prototype are a starting
point. Realtime editing and comments are required product capabilities, not
optional additions after the document experience is considered complete.

The WYSIWYG editor investigation remains a separate spike starting from main,
with this service as its intended integration target. Editor selection should
not block work on shared-space identity, admitted authorship, comment operations,
and collaboration contracts. Those contracts must also leave room for the
spike's eventual editor transactions and source/selection mapping.

The end-to-end acceptance scenario is two different authenticated people opening
the same shared space and Page in separate browsers:

- Both can type and see the other's edits promptly, without manual refresh or
  explicit whole-block saves. Concurrent edits converge without silently
  replacing one person's text. Remote edits preserve local selection and
  composition; undo does not erase another author's work.
- Both can create anchored comment threads, reply, resolve, and reopen them,
  with updates arriving live. Comments have admitted authorship, remain attached
  through supported edits, and become visibly orphaned when their target is lost.
- Presence and change illumination make collaborators and recent changes
  understandable, while durable authorship remains distinct from transient UI.
- Viewer restrictions and membership revocation apply to reads, mutations,
  comments, and live connections. The first comment-writing policy follows
  content-writing access: owners and editors may participate; viewers read.
- Reconnection and service restart recover committed content and comments
  without losing acknowledged edits, duplicating replies, or replaying old
  edits over newer work. Connection/save status accurately distinguishes local
  work, acknowledged durable work, and failed or uncertain outcomes.
- Browser edits and agent operations affect the same documents, with the same
  permission and attribution rules. A scoped-agent transport is qualified
  separately; the absence of that adapter must not create a second document.

WebSocket delivery of saved snapshots alone does not satisfy concurrent editing.
The browser now uses admitted Automerge sync to preserve concurrent intent.
Keep guarded HTTP tool edits as an
adapter over the same document authority. Full offline editing is a separate
capability from safely reconnecting an interrupted live editing session.

Integrate and verify the complete flow locally before updating the live service:
shared space, two editors, one viewer, concurrent typing, threaded comments,
revocation, reconnect, and restart. WYSIWYG interaction and cross-block selection
join that same fixture when the editor spike selects an approach. The deployed
prototype does not meet this completion bar yet.

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
Comments inherit space access. Owners and editors may create/reply/resolve/reopen
threads; viewers may read them. A commenter-only role can be considered later.

Apply the same authorization to space discovery, Page reads and mutations,
change history, comments, subscriptions, and tool transports. Resolve
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
boundaries should not force isolated editor instances. The current CodeMirror source interface
is a prototype, not the target editing architecture; editor choice and visual
design remain open. Markdown need not remain canonical editable state: Kyle
clarified in the editor thread that Markdown at export is acceptable. Evaluate
a rich Automerge model and its binding independently from the Rust parser and
renderer capabilities shared with notebooks. Adoption requires an explicit
migration of existing content, tool projections, and comment anchors.

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
| WebSocket | Binary Automerge sync, durable-head acknowledgments, comments and presence for browsers; sequence-based semantic events for agents |
| TypeScript / stdio MCP | Guarded reads, edits and comments, plus live Page resource subscriptions |
| WebMCP | Tools exposed by the signed-in page, calling the same operation client as the UI |

WebMCP exposes browser-side JavaScript tools; it is not a backend sync protocol.
The [current draft](https://webmachinelearning.github.io/webmcp/) uses
`document.modelContext`; isolate feature detection and lifecycle handling in
the adapter. Browser execution context does not establish a separately verified
agent identity. A remote MCP adapter can be added independently.

For future semantic WebSocket commands, correlate request IDs with the existing idempotency
keys. Emit committed events only after the corresponding persistence boundary.
Resume by sequence, deduplicate replay, and return an explicit resync requirement
when retention is exceeded. Bound queues and disconnect slow consumers with a
recoverable cursor. Presence has a TTL and is not part of durable content history.
Revocation/expiry must terminate or reauthorize subscriptions; browser upgrades
need same-origin checks. Do not place reusable credentials in WebSocket URLs.

The implemented socket protocol carries Automerge sync with actor admission,
document/schema checks, account authorization, and recovery tests. Semantic
operations remain available over HTTP. A socket alone does not authorize
client-supplied changes or provide offline app loading. Shared-space membership
must replace the account-only access boundary before multi-user sharing ships.

## Attribution and illumination

The separate editor workbench can be served as a static research preview from
this deployment without adopting its native rich-text schema. Its two local
replicas and custom presence are an interaction fixture, not the service's
multi-device editor. Keep that boundary explicit while comparing adapters.

Wordgard is another candidate for that comparison. The author's July 2026
[external-model discussion](https://discuss.wordgard.net/t/strongly-referencing-document-positions/19)
describes observing editor updates and applying external changes; his
[Markdown discussion](https://discuss.wordgard.net/t/wordgard-markdown/16)
describes serialization as separate work. These dated comments do not establish
current package availability or an Automerge binding. No Wordgard fixture,
mobile/IME qualification, or drop-in integration is claimed here.

Separate the account authorizing an operation, its human/agent session, and its
operation ID. Bind admitted actor identities to authenticated credentials or a
server-issued session/delegation. Caller-supplied agent names and transport labels
may aid display but cannot prove authorship or grant permissions. Specify the
delegated credential's page/workspace scope, permitted operations, expiry, and
revocation before enabling independent agent writes.

Current Pages history records the authenticated account for a batch. Newly
admitted Automerge actors carry a deterministic account prefix and a random
replica suffix; the server verifies the prefix against the signed-in account,
never the other way around. This authenticates the account, not an independently
verified device, agent, or person behind a suffix. Existing historical actors
remain unknown or batch-level evidence; do not invent historical authorship.

Presence labels now use the display name from the authenticated OIDC session.
The server attaches it to presence frames; client-supplied names are discarded.
The device suffix is a fallback when the provider supplies no name. A receiving
editor briefly underlines inserted text from remote Automerge changes, maps the
range through subsequent edits, and removes it after two seconds. Initial load
and self echoes stay quiet. Marks use received batch actors, not persistent
per-character authorship; deletions do not manufacture an inserted-text range.
Current private-account peers share one color and account name.

Keep the authenticated principal separate from the driver: Kyle Kelley can edit
through mobile, a browser, or ChatGPT acting on his behalf. The API binds
the approved driver to its credential and server-issued change actor. Browser
edits made by an assistant under Kyle's session still show Kyle's name. Driver
context grants no extra permissions. Unknown historical actors remain unknown.

### Scoped agent access

The integration provides a TypeScript client, an optional local stdio MCP
adapter, and a hosted stateless Streamable HTTP endpoint. It does not need a
native Node binding or implement an MCP OAuth authorization server. Browser clients
retain full Automerge replicas; agents express guarded semantic operations
and subscribe to durable changes. Both use the same document mutation layer.

Hosted MCP and the native API accept Anaconda API keys through the existing
notebook-cloud whoami validator. The server chooses viewer/editor scope checks;
caller-supplied scope, account and display-name headers are not authority.
`cloud:read` permits reading and `cloud:write` permits creation, edits and
comments. Keys address the existing issuer-plus-namespaced-subject workspace.
API-key `passport.user_id` and OIDC `sub` must denote the same subject to reach
the same workspace; different subjects are not silently linked by email.
The namespace must match browser configuration. Production key-to-browser
identity equivalence needs a live credential check, beyond generated fixtures.

The hosted endpoint creates a fresh SDK server/transport for each request,
validates Origin when present, bounds request bytes, rejects GET/DELETE, and
returns JSON responses without assigning MCP session IDs. It shares tool
schemas with the JavaScript client and stdio adapter. The pinned SDK 1.29
implements the established stateless HTTP transport; this is not a claim of
support for every newer protocol revision. See the
[SDK transport guidance](https://ts.sdk.modelcontextprotocol.io/server).
Hosted resources are readable but do not advertise subscriptions. Native plugin
clients use the existing authenticated WebSocket events; no content polling is
introduced. A future MCP subscription adapter should follow the current
protocol rather than adding process-local sessions to remember accounts.

An API key is account-wide within this private Pages service. Its driver label
is client-declared, credential-bound attribution, not vendor attestation. Key
validation inherits the existing 60-second cache; revoked keys are rejected on
revalidation, including incoming/outgoing event frames and client heartbeats.
Keys are not persisted by Pages. Browser sign-out and Page-grant revocation do
not revoke provider keys. Future sharing must intersect this authenticated
identity and provider scope with space membership.

For optional narrower delegation, a CLI generates an opaque 256-bit credential and opens an approval request
containing only its SHA-256 hash. The signed-in user approves one existing Page,
read/edit/comment permissions, a client-supplied driver name, and an expiry
(default one hour, maximum eight). D1 stores the hash and grant, bound to the
service origin, OIDC issuer/client, and principal. The raw credential stays in a
new owner-only local file. This bootstrap is service-specific, not a claim of
OAuth or remote-MCP compatibility. A future hosted adapter needs its own
standards-compliant authorization flow.

Authorization runs at HTTP ingress and again inside the serialized workspace
operation. Event sockets recheck scope and expiry on input and before output;
revoking a grant asks the workspace to close invalid subscribers immediately.
Page discovery, creation and cross-Page operations are outside a grant's scope.
Shared-space membership must later further restrict grants, never be bypassed
by them. Sign-out leaves explicitly granted connections active until expiry or
revocation.

Agent operations use a server-only actor namespace disjoint from browser UUID-v4
actors, including before the agent's first edit. An immutable actor-to-driver
registry is persisted beside the document, receipts and sequence. Raw sync cannot
claim those actors or mutate the registry. Receipts and change events carry the
operation ID and authenticated account/approved driver attribution; browsers
receive author mappings before sync frames so recent-edit illumination can
resolve them. The label is user-approved context, not verified vendor identity.

The Node client never automatically retries mutations. Preserve the original
idempotency key after an uncertain outcome, inspect partial patch results, and
reread on stale guards. Its event socket uses an Authorization header, never a
credential in a URL, resumes from the last sequence and stops on revocation.
The server emits an initial catch-up and then only new committed sequences;
ordinary reads must not emit resource updates and create a notification loop.
MCP keeps explicit Page IDs on every tool call and exposes only permitted tools.

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

Live threaded comments are part of the required document experience. Reuse the authored-change model in
[CommentsDoc](../../crates/comments-doc/AGENTS.md): thread/message creators and
resolvers derive from admitted Automerge authorship, not writable author fields.
Keep actor checks at every ingress path, including semantic API operations and
the raw sync path. An actor ID is not authentication by itself.

The implementation uses explicit Page block/range targets, stable thread/message
IDs, replies, resolve/reopen, and author-only message edit/tombstone operations.
It follows the notebook authorship principle without importing Rust notebook/cell
schemas into the Worker. The Spaces-shaped API is a subset: reactions and thread
deletion are explicitly unsupported, and semantic writes retain mandatory sequence
and idempotency guards. Browser composers expose create/reply/resolve/reopen;
message editing/deletion are currently API-only.

Comments live in a map inside each Page document. Content, anchors, and discussion
therefore share causal history, durable heads, a server commit sequence, and the
existing pending-journal recovery. This avoids another synchronization and
persistence boundary while the data model is small. A separate CommentsDoc can be
reconsidered if measured size or access policy requires it; it is not necessary
for the current private prototype.

The admitted actor's account prefix determines authorship. Existing messages and
thread origins cannot be replaced, and raw sync enforces ownership just as HTTP
does. Concurrent body edits preserve Automerge text identity. A message tombstone
hides even a concurrent body edit; history is not purged. Resolve/reopen replaces
an attributed status object, with all conflict alternatives validated and the
Automerge winner projected. Client timestamps are display metadata.

Selection targets store source text object IDs and opaque Automerge cursors,
with the head on the last selected character. Context exposes exclusive UTF-16
offsets and a bounded quote. Deleting the final selected character, deleting the
block, or replacing its source object detaches the thread conservatively; it
stays visible without a guessed reattachment. The HTTP API and source composer
create within-block selections; richer cross-block selection belongs to the editor
integration. These anchors will need migration if rich text becomes canonical.

Old Pages acquire one comments map under the workspace queue before sync,
advancing the commit sequence once while preserving history and receipts.
Protocol v2 requires refreshed clients. The local protocol smoke exercises API
comment pushes, raw CRDT replies, resolution, and reconnect against real celld;
unit tests cover concurrent operations, ownership, migration, and failure/restart.
Shared-space authorization remains required before multi-account collaboration.

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
5. Extend the implemented CRDT editing and reconnect flow with presence and
   change illumination, then qualify it across shared-space permissions.
6. Extend the implemented live comments with shared-space permissions, richer
   editor anchors, and the remaining API/UI operations.
7. Integrate the separate WYSIWYG spike, including cross-block selection and
   undo, into the complete shared editing and commenting fixture.
8. Add WebMCP/remote MCP adapters over the established operation contract.

Editor exploration can proceed independently. None of these slices requires
changing notebook-cloud's release cadence or making the first UI expose every
API capability.
