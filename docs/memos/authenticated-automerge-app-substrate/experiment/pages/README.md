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
bootstrap, and idempotency key. Local recovery metadata is scoped by principal,
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
comments, and edit illumination belong to the document experience. Sharing UI
must wait for host-enforced permissions rather than imply access from a link.

The active implementation is PR #4469. The earlier PR #4451 and m.runtimed.run
remain historical comparison material. celld and Cloudflare run the same
application API with separate deployment configuration and data. A host name
is an environment choice, not a separate editor implementation.

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
are editable document content, not a separate audit log. This initial prototype
has private Pages per account; space ACLs and author-only comment editing are
not implemented. Neither document fields nor comments can grant access.

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
outlive the history needed to replay it. Retry receipts are retained
for the document lifetime. At 1,000 receipts the prototype refuses further API
mutations instead of silently forgetting retry keys. Browser edits do not consume
this API limit.

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

Aggregate capacity admission is not atomic with concurrent native writes. A
bounded probe confirmed that a native edit can consume the remaining history
capacity after an API candidate passes validation but before its recorded intent
is applied. The backend then rejects the API write while its intent remains
pending. Restart restores the accepted native edit, but replaying the pending
API intent fails again and blocks Page initialization. This predates the
Cloudflare adapter; it needs a coordinated admission/recovery design before
using the prototype for large histories near its 16 MiB cap.

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

The prepared target is `pages-next.runtimed.run`, service `nteract-pages-next`,
with fleet storage at
`s3://nteract-celld-lab-621741996708/standalone/pages-next` in `us-east-1`.
`m.runtimed.run` uses its existing service and prefix. These scripts do not move
or reuse its data or session secret.

Publication restarts the shared `cloudflared` service after validating the narrow
route change. Expect existing tunnel connections, including `m.runtimed.run`
WebSockets, to disconnect briefly and reconnect. Their application services and
storage prefixes remain intact.

`node scripts/deploy.mjs plan` is read-only. After inspecting the current lab1
runtime, ports, prefix, tunnel and firewall ownership, use `prepare`,
`upload LOCAL_STAGE`, `install REMOTE_STAGE --apply`, then
`publish REMOTE_STAGE --apply`. The installer requires the qualified celld 0.6.1
binary at `/usr/local/bin/celld-v0.6.1` and a clean committed source tree whose
fingerprint matches the bundle. Install that version beside the shared runtime;
the deployment never upgrades `/usr/local/bin/celld` used by other services.
It creates the session secret on the host. Only the explicit release-file
allowlist is staged; local dev credentials and databases are excluded.

DNS is separate: `scripts/deployment/dns.mjs` takes the verified tunnel UUID and
checks the exact hostname without changes by default. Its `--apply` creates only
an absent, owned CNAME and refuses conflicts. Verify anonymous denial, real OIDC,
API-key editing, WebSockets and bucket recovery after publication. A prepared
script is not evidence that those live checks passed.
