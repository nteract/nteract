# Native Pages on Durable Objects

A second, isolated Pages prototype using experimental Automerge Repo 3 and
Subduction. It keeps the rich editor, passage comments, cursors, and incoming
change illumination from `apps/pages`, while replacing its custom Automerge sync
protocol and snapshot host. The existing `m.runtimed.run` service is the comparison
baseline. This experiment does not migrate or replace notebook documents.

## Run locally

From the containing `experiment` directory:

```sh
npm run setup
npm test
npm test --workspace @nteract/pages-native-experiment
npm run build --workspace @nteract/pages-native-experiment
npm run dev --workspace @nteract/pages-native-experiment
```

Install `celld` separately. The dev command serves `http://localhost:9894`, with a
local OIDC issuer and persistent state under `pages/dist/.celld`. The local issuer
is restricted to loopback hostnames. It cannot be enabled on a public deployment
by merely copying the dev flag. Build output and local credentials are ignored.

The experiment shares its parent's pinned upstream packages and one Automerge
instance. Its browser and Worker entry points initialize the corresponding
upstream WASM packaging; document objects never cross independent WASM instances.

## Headless local sharing qualification

After `npm run setup`, install the pinned Playwright Chromium browser and run:

```sh
npx playwright install chromium
npm run test:e2e:sharing --workspace @nteract/pages-native-experiment
```

This command builds Pages, starts its own loopback celld 0.6.3 process on an
available port, and tests three separate browser profiles using the real local
OIDC authorization-code/PKCE flow. It covers private defaults, invitations,
viewer/editor permissions, native edits reaching other browsers, reload,
promotion, downgrade, regrant, revocation, and rejected reconnects. The same
trial makes MCP requests with generated API keys, checks that OIDC and API-key
identities agree, exercises edits arriving in the browser, and verifies that
credential scopes and Page roles both constrain access.

The API-key provider response is synthetic: a **test-only Worker entry** replaces
whoami responses for generated keys. The normal API-key validator, MCP handlers,
Page permissions, Durable Objects, and native WebSocket connections still run.
The fixture rejects external fetches and is never imported by the production
entry. This tests our integration boundary; it does not qualify Anaconda's live
key issuance, provider availability, or multi-machine network behavior.

Runtime state and keys live in a temporary directory and are removed when the
command finishes. Existing `dist/.dev.vars` and `dist/.celld` are never reused.
Screenshots, the completed-check report, and celld logs remain under
`pages/test-results/sharing-<timestamp>`; set `PAGES_E2E_OUTPUT` to choose a result
directory, or `CELLD_BIN` to select the runtime executable. `--skip-build` reuses
an already built viewer for local iteration. Install Chromium system dependencies
with `npx playwright install --with-deps chromium` on a fresh Linux runner.

## Wordgard comparison on page4

