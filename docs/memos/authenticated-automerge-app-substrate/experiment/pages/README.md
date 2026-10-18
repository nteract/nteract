# Native Pages on celld

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

The byte-store adapter delegates record persistence to `ctx.storage`. It does
not manage an independent SQLite connection, upload Automerge snapshots on each
edit, or implement object-store manifests. celld owns replication and recovery.
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

Browser storage belongs to one live backend. Each tab uses its own signing key
and IndexedDB database, with Web Locks preventing duplicated tabs from sharing
an active database. Reload in the same tab can reuse that identity. Closing the
tab loses its sessionStorage locator; discovering and recovering abandoned,
unsent local work in a new tab is not implemented. Browser storage eviction is
also outside this prototype's guarantee.

API mutations require the exact `base_heads` from `read_page` and an
`idempotency_key`. Read again after a stale-head rejection. Retry an uncertain
request with the identical key and payload. The host records a bounded write
intent with encoded incremental changes, so replay applies the same CRDT change
IDs rather than repeating the semantic operation. Retry receipts are retained
for the document lifetime. At 1,000 receipts the prototype refuses further API
mutations instead of silently forgetting retry keys. Browser edits do not consume
this API limit.

## API

- `POST /api/tools` with `{operation, arguments}` provides list/create/read,
  structural edits, literal Markdown patches, comments, and deletion.
- `POST /mcp` exposes the same authorized operations through Streamable HTTP MCP.
  Use `Authorization: Bearer <Anaconda API key>` and optionally
  `X-Pages-Driver: ChatGPT` (or another driver label).
- `GET /api/connect?page=<id>` returns the native document ID, host peer ID,
  authenticated identity, and capability projection.
- `GET /api/sync?page=<id>` upgrades to the native Subduction binary protocol.
- `POST /api/saved?page=<id>` accepts `{heads}` and returns a durable frontier.

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

Per-block WYSIWYG editing is carried over. Enter creates paragraphs and list
items within a block. Cross-block selection and full mobile/IME qualification
remain separate editor work. Incoming editor notifications are deferred during
composition; native receive itself is not paused.

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

## Isolated lab deployment

The prepared target is `pages-next.runtimed.run`, service `nteract-pages-next`,
with fleet storage at
`s3://nteract-celld-lab-621741996708/standalone/pages-next` in `us-east-1`.
`m.runtimed.run` uses its existing service and prefix. These scripts do not move
or reuse its data or session secret.

`node scripts/deploy.mjs plan` is read-only. After inspecting the current lab1
runtime, ports, prefix, tunnel and firewall ownership, use `prepare`,
`upload LOCAL_STAGE`, `install REMOTE_STAGE --apply`, then
`publish REMOTE_STAGE --apply`. The installer requires the qualified celld 0.6.1
binary and a clean committed source tree whose fingerprint matches the bundle.
It creates the session secret on the host. Only the explicit release-file
allowlist is staged; local dev credentials and databases are excluded.

DNS is separate: `scripts/deployment/dns.mjs` takes the verified tunnel UUID and
checks the exact hostname without changes by default. Its `--apply` creates only
an absent, owned CNAME and refuses conflicts. Verify anonymous denial, real OIDC,
API-key editing, WebSockets and bucket recovery after publication. A prepared
script is not evidence that those live checks passed.
