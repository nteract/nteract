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

The Share popover offers **Copy as Markdown** to anyone who can read the Page.
It exports the current title and document content, including tables, task lists,
diagram source, and existing private image references. Copying does not publish
the Page or change access to its images.

The account menu offers **System / Light / Dark** appearance using nteract's
shared theme tokens. Preferences belong to the browser and follow other tabs on
the same origin; they never change the Page. The small theme bootstrap runs
before the editor loads so saved dark mode does not start with a light canvas.

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
editor and **Preview** returns to the diagram. Both are compact icon actions in
the upper-right corner, beside **Copy diagram code**; copying is available to
readers too. ProseMirror uses **Source** and
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

Use **Task list** in the toolbar, or type `- [ ] ` / `- [x] ` at the start of a
paragraph, to create a checklist. Click a checkbox or focus it and press Space
to check it off. Enter starts an unchecked item; Enter on an empty item returns
to prose. Checked state lives on the native Automerge list-item marker, so
checkbox changes merge with concurrent text edits without replacing their text
or comment anchors. Undo remains local to the person who made the change.
Read-only Pages display disabled checkboxes. Markdown tools import and export
the same task state, including nested tasks; ordinary bullets stay bullets.

`node scripts/local-sharing-e2e.mjs --task-lists` exercises the Wordgard controls
with two independent local OIDC sessions, concurrent checkbox/text changes,
undo, Markdown shortcuts, reload, and mobile layout. Its read-only UI check
uses a frontend fixture; the shared ACL suite qualifies server enforcement.

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

## Private images

Wordgard's existing image embed remains the document representation. Browser
insertion, screenshot paste, and file drop upload PNG/JPEG/static WebP bytes to
`POST /api/pages/:pageId/assets`, then insert a stable relative reference through
the normal rich-text transaction. Upload state stays local. The insertion target
is a captured CRDT cursor; a deleted/replaced block, disposed editor, or revoked
write permission must not redirect a completed upload into other content.

`PAGES_ASSETS` is a private R2 binding. celld backs it with the fleet's configured
object store, beneath the deployment prefix. Assets are immutable, hash addressed,
and scoped to a Page. Only the reference and alt text enter Automerge; bytes do
not consume its document history budget. The gateway authorizes uploads through
the Page before transferring bytes and again before returning the reference;
blob transfer does not occupy the Page's serialized mutation queue.

`GET`/`HEAD /api/pages/:pageId/assets/:sha256` authorize current Page read access
before storage lookup, then serve verified raster MIME with `nosniff` and
`Cache-Control: private, no-store`. Browser session cookies work with ordinary
image elements. No public bucket, durable presigned URL, or cross-Page hash lookup
is exposed. Revocation prevents later reads but cannot retract downloaded bytes.

Uploads are capped at 5 MiB, 8192 pixels per side, and 25 million pixels.
The host request ceiling is 6 MiB; JSON tool limits remain separately bounded.
SVG, HTML, GIF, animated WebP, and APNG are outside this first image surface.
Container validation is not a full pixel decoder. Identical upload retries reuse
the immutable object. Interrupted or abandoned uploads may leave private orphans;
there is no immediate deletion when an image is removed, since undo and offline
peers may still reference it. Asset retention/garbage collection and cross-Page or
cross-deployment asset copying need a separate lifecycle implementation.