`page4.runtimed.run`, page5, and page6 select Wordgard with
`PAGES_EDITOR=wordgard`. Earlier targets keep the ProseMirror editor. Both views use the same PageSession, authenticated
Repo/Subduction connections, IndexedDB recovery, MCP operations, comments and
host persistence. The Wordgard binding adapts the native-editor spike at
[rgbkrk/wordgard-automerge](https://github.com/rgbkrk/wordgard-automerge/tree/c9c6ea8fce8d6f598bdd2d2605569c801cd8f81d);
its BSD notice is retained in `viewer/WORDGARD-NOTICE`. The React/RxJS branch at
`1a35b6b` informed the view/session lifecycle. The existing Pages observer APIs
remain the event source; the demo's replicas, localStorage and transport are not
part of the hosted app.

Run the comparison locally with `PAGES_EDITOR=wordgard npm run dev`. Typing
applies native splices; formatting uses marks; structural edits reconcile native
spans. Position maps account for the actual stored block markers, including
implicit paragraphs. Markdown remains the tool/import/export projection, and
ProseMirror still supplies that shared projection for this experiment; it does
not mediate Wordgard keystrokes. Unrelated block changes skip editor projection.
Within a changed block, projection still decodes and diffs the spans; this is not
a demonstrated large-document performance improvement.

Each Pages block has its own continuous Wordgard editor, retaining stable public
IDs and fractional ordering. Cross-Pages-block selections remain future work.
Wordgard tables now use native editable cells, with row and column controls.
Preserved imports offer **Edit table** to convert supported Markdown explicitly;
reading a Page never changes its content. Nonempty Mermaid blocks open as diagrams; **Edit diagram**
opens native code editing and **Preview** returns to the diagram. This view mode
is local to each editor and does not change the shared document. Wordgard handles
incoming composition transactions directly;
real OS IME and mobile-keyboard qualification remain distinct from synthetic
browser coverage. Page4 has its own service, connector and object-storage prefix;
page3 and pages-next stay unchanged for demos and existing MCP users.

## Opening and creating Pages

Each Page has a canonical browser route, `/p/<page_id>`. Navigation pushes browser
history, Back/Forward reopen the corresponding document, and the former
`/?page=<page_id>` links normalize without adding an extra history entry. Direct
links open independently of the account catalog, including the return from OIDC
sign-in. Page choices are ordinary links; the document menu offers Copy link,
and MCP creation/read/list responses include browser URLs. Links retain the
existing account permissions; copying one does not grant access.

New Page allocates its ID and Automerge history in the browser and waits only for
local IndexedDB persistence before opening the editor. The immutable initial
history registers through the authenticated host in the background; subsequent
edits arrive through native sync. Registration retries reuse the same ID,
bootstrap, idempotency key, and server-issued retry token. Token preparation runs
in the background and is persisted before the first registration attempt. Local recovery metadata is scoped by principal,
and concurrent tabs merge their recovery checkpoints. Saved locally does not
claim remote durability: Saved still requires the host receipt. A rejected draft
can be deleted through the host; local tombstones prevent stale tabs from
restoring deleted entries. Opening an existing local replica also
avoids waiting for the network; uncached documents require an authenticated
connection. This does not add a service worker or guarantee offline cold startup
of the application or its authentication flow.

Run `node scripts/navigation-smoke.mjs` against the local fixture to hold server
registration open while editing, navigate Back/Forward, reload a pending draft,
then release registration and verify two-peer sync and stable direct links. It
also covers first-session edits, transient receipt retries, rejected-draft
deletion, account renewal, and deletion while another tab is open.

## Interface boundary

The Pages service is the shared document layer for people and agents. Its own UI
keeps the reading canvas quiet: a compact page bar, a searchable document list,
contextual formatting, and comments beside their passages. Account, document,
and block actions stay available through compact controls and the keyboard.

A harness may add chat, an “ask for changes” action, or an agent sidebar around
this surface. Those controls should use the same guarded operations and
attribution as other clients; they do not need a second document store. Presence,
comments, and edit illumination belong to the document experience. Sharing UI reflects host-enforced permissions; copying a link does not grant access.

The active implementation is PR #4469. The earlier PR #4451 and m.runtimed.run
remain historical comparison material. celld and Cloudflare run the same
application API with separate deployment configuration and data. A host name
is an environment choice, not a separate editor implementation.

## Writing, links, diagrams, and tables

Select text and choose **Comment** in the formatting toolbar, or press
Cmd/Ctrl+Alt+M, to start a discussion anchored to that passage. The comment icon
beside a block starts a block comment. Browser selection across separate Pages
blocks is not yet supported. Click a highlighted passage to reveal its discussion
in the sidebar; click a thread’s quote to return to the passage. Reply drafts stay
with their threads when switching context.

Click a link for **Open link**, **Edit link**, and **Remove link**. Cmd/Ctrl-click
opens its destination directly; Cmd/Ctrl+K edits the current link. Link targets
follow incoming edits and dismiss when the original link disappears. Opening and
editing apply the same URL policy as the rich document, with an additional
protocol check before navigation.

Type three backticks on an empty paragraph, followed by Enter or Space, to make
a code block. A language can follow the backticks, or be chosen from the code
block's language selector. In Wordgard, **Edit diagram** opens the native code
editor and **Preview** returns to the diagram. ProseMirror uses **Source** and
**Preview**. Both switch only the local view. Cmd/Ctrl+Enter
continues in a paragraph after the code block. The source and language remain
Automerge content and round-trip through Markdown. The preview reuses nteract's
Mermaid renderer and SVG sanitizer, with its existing source and output limits;
rendered SVG is never stored in the document. This does not add code execution.

Markdown tables now import as native table, row, and cell markers in the same
Automerge `richText` field as prose. Wordgard edits cell text and marks directly;
row and column operations reconcile structural spans through the existing
binding. No separately mutable table state or Markdown source editor is added.
The first row is the header. Formatting, links, comments, presence, attribution,
undo, and surgical agent edits use the same paths as ordinary text.

Use the toolbar's **Insert table** control to choose dimensions, or **Table
options** while in a cell to insert/delete rows and columns. Tab and Shift+Tab
move between cells; Tab from the last cell appends a row. Cells wrap on narrow
screens. Column resizing/moving and merged cells remain outside this first pass.
Existing preserved table blocks keep their exact source until **Edit table**
converts supported Markdown through an undoable editor transaction. Unsupported
syntax stays preserved; there is no automatic document migration.

`npm run smoke:tables` exercises two-peer cell editing/formatting, structural
operations, undo, agent patches, reload, and desktop/mobile layout against the
local OIDC fixture. `node scripts/table-smoke.mjs` remains the earlier preserved
preview qualification; it is not the native editable-table test.

For agents, `patch_page` accepts `replace_match` to replace exactly one literal
visible-text range, with optional context to disambiguate it. This preserves
untouched character identities, marks, and comment anchors. Replacement text
retains marks shared across the entire matched range; partial formatting does not
spread to the new text. The existing
Markdown patch operation remains available for syntax and structural changes.
Tool calls are attributed atomic edits; they do not simulate a typing cursor.
Regex replacement remains deferred until Pages has a bounded executor.

`node scripts/authoring-smoke.mjs` exercises selection comments, link opening and
editing, targeted tool edits, and synchronized code/diagram source in two local
browser sessions, with reload and narrow-viewport checks.
`node scripts/link-click-smoke.mjs` separately checks native link activation in
editable and read-only ProseMirror views. The existing
`node scripts/editor-smoke.mjs` covers the broader editor and recovery flows.

## What owns what

```text
Browser Repo + ProseMirror                  Hosted MCP / HTTP operations
         |                                           |
         | native authenticated binary WebSocket    | verified credential
         +----------------------+--------------------+
                                |
                        One Page Durable Object
                        OIDC/API-key admission
                        persistent key/account bindings
                        Repo + Subduction backend
                                |
                        DurableByteStore (ctx.storage)
                                |
                        celld SQLite/LTX + fleet bucket
                                |
                              S3 or R2
```

A separate Catalog object indexes the account's Pages. D1 stores the existing
server OIDC sessions. Page ownership, signing-key bindings, credential leases,
and deletion are host state outside the CRDT. The document contains the title,
ordered rich-text blocks, comments, and any additional application fields.

Block membership lives in a map keyed by stable block ID. Each block has an
atomic Automerge `RawString` fractional `position`; views sort by position, then
by block ID using case-sensitive comparison. This follows NotebookDoc’s model,
using the maintained JavaScript `fractional-indexing` generator rather than its
hex encoding. A move updates a position without recreating the block or its
rich-text object, so comments and selections retain their anchors. Concurrent
inserts may share a position; IDs break ties deterministically. Inserting inside
a tied group opens a gap by advancing only the ties to its right. There is no
separate ordering list or global renumbering.

The byte-store adapter delegates record persistence to `ctx.storage`. It does
not manage an independent SQLite connection, upload Automerge snapshots on each
edit, or implement object-store manifests. On celld, the runtime owns replication and recovery. Cloudflare provides the
same persistence boundary through SQLite Durable Objects.
A fleet backed by R2 uses the same application boundary. Direct R2 bindings are
available for independent blobs or exports; duplicating the live records there
would add another persistence authority.

Relevant celld contracts:
[Durable Objects](https://celld.dev/docs/services/durable-objects/),
[durability guarantees](https://celld.dev/docs/guarantees/),
[R2 bindings](https://celld.dev/docs/services/r2/), and
[WASM modules](https://celld.dev/docs/wasm/). Local celld storage tests do not
establish cloud bucket durability, failover behavior, or lower operating cost.

## Page3: live updates and background persistence

The page3 deployment sets `PAGES_ASYNC_PERSISTENCE=true` for newly created Pages.
Each Page records its storage mode at creation; changing the deployment flag
never silently moves an existing document to another store. The pages-next
profile keeps its existing storage mode and deployment.

In this mode, the live Page holds a bounded record replica in memory. Native
record saves update that replica immediately, allowing synchronization and
presence to continue. A separate `PageRecords` Durable Object receives binary
record batches in the background, normally after one second, or when a caller
requests a durability receipt. Its SQLite/bucket output gate belongs to that
object, so its uploads do not hold ordinary outgoing edits on the live Page.
No runtime durability gate is disabled.

`/api/saved` flushes the Repo, native backend, and captured record batches and
waits for the persistence object's durable response before acknowledging heads.
API mutation receipts retain their stronger durability requirement. A failed
batch is retained beneath any newer local values and retried; partial writes
are idempotent. Storage capacity failures reject new writes rather than evicting
unpersisted history or claiming it was saved. A crashed live Page recovers the
last persisted records; browser replicas retain and resynchronize newer history.
Locally accepted or remotely visible edits are not a remote durability receipt.
The browser bounds each remote receipt request at 30 seconds; a lost response
retains the pending state and uses the existing retry path. Persistence itself
continues under the host's ordered queue. A hung internal persistence call still
requires diagnosis or host recovery; client timeout is not cancellation of that
write and must never allow reordered writes to replace newer values.

Buffered Pages require this build or a later compatible build. Rollback must
retain the PageRecords binding and buffered storage implementation; older builds
cannot read that separate record store.

Account admission, signing-key bindings, deletion tombstones, and API operation
intents remain durable control state on the live Page. Joining a new peer or an
API mutation can therefore still encounter its output gate. This isolates the
steady browser-edit path; it does not promise every operation is independent of
cloud storage latency. Cold application startup also still requires application
assets and authentication when neither is cached.

The pinned Repo adapter additionally keeps a validated, exclusively owned record
index instead of scanning every historical record for each write. It validates
storage on first access and after ambiguous failures; count/size limits and
same-key conflict checks remain enforced. Failed opens surface their error
while native cleanup retains ownership of its local identity until it finishes.

To exercise this mode locally:

```sh
PAGES_ASYNC_PERSISTENCE=true npm run dev --workspace @nteract/pages-native-experiment
# In pages/, against that local server:
node scripts/latency-smoke.mjs
```

The smoke records cold load and two-tab typing before and after adding 500
independent history records without growing the document body. Local results do
not establish bucket/failover performance; qualify the deployed target separately.

## Authentication and collaboration

The existing cloud OIDC flow authenticates browser sessions; the existing
Anaconda provider verifies API keys and their capability bounds. Configure both
principal namespaces explicitly when those credentials represent the same
Anaconda account. A driver label describes the authenticated client; it does not
prove a particular application vendor or grant permissions.

The native handshake proves possession of the peer signing key. Before adding
that connection to the backend, the host binds its verified peer ID to the
credential-authenticated account and driver. Native storage and ephemeral
policies enforce access; UI read-only state is not the security boundary.

The browser renews its OIDC session while the app is open and when returning to
the tab. Native connections have bounded credential leases: API-key connections
reconnect after 60 seconds, and browser connections at the expiry observed on
upgrade. Reauthentication checks during that lease can revoke access early;
they do not extend the socket lifetime. Reconnect obtains current credentials
and resumes the same native document. This keeps lease handling explicit, at the
cost of periodic reconnects for programmatic native clients.

The resident socket holds its admission request context through disconnection.
Native callbacks retain that context for later authentication and storage I/O;
finishing it immediately after admission can strand those operations on celld.
Disconnect and admission failures release the context along with the existing
lease timers and credential binding.

Active requestor admission is separate from durable authorship admission. A live
writer may relay history signed by a previously admitted writer for this Page,
even after that author's session expired. Reader keys cannot acquire writer
provenance by claiming a different role. The host retains the account/key binding
across restart. Native signer provenance does not authenticate arbitrary actor
strings inside imported Automerge history.

Presence receives account and driver labels from the host's signed profile
projection. Change illumination is a batch-level visual cue. Comment labels
are editable document content, not a separate audit log. Pages start private;
per-Page owner/editor/viewer access is host-owned. Space inheritance and author-only
comment editing are not implemented. Neither document fields nor comments can grant access.

### Per-Page sharing

The Page Durable Object owns an ACL in its host metadata, outside Automerge. Its
immutable owner manages access and deletion; editors write and comment; viewers
read. Effective permission intersects the grant with the credential's read/write
scope on every HTTP, MCP, native record, and presence admission. The shared
`SharingPanel` also renders notebook-cloud and Elements; each host supplies its
own authenticated controller and presentation primitives.

Email invitations expire after seven days and are accepted when the recipient
opens the Page. The invitation uses the configured provider namespace plus verified
email proof from nteract OIDC (or the verified API-key identity). It becomes a
stable principal grant. API-key email admission inherits notebook cloud's explicit
trust contract: the authenticated Anaconda whoami endpoint supplies server-verified
account email. Client headers cannot supply this proof. The service does not send email. A pending invite never
authorizes a socket, and an older invite cannot override a newer explicit role
change. There is no anonymous/public sharing or separate commenter role in this pass.

`GET /api/access?page=UUID` returns effective access and, for owners, the member and
invite ledger. Owner writes POST `action`, `expected_revision`, and `idempotency_key`.
The ACL and its bounded retry receipt are one host record; permission increases
stay hidden until its durability barrier, while reductions apply immediately.
Shared catalog references use their own namespace and are checked before exposing
even a title. They do not consume the owner's creation quota.

Every principal grant has a generation. Downgrade/removal retires its native writer
keys and disconnects affected peers; granting access again cannot revive those keys.
Existing admitted history remains readable from the host. A browser changes signing
identity with the grant generation and credential write class. Dirty replicas are
paused for a downloadable local draft; reopening uses server history rather than
silently re-signing rejected offline edits. Revocation cannot erase a copy that was
already downloaded. Browser auth refresh alone never grants document access.

The prototype caps active members and live invitations at 100 each. It retains
the latest 256 sharing receipts; older retries fail their revision check rather
than reapplying, and the window never prevents revocation. Expired invites are
pruned during sharing changes. Native connections are capped at four per principal
and 24 per Page, with four slots reserved for the owner. Durable signing bindings
are capped at 32 per non-owner and 256 per Page, reserving 32 for the owner. These
are lifetime key limits in this prototype: retired/reader bindings remain recorded
to prevent them from regaining write authority. Existing keys can reconnect.
Presence rosters include only current live peers. API permission failures are distinct from
expired sign-in. `scripts/sharing-smoke.mjs` exercises three distinct local OIDC
accounts, native collaboration, downgrade, removal, and the sharing panel.

## Durability and retries

Local Repo mutation promises mean local history is recoverable. A browser displays
Saved only after a request containing its heads has reached the host, the host
has flushed the Repo/backend, and `ctx.storage.sync()` has confirmed celld's
configured durability. Native peer heads alone are not that receipt. Receipts
are requested after edit bursts or reconnect, not by polling document content.
Transient receipt failures get three bounded retries; authentication failures
pause until the account is renewed. A missing-heads receipt requests native
synchronization on the existing connection within that same retry budget. This
catch-up request does not itself mark the document Saved.

Browser storage belongs to one live backend. Each tab uses its own signing key
and IndexedDB database, with Web Locks preventing duplicated tabs from sharing
an active database. Reload in the same tab can reuse that identity. An
account-scoped IndexedDB catalog checkpoints each Page snapshot and immutable
registration request, so another tab can recover pending work using its own
native backend. Concurrent checkpoints merge Automerge history atomically.
Browser storage eviction remains outside this prototype's guarantee.

API mutations require the exact `base_heads` from `read_page` and an
`idempotency_key`. Read again after a stale-head rejection. Retry an uncertain
request with the identical key and payload. The host records a bounded write
intent with encoded incremental changes, so replay applies the same CRDT change
IDs rather than repeating the semantic operation. It first flushes the captured
causal base, including newly received native edits, so a durable intent cannot
outlive the history needed to replay it. Its exact records are reserved through
that same native storage writer, so browser ingress cannot spend promised capacity.
Ambiguous intent writes keep the original bytes for live retries as well as restart.

`read_page` issues a principal/Page-bound `retry_token`; `list_pages` issues the
catalog token for create/delete. Each result includes `retry_key_prefix`, which
binds the key to its token. Append a UUID to that prefix for new work and retain
the exact token/key/payload on retry. Tokens last seven days. A durable monotonic
clock floor precedes completed-receipt collection; expired requests return
`410 retry_expired` without executing, even if their old receipt was removed.
Pending intents never expire and may resume with their original request. A client
must reconcile an expired outcome before deliberately submitting a new operation.
The reserved `v1_` prefix prevents stripping a token to retry as a legacy request;
the token hash in the key prevents replacing an expired token with a fresh one.
Reads do not collect receipts or advance the retirement clock.

The versioned journal bounds its active window at 1,000 entries/8 MiB and pending
work at 64 entries/4 MiB. A full window applies explicit backpressure; collection
removes expired completed receipts rather than ending a document's API lifetime.
Legacy unversioned receipts remain exact-replayable, with their separate 1,000
entry cap. Browser edits do not consume the API receipt budget. Catalog deletion
tombstones remain permanent; this is not arbitrary history or tombstone GC.

## API

Public `GET /llms.txt` (also `HEAD`) explains API-key authentication, driver
attribution, MCP discovery, and guarded Markdown edits. The initial HTML links
the guide so agents can discover it without running JavaScript. Guide URLs use
the configured public origin; no account or document data is included.

- `POST /api/tools` with `{operation, arguments}` provides list/create/read,
  structural edits, literal Markdown patches, comments, and deletion.
- `POST /mcp` exposes the same authorized operations through Streamable HTTP MCP.
  Use `Authorization: Bearer <Anaconda API key>` and optionally
  `X-Pages-Driver: ChatGPT` (or another driver label).
- `GET /api/connect?page=<id>` returns the native document ID, host peer ID,
  authenticated identity, and capability projection.
- `GET /api/sync?page=<id>` upgrades to the native Subduction binary protocol.
- `POST /api/saved?page=<id>` accepts `{heads}` and returns a durable frontier.

`edit_page` supports `insert_markdown` and `move_block` with `after_block_id`:
use a stable block ID to insert after it, `null` to put the block first, or omit
the field to append. Position keys are an internal storage detail.

The Markdown tool interface resembles Pages operations, but this is not an
implementation of the full ChatGPT Spaces API. Structural validation applies to
the operations being invoked; there is no global schema rewrite on native sync.
Applications must diagnose malformed known fields without using a narrower
projection to overwrite unknown content.

## Qualification boundaries

This prototype uses resident WebSockets. Restart closes connections and clients
reconstruct native sessions. Hibernation with native-session reconstruction and
cross-host ownership transfer need separate tests. The native transport limits
frames and queued bytes, and the prototype bounds pages, signing-key bindings,
and live peers. These are explicit experiment limits, not plan-based assumptions.

The document canvas keeps navigation and account actions outside the writing
area. A searchable Pages dialog replaces the horizontal page list. Lucide
formatting controls derive their pressed state and availability from the current
ProseMirror selection and stored marks, including keyboard shortcuts before the
next character is typed. Alt-F10 enters the toolbar, Left/Right moves among its
controls, and Escape returns to the editor. The style select keeps native
Up/Down navigation.

Comments use a desktop rail and a modal sheet at widths up to 900px. Drafts
capture the block's object identity and Automerge text cursors; submission
resolves that passage again and rejects deleted/replaced anchors. A duplicate
phrase inserted earlier in the document cannot retarget the draft. Reply text
survives responsive panel changes, and changing pages clears local drafts.

Enter creates paragraphs and list items within a block. Cross-block selection and full mobile/IME qualification
remain separate editor work. Incoming editor notifications are deferred during
composition; native receive itself is not paused.

The pinned `@automerge/prosemirror` 0.2 binding can reject an intermediate list
structure while projecting a valid tool replacement. The editor recovers that
pre-dispatch failure by validating the final CRDT projection and replacing only
its differing editor range. This preserves the mounted editor, maps selection
and history, and never writes the projection back as another CRDT edit. Invalid
final content and errors from editor dispatch still propagate.

Unexpected HTTP failures and failed native admission emit structured diagnostic
categories with the request boundary, status, and error type. Provider error
messages, credentials, request bodies, and document content are excluded.

The maintained application boundary, persistence requests/bytes, memory, cold
restore latency, and durable-receipt latency should be compared with `apps/pages`
using the same workload. Fewer lines or smaller incremental records alone do
not establish lower S3/R2 request cost or faster recovery.

## Runtime compatibility found by this prototype

On celld 0.6.1, `cbor-x` 1.6.4 detects the global Buffer shim and attempts to
construct `Buffer.allocUnsafeSlow`. That shim's function is not constructable.
The native storage/sync probe passes without ephemeral messages, so testing
actual presence was necessary to uncover this failure. `scripts/celld-cbor.mjs`
selects the encoder's existing Uint8Array path for the Worker bundle only. It
checks the expected source declaration and fails the build if that dependency
changes. It does not replace global Buffer or modify installed dependencies.
The regression test covers Unicode, binary data, and growth beyond the initial
8 KiB encoding buffer. The browser keeps upstream's normal packaging.

On current workerd, accepted WebSockets default to Blob delivery. The byte
transport explicitly requests ArrayBuffer delivery before installing listeners;
otherwise the native handshake cannot decode incoming frames.

SQLite Durable Objects limit a stored key and value to 2 MB. Subduction encodes
native records as hex inside its storage frame, so the shared browser/host limit
is 900 KiB per record, with a 1,900,000-byte guard on the stored frame plus key.
Aggregate document history remains bounded at 16 MiB. API operations validate
derived records and retry intents before persisting them, so an oversized
individual record or intent returns 413 before that intent is recorded. These
limits also apply on celld to keep both deployments compatible.

The adapter now reserves exact record identities at the writer shared with
native ingress before durably recording an API intent. Admission charges stored
records plus reservations once and preserves partial-write retries. Recovery
validates all pending changes on a clone before changing the serving handle.
An older over-capacity intent leaves accepted history readable with an explicit
recovery-blocked state; HTTP and native writes are denied while the intent remains
available. It is not silently discarded, completed, or rebuilt from JSON.

Buffered storage acquires a durable generation lease before loading its record
snapshot. Record writes from a superseded live Page are rejected, so a late
pre-crash batch cannot alter the restored admission budget. Tests cover the real
16 MiB boundary, native authenticated ingress, local and buffered storage,
partial persistence, ambiguous intent puts, exact retries, and restart. Local
fault injection does not establish power-loss/failover durability of S3 or R2.

## Cloudflare preview deployment

The Cloudflare target is `preview.runt.run`, Worker `nteract-pages-next`, with a
separate D1 database named `nteract-pages-next-auth` and new Page/Catalog SQLite
Durable Object namespaces. It reuses the previous preview's **Anaconda staging**
OIDC client and API-key verifier. Staging credentials are required; a production
Anaconda API key is not interchangeable. The session secret is newly generated.
No dev authentication flag is included.

After committing and rebuilding, prepare a new directory from the explicit
artifact allowlist:

```sh
node pages/scripts/cloudflare-stage.mjs /tmp/pages-cloudflare-release D1_DATABASE_UUID
node_modules/.bin/wrangler deploy --config /tmp/pages-cloudflare-release/wrangler.json --dry-run
node_modules/.bin/wrangler deploy --config /tmp/pages-cloudflare-release/wrangler.json
node_modules/.bin/wrangler secret put NOTEBOOK_CLOUD_APP_SESSION_SECRET --config /tmp/pages-cloudflare-release/wrangler.json
```

The staging helper requires a clean source tree and matching build receipt.
It separates Worker WASM modules from browser assets and excludes local secrets
and databases. It does not attach the domain. Verify the new workers.dev endpoint
first, then update the existing Workers custom domain to service
`nteract-pages-next`. Rollback changes that service back to
`nteract-notebook-cloud`; the old Worker, D1 and R2 resources remain available.
The existing `m.runtimed.run` service is independent.

This deployment does not need an R2 binding for native records: SQLite Durable
Objects already provide durable storage. Independent large blobs or exports can
use R2 later. Live provider login, API-key editing and recovery require separate
verification from local workerd fixtures.

## Isolated lab deployment

The sharing experiment uses explicit `--target page5`. The `page4`, `page3` and
`pages-next` deployments remain frozen for existing users. The historical
default is still `pages-next`, so always pass the intended target.

| Target | Hostname | Service | Listener / internal port | S3 prefix |
| --- | --- | --- | --- | --- |
| `pages-next` (default) | `pages-next.runtimed.run` | `nteract-pages-next` | `9472` / `19472` | `standalone/pages-next` |
| `page3` | `page3.runtimed.run` | `nteract-page3` | `9473` / `19473` | `standalone/page3` |
| `page4` | `page4.runtimed.run` | `nteract-page4` | `9474` / `19474` | `standalone/page4` |
| `page5` | `page5.runtimed.run` | `nteract-page5` | `9475` / `19475` | `standalone/page5` |

All four use lab1, bucket `nteract-celld-lab-621741996708` in `us-east-1`, and the same
production Anaconda OIDC client and API-key verifier. Each has separate `/opt`,
`/etc`, and `/var/lib` directories named after its service, a host-generated
session secret, service account, firewall table/mark, and prepared release stage.
The new profile checks that its ports, prefix, and firewall resources are unused
before creating them. `m.runtimed.run` keeps its existing service and prefix.
These scripts do not move or reuse existing documents or session secrets.

`page3`, `page4`, and `page5` enable `PAGES_ASYNC_PERSISTENCE=true`; all services keep
`CELLD_DURABILITY=bucket`. Page4 and page5 set `PAGES_EDITOR=wordgard`; the other
profiles retain their existing editor configuration. The installer preserves the build's Durable Object
bindings and migrations, including `PAGE_RECORDS`, while supplying the selected
public origin and its OIDC callback.

The default `pages-next` publisher retains its existing shared-tunnel behavior.
Do not publish that target while its users need uninterrupted connections.
`page3` publication uses a **different tunnel and dedicated
`cloudflared-page3.service`**. It neither writes the shared
`/etc/cloudflared/config.yml` nor restarts `cloudflared.service`, and verifies
that the shared configuration and process ID stayed unchanged. Page4 uses its
own `cloudflared-page4.service` and a third tunnel. Its publisher additionally
checks both frozen application PIDs, their service units, and page3's connector
PID/configuration before and after publication. It refuses to reuse either
existing tunnel ID.

`node scripts/deploy.mjs plan` is read-only. After inspecting the current lab1
runtime, ports, prefix, tunnel and firewall ownership, use `prepare`,
`upload LOCAL_STAGE`, `install REMOTE_STAGE --apply`, then
`publish REMOTE_STAGE --apply`. The installer requires the official celld 0.6.3
Linux x86_64 binary at `/usr/local/bin/celld-v0.6.3`, checks its executable SHA256
against `CELLD_RELEASE` in `scripts/deployment/profiles.mjs`, and requires a clean
committed source tree whose fingerprint matches the bundle. Install that version
beside the shared runtime; the deployment never upgrades `/usr/local/bin/celld`
used by other services. Each service runs a private copy. Installation refuses to
replace a newer version or a different build reporting the same version.

Generated service units enable `CELLD_OTEL=1` with `CELLD_OTEL_RETENTION=30d`.
Batching overrides are omitted, retaining celld 0.6.3's five-minute/5 MiB defaults.
Telemetry uses the fleet bucket under its telemetry prefix. The 30-day retention
policy collects older dated partitions; it is not an exact rolling-hour cutoff.
The removed `CELLD_OTEL_SINK` variable must not be set. See the
[pinned telemetry configuration](https://github.com/denoland/celld/blob/8702f6d186c77698dbfb30cf29e3b1922a88f008/docs/telemetry.md).
For runtime-only rollouts, preserve the deployed app, prior versioned executable,
and runtime receipt, and qualify rollback against the on-disk state. This app
installer intentionally refuses runtime downgrades; it also deploys app artifacts
and rewrites the unit. After a runtime rollout, verify health, native collaboration,
and actual Parquet delivery beneath `<fleet-prefix>/telemetry/{traces,logs}`.
A generated unit or successful restart alone does not establish telemetry delivery.
It creates the session secret on the host. Only the explicit release-file
allowlist is staged; local dev credentials and databases are excluded.

For page5, run from this directory after the source is reviewed and committed:

```bash
node scripts/deploy.mjs --target page5 plan
node scripts/deploy.mjs --target page5 prepare
node scripts/deploy.mjs --target page5 upload LOCAL_STAGE
node scripts/deploy.mjs --target page5 install REMOTE_STAGE --apply
node scripts/deploy.mjs --target page5 publish REMOTE_STAGE --apply
```

Prepared manifests and remote stage names must match the selected target;
a stage from another target is rejected. The existing deployment lock still
serializes these operator commands. Page3 and page4 use dedicated publishers;
page4 also refuses the shared route-editing path. Each ingress allows only its public
routes and ends in a catch-all 404. The public routes include `/mcp`, `/llms.txt`,
`/p/<page_id>`, sync, and OIDC; internal Durable Object routes are not exposed.

Before first page4 publication, provision a new locally managed Cloudflare Tunnel named
`nteract-page4` in account `1cfb529b94b3d6cde3aaf49d1d6ed5e6`; this is a separate,
explicit operator action, never performed by `prepare` or `publish`. It requires
Cloudflare Tunnel Edit permission. Store its returned credentials as root-owned
mode 0600 `/etc/nteract-page4/tunnel.json` (`AccountTag`, `TunnelID`,
`TunnelSecret`), and save the nonsecret creation receipt at
`/etc/nteract-page4/tunnel-provisioning.json`:

```json
{
  "schema": 1,
  "account_id": "1cfb529b94b3d6cde3aaf49d1d6ed5e6",
  "tunnel_id": "NEW_TUNNEL_UUID",
  "name": "nteract-page4",
  "config_src": "local"
}
```

Keep these files in a private temporary provisioning directory until `install`
creates the owned `/etc/nteract-page4` directory, then copy only the credentials
and receipt into it. Do not precreate that installation directory.

The publisher rejects either frozen tunnel ID, missing credentials, or an unowned
existing connector configuration. It installs `/etc/nteract-page4/tunnel.yml`
and starts only `cloudflared-page4.service`, resuming partial installs only when
the existing files match exactly. Do not run `cloudflared service install`, which
targets the existing default service. Tunnel credentials never enter the source
checkout or prepared release.

DNS is separate: `scripts/deployment/dns.mjs` takes the verified tunnel UUID and
checks the exact hostname without changes by default. Its `--apply` creates only
an absent, owned CNAME and refuses conflicts. For page4, use
`node scripts/deployment/dns.mjs --target page4 VERIFIED_TUNNEL_UUID` to inspect,
then append `--apply` to create the proxied CNAME pointing to
`VERIFIED_TUNNEL_UUID.cfargotunnel.com`. This requires a Cloudflare API token with
DNS read/edit access to the `runtimed.run` zone in `CLOUDFLARE_API_TOKEN`; the
deploy commands separately require lab1 SSH and sudo access. No OIDC client
secret is copied to the stage. Verify anonymous denial, real OIDC, API-key editing,
WebSockets and bucket recovery after publication. A prepared
script is not evidence that those live checks passed.

Page5 uses a fourth dedicated tunnel, `cloudflared-page5.service`, and its own
`/etc/nteract-page5` provisioning files. Follow the page4 provisioning procedure
with the page5 service name and target. Its publisher also freezes page4's app
and tunnel alongside page3 and pages-next. Copying a document to a newer deployment
is explicit; deployment never migrates or modifies another target's data.

Page6 is the next isolated experiment target. It uses `nteract-page6`, ports
9476/19476, `standalone/page6`, and `cloudflared-page6.service`. Use the same
commands and provisioning procedure with `--target page6` and page6-owned files.
Its publisher freezes page5 as well as page4, page3, and pages-next; the existing
page5 release remains available for demos. Page6 starts with its own empty catalog
and document storage. Public setup and sharing routes are identical to page5,
with no historical ingress-migration allowance.