Browser/API-key image transport uses the existing auth and Page ACL. For ChatGPT,
`import_page_image({ page_id, file })` accepts the client's file handoff through
`_meta["openai/fileParams"]: ["file"]`. The file schema declares `download_url`,
`file_id`, `mime_type`, and `file_name`; only the first two are required. The
descriptor must come from the client, not from constructing a URL around a file
ID. See the [OpenAI file-input contract](https://developers.openai.com/plugins/reference#define-file-inputs).

The importer requires the existing `pages:read pages:write` OAuth scopes and Page
edit access. It accepts HTTPS downloads from `files.oaiusercontent.com` only,
rejects redirects, bounds transfer time and size, and reuses the private image
validation/storage path outside the Page mutation queue. Temporary download URLs
are neither document references nor stored asset metadata. The result contains
`asset_id`, `asset_url`, MIME type, dimensions, and byte size. The caller then
reads the current Page and inserts the returned `asset_id` through the guarded
`edit_page` operation `insert_image`. API-key clients can upload raw bytes through
the existing endpoint and use the same operation. Import itself does not change
the document; identical image bytes reuse the same Page-scoped asset.

`insert_image` accepts `asset_id`, `alt`, and optional `after_block_id` (omitted
appends; `null` prepends). It checks that the asset exists in this Page's private
storage and creates a dedicated rich-text block using the existing image embed.
It does not fetch a remote URL or write bytes into the document. The normal
head guard, current write permission, and operation journal apply. Its receipt
returns `result.inserted_images` entries with the actual `block_id`, `asset_id`,
`asset_url`, and `alt`, alongside updated `heads` and the Page `url`. MCP returns
the same receipt as structured content and text. Exact retries reuse the original
block and receipt without reimporting the file, including after its temporary
source URL expires. Read the Page back to verify the inserted block; successful
upload alone is not document insertion.

OAuth tokens remain scoped to `/mcp` and cannot call the raw-image HTTP route.
No additional API key, public bucket, base64 tool argument, or browser widget is
required for ChatGPT file import. Clients must refresh their tool catalog to see
the new operation. Uploaded-file handoff is documented by OpenAI; a newly
generated ChatGPT image still requires a separate live trial to establish that
the client exposes it as a transferable file. The importer does not add an
image-reading tool: do not claim pixel access from a Markdown reference alone.

Run `node scripts/local-sharing-e2e.mjs --images` with the qualified celld binary
for real local object-storage, browser, and permission checks. The `--mcp-images`
variant exercises local OIDC/OAuth, the real MCP SDK and private bucket, byte
upload/import equality, guarded insertion and exact retries, Page isolation,
revocation, source-link expiry, and browser rendering. Only the external ChatGPT
file response is synthetic; actual ChatGPT file handoff and live fleet storage
require separate verification.

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

Pages also acts as an OAuth authorization server for MCP. ChatGPT's fixed client
metadata URL is allowed explicitly; its registered callback, PKCE S256, requested
resource, and scopes are validated before the existing Anaconda browser sign-in
and a separate consent screen. Public client authentication is `none`; dynamic
registration and arbitrary client-metadata fetching are not enabled. Authorization
responses include the issuer (`iss`) so ChatGPT can use its stable callback.
Kilo uses the predefined public client `pages-kilo` and exact loopback callback
`http://127.0.0.1:19876/mcp/oauth/callback`, with the same PKCE and resource checks.
Its configuration requests `pages:read pages:write offline_access`. The initial
401 challenge deliberately omits a scope hint: Kilo otherwise replaces its
configured scopes with that hint, dropping write access. Supported scopes remain
in discovery; insufficient-scope errors still request the required scope.

The SQL database holds session-bound consent requests and hashes of single-use
codes and opaque Pages access/refresh tokens. Access tokens last ten minutes;
newly approved connections include rotating refresh tokens within an absolute
thirty-day grant, explained on the consent screen. Refresh issuance is an OAuth
authorization-server policy, not contingent on the optional `offline_access`
scope. A live ChatGPT grant requesting only `pages:read pages:write` exposed the
previous ten-minute-only behavior. Existing grants and old pending consent/code
records are not silently extended; a new authorization is required. Replaying a correctly
bound authorization code or refresh token revokes its family. No Anaconda
provider token leaves the server.
Token scope and the current Page ACL intersect on every operation. These grants
authorize `/mcp` only: they do not authorize the HTTP sharing API or native sync.
`pages:read` permits reading, and `pages:write` adds creation, editing, comments,
and deletion where the account's Page role permits it. `offline_access` remains
accepted for compatible clients but is not added to required tool scopes.
Token refresh does not renew verified-email invitation or company-domain proof.

`/connect` and `/llms.txt` describe OAuth for ChatGPT and Kilo, plus API-key recipes
for Codex, Kilo fallback, and other bearer-header clients. Migrating Kilo removes
the Pages Authorization header and replaces `oauth: false`; it does not delete
the key file. The generic setup prompt points to
the agent guide. Agents can prepare non-secret settings while the human completes
authorization; a successful `list_pages` call is the connection check.

The native handshake proves possession of the peer signing key. Before adding
that connection to the backend, the host binds its verified peer ID to the
credential-authenticated account and driver. Native storage and ephemeral
policies enforce access; UI read-only state is not the security boundary.

The browser renews its OIDC session while the app is open and when returning to
the tab. Its native socket keeps the absolute expiry observed on upgrade, then
reconnects with current credentials. API-key sockets instead renew their
60-second leases after successful periodic reauthentication. Renewal preserves
the account, namespace, driver, credential write scope, and Page grant generation;
it cannot upgrade a durable signing-key binding. It updates only the live lease
and its disconnect timer, without a storage write.

The last confirmed expiry stays armed while verification is pending. Failure,
expiry, disconnect, or a changed Page grant prevents a late verification result
from reviving the connection. Connection checks are scheduled every 15 seconds while the
socket is active, but the shared Anaconda verifier may reuse its 60-second
userinfo cache; provider revocation is therefore not instantaneous. Browser
session expiry and Page ACL enforcement remain independent of API-key renewal.

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

An owner can optionally enable company-domain viewing by link, independently of
their own email address. The deployment must enable `PAGES_COMPANY_VIEW_DOMAINS`;
this experiment only recognizes `anaconda.com`. The UI offers Restricted or the
approved company audience, never a free-form domain or a consumer email provider.
Page7 exposes the option but existing Pages remain Restricted. This grants read
access only, never editing, sharing management, or implicit company membership.
Individual editor invitations continue to work; an explicit revoked member stays
denied even when their domain is allowed.

Domain admission requires provider-bound, verified email evidence. Browser sessions
and OAuth grants retain a domain-separated HMAC proof with the original verification
time; refreshing an OAuth token does not refresh that proof. Domain-only access
expires after six hours without fresh identity verification, including active
native sockets. API-key identities use the provider's verified email contract.
Removing the audience or disabling it in deployment configuration revokes fallback
access without turning domain viewers into permanent members. Ownership transfer
is unnecessary and remains unsupported.

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

Tool reads can select blocks, an exact heading section (with an occurrence for
duplicates), literal search hits with neighboring top-level nodes, or a revision-bound
node range inside one rich-text block. `include_content:false` returns a paginated
outline. Partial slices are marked explicitly and are suitable for `replace_match`,
not whole-block replacement. Explicit `comments` modes omit raw anchor internals;
`list_page_comments` filters threads without reading the body. The original
`read_page({page_id})` response remains compatible and unbounded for cached clients.
Successful reads capture content and heads once and return the existing retry authority.
Explicit read options use a 128 KiB default response budget (caller-adjustable from
4–256 KiB). Outline pages shrink to fit; oversized content gets an actionable outline;
it never silently truncates document content. These are read projections only and
do not change CRDT state, comment anchors, mutation guards or journal receipts.

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

Public `GET /llms.txt` (also `HEAD`) explains OAuth and API-key authentication, driver
attribution, MCP discovery, and guarded Markdown edits. The initial HTML links
the guide so agents can discover it without running JavaScript. Guide URLs use
the configured public origin; no account or document data is included.

- `POST /api/tools` with `{operation, arguments}` provides list/create/read,
  structural edits, literal Markdown patches, comments, and deletion.
- `POST /mcp` exposes the same authorized operations through Streamable HTTP MCP.
  Use `Authorization: Bearer <Pages OAuth access token or Anaconda API key>` and optionally
  `X-Pages-Driver: ChatGPT` (or another driver label).
- `GET /api/connect?page=<id>` returns the native document ID, host peer ID,
  authenticated identity, and capability projection.
- `GET /api/sync?page=<id>` upgrades to the native Subduction binary protocol.
- `POST /api/saved?page=<id>` accepts `{heads}` and returns a durable frontier.
- OAuth discovery is public at `/.well-known/oauth-protected-resource/mcp`
  (also the root resource-metadata path) and `/.well-known/oauth-authorization-server`.
  `/oauth/authorize` handles sign-in and consent; `/oauth/token` exchanges codes
  or refresh tokens; `/oauth/revoke` revokes the supplied credential's grant.
  These endpoints are published only on Page7's isolated tunnel. Earlier target
  route definitions remain byte-identical.

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

## Page7: binary persistence and conservative cleanup

Page7 keeps the same authenticated document, WebSocket, and durability boundaries.
It writes versioned binary records instead of hex inside JSON; existing hex
records remain readable. Signed native envelopes and Automerge changes are
preserved byte for byte. This changes storage encoding, not CRDT identities or
history retention. The isolated profile uses `standalone/page7` and leaves
all earlier deployments and their records unchanged.

The native dependency is uniformly pinned to published Subduction 0.26.0. Our
0.23.0 control reproduces an upstream graph-minimization bug: a cold peer can
miss required changes after mixed-author branches. The published fix repairs
that traversal. The regression requires automatic convergence from an empty
peer, not just a successful handshake or the first ready Repo handle. See
[the exact upstream provenance](../UPSTREAM.md).

Only page7 enables `PAGES_COMPACT_RECORDS=true`. After successful background
persistence, at least 64 record writes and 256 KiB of record bytes can schedule
one cleanup attempt, with at least 60 seconds between attempts. These are
initial scheduling thresholds, not document limits. Cleanup removes a record
only when native minimization omits it and a retained fragment demonstrably
contains all its changes. The covering fragment must be durable before any
removal. No history is erased, and an offline peer retains its merge history.

The native writer is released while cleanup waits for remote durability.
Foreground Saved requests do not trigger cleanup, although backend queue order
can put a request behind an already-running attempt. Reservations prevent
cleanup while an API operation needs exact records for recovery. Failures retain
retryable state; no timer keeps scanning an idle document.

The independent fixtures distinguish encoding savings from cleanup savings.
For the deterministic 320-round prose history, binary values occupy 191,950
bytes versus 395,972 bytes with hex framing. With native 0.26.0, cleanup removes
only nine records, leaving 184,642 bytes. The 18 MiB high-entropy typed-history
stress still retains roughly 19.1 MB after cleanup: genuine historical content
cannot be removed by lossless packing. These are local adapter measurements,
not object-store request bills or Cloudflare memory qualification.

`persistence-*.test.mjs` checks cold sync, dormant-peer merges, interrupted
publication/deletion, concurrent edits and presence during blocked durability,
and explicit corruption failure. `persistence-benchmark.mjs` supports fresh
process reopen measurements and a test-only history budget. That budget does
not change the application's limits. Real runtime and live deployment checks
remain separate evidence.

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

The host byte transport allows messages up to 32 MiB, matching
[Cloudflare's message ceiling](https://developers.cloudflare.com/workers/runtime-apis/websockets/).
Native Subduction currently encodes a whole cold-sync response in one message,
including signed-record and protocol overhead; the earlier 4 MiB guard could
reject documents within the 16 MiB history budget. The receive queue is bounded
at 32 MiB and 256 messages. On sockets exposing `bufferedAmount`, outgoing
admission includes both the already queued bytes and the next frame in the
32 MiB budget. celld/workerd server sockets may not expose that counter, so their
runtime owns the unobservable outgoing queue; only the individual message bound
is enforced there. The production viewer uses native `SubductionWebSocket`
directly, so its queue is outside this wrapper's accounting.

These per-connection guards do not bound decoded native/WASM state, temporary
message copies, the number of connections, or total isolate memory. Local celld
qualification covers the measured 19,054,445-byte response and subsequent edits
and presence. It does not qualify Cloudflare memory use or a larger document
budget. The aggregate history limit remains 16 MiB; larger histories still need
separate resource qualification and upstream bounded sync responses.

SQLite Durable Objects limit a stored key and value to 2 MB. The shared
browser/host limit remains 900 KiB per record, with a 1,900,000-byte guard on the
stored frame plus key. The record limit originally allowed for legacy hex
framing; binary encoding alone does not qualify a larger native record or
runtime memory budget. Aggregate document history remains bounded at 16 MiB.
API operations validate
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

Native records use SQLite Durable Objects. Images use the separate private R2
bucket `nteract-pages-images`; create it before deploying this configuration.
The celld target uses `pages-images` beneath its isolated fleet prefix instead.
Live provider login, API-key editing and recovery require separate verification
from local workerd fixtures.

## Isolated lab deployment

This persistence build is qualified for explicit `--target page7`. Earlier
profiles remain available for inspection; mutating deployment commands reject
those targets. Binary v2 records require the new reader, so rolling an updated
store back to a legacy hex-only build is unsupported. New page7 storage avoids
migrating any demo or existing user's document.

| Target | Hostname | Service | Listener / internal port | S3 prefix |
| --- | --- | --- | --- | --- |
| `pages-next` (frozen) | `pages-next.runtimed.run` | `nteract-pages-next` | `9472` / `19472` | `standalone/pages-next` |
| `page3` (frozen) | `page3.runtimed.run` | `nteract-page3` | `9473` / `19473` | `standalone/page3` |
| `page4` (frozen) | `page4.runtimed.run` | `nteract-page4` | `9474` / `19474` | `standalone/page4` |
| `page5` (frozen) | `page5.runtimed.run` | `nteract-page5` | `9475` / `19475` | `standalone/page5` |
| `page6` (frozen) | `page6.runtimed.run` | `nteract-page6` | `9476` / `19476` | `standalone/page6` |
| `page7` | `page7.runtimed.run` | `nteract-page7` | `9477` / `19477` | `standalone/page7` |

These targets use lab1, bucket `nteract-celld-lab-621741996708` in `us-east-1`,
and production Anaconda OIDC/API-key verification. Each owns its service,
`/opt`, `/etc`, and `/var/lib` directories, session secret, service account,
firewall table/mark, and release stage. Page7's mark is `0x01000000`. Its profile
checks that resources are unused before creating them. It uses Wordgard,
buffered record persistence and opt-in cleanup, retaining `CELLD_DURABILITY=bucket`.
The installer preserves the build's Durable Object bindings and migrations.

From this directory, after review and commit:

```bash
node scripts/deploy.mjs --target page7 plan
node scripts/deploy.mjs --target page7 prepare
node scripts/deploy.mjs --target page7 upload LOCAL_STAGE
node scripts/deploy.mjs --target page7 install REMOTE_STAGE --apply
node scripts/deploy.mjs --target page7 publish REMOTE_STAGE --apply
```

`plan` is read-only. Use only returned stage paths. Prepared manifests and remote
stages must match the selected target. The deployment lock serializes operator
commands. Preparation requires clean committed source and a matching bundle
fingerprint. Only allowlisted release files are staged; dev credentials and
local databases are excluded.

The installer requires the official celld 0.6.3 Linux x86_64 executable at
`/usr/local/bin/celld-v0.6.3`, matching `CELLD_RELEASE` in
`scripts/deployment/profiles.mjs`. Each service runs its own copy; deployment
does not change the shared executable. It refuses newer-runtime downgrades and
same-version custom-build replacement. Session secrets are generated on the host.

Service units enable `CELLD_OTEL=1` and `CELLD_OTEL_RETENTION=30d`, using celld's
five-minute/5 MiB batching defaults. Verify actual Parquet delivery beneath
`<fleet-prefix>/telemetry/{traces,logs}`; configuration alone is not evidence of
delivery. Retention collects dated partitions rather than enforcing an exact
rolling-hour cutoff. See the [pinned telemetry contract](https://github.com/denoland/celld/blob/8702f6d186c77698dbfb30cf29e3b1922a88f008/docs/telemetry.md).

Before first publication, provision a separate locally managed Cloudflare Tunnel
named `nteract-page7` in account `1cfb529b94b3d6cde3aaf49d1d6ed5e6`. This explicit
operator action requires Tunnel Edit permission and is not performed by
`prepare` or `publish`. After installation creates the owned directory, place
credentials (`AccountTag`, `TunnelID`, `TunnelSecret`) in root-owned mode 0600
`/etc/nteract-page7/tunnel.json`. Save this nonsecret creation receipt in
`/etc/nteract-page7/tunnel-provisioning.json`:

```json
{
  "schema": 1,
  "account_id": "1cfb529b94b3d6cde3aaf49d1d6ed5e6",
  "tunnel_id": "NEW_TUNNEL_UUID",
  "name": "nteract-page7",
  "config_src": "local"
}
```

Keep provisioning files private and outside the release artifact. Do not
precreate the installation directory. Publication rejects a reused tunnel ID,
missing credentials, or conflicting configuration. It installs only page7's
connector and verifies that frozen services, connector PIDs, and configuration
remain unchanged. Do not use `cloudflared service install`, which targets the
shared connector.

DNS is separate. Inspect with
`node scripts/deployment/dns.mjs --target page7 VERIFIED_TUNNEL_UUID`, then append
`--apply` to create only the absent owned CNAME. Conflicts are rejected. This
uses `CLOUDFLARE_API_TOKEN` with DNS read/edit access to `runtimed.run`; deployment
also requires lab1 SSH and sudo. Ingress allows the public app, authentication,
sharing, MCP and sync routes and ends in a catch-all 404; internal Durable Object
routes remain private.

Verify exact deployed hashes, anonymous denial, real OIDC, API-key operations,
live peers, Saved receipts, restart recovery and frozen-service fingerprints
after publication. These are distinct from local fixtures, and a process restart
is not power-loss or bucket-failover proof. Copying a document between deployments
remains explicit; deployment does not migrate another target's data.
