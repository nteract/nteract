# Identity and Trust for nteract Notebook Rooms

**Status:** Accepted, 2026-05-21.
**Replaces:** drafts at #2657 (web-sync-engine architecture) and #2761 (SwiftUI viewer + bearer-token endpoint), both since closed.

## Context

`NotebookDoc` and `RuntimeStateDoc` sync between peers via typed-frame v4 over
a Unix socket today, with same-UID trust covering attribution. We want to
extend the same protocol to hosted multi-user rooms (Anaconda hosted,
JupyterHub-backed compute, future deployments) without forking the wire format,
and we want every change in the document to carry verifiable authorship.

The identity design is highly guided by these projects:

- **[`runtimed/intheloop`](https://github.com/runtimed/intheloop)** validates an OIDC bearer JWT via JWKS at WebSocket open. The validated `sub` claim becomes the actor identifier. No per-message re-validation.
- **[`runtimed/anaconda`](https://github.com/runtimed/anaconda)** validates bearer tokens against Anaconda's userinfo endpoint and maps Anaconda scopes to runtimed scopes.
- **JupyterHub** stamps spawned single-user servers via environment variables at launch, and the spawned server validates user identity by calling back to `/hub/api/user`. No `X-Forwarded-User` header is trusted.

As a result, our rule is to never trust a locally-stamped identity claim. We validate against the upstream authority that issued the credential. The other modern concern is that nteract is very agent centric. A human user has many operators acting on their behalf: the desktop app, a TUI, Agents enabled via MCP, the runtimed bindings for bespoke agent usage, and scheduled notebook jobs. All of those actors are legitimately authoring edits "on behalf of" the user. Since, token wise, they operate "as" the user, attribution must distinguish operators while the trust gate enforces the user.

## Decision 1: Two-layer actor labels

Every Automerge actor label is a string of the form:

```
<principal>/<operator>
```

- **Principal**: the authenticated entity. Format: `<scheme>:<scheme-specific-id>`. Examples: `local:quill`, `user:anaconda:550e8400-e29b-41d4-a716-446655440000`, `hub:hub.2i2c.mybinder.org:rgbkrk-notebooks-i28hqg97`, `system`.
- **Operator**: the actor doing the work right now, on behalf of the principal. Self-declared by the connecting client. Convention: `<kind>:<vendor?>:<session-uuid>`. Examples: `desktop:7f3a`, `tui:9d2b`, `agent:claude:s1`, `agent:codex:s2`, `runtime:py-3.12-s4`.

Slash is the delimiter, taken on the first occurrence. If a principal ever contains a literal `/` it is percent-encoded; in practice this does not arise (UUIDs, hostnames, and usernames don't contain slashes).

An `ActorLabel` newtype with `principal()` and `operator()` accessors shall live in the new `nteract-identity` crate. Existing code that treats the label as an opaque string keeps working; code that wants the breakdown adopts the newtype.

Worked examples are at the end of this document.

### Why two layers

The principal is what the trust gate enforces. The operator is what attribution distinguishes. Conflating them, as today's `agent:claude:abc123` does, makes "Claude on quill's machine" indistinguishable from "Claude on someone else's machine" and forces the trust gate into either case-by-case rules or implicit trust of operator names.

This is also how Unix works. Operators are processes and principals are accounts.

This also lends us to better audit logging.

## Decision 2: Rooms are entities; access is a per-room ACL

A notebook room is an entity in its own right, addressed by a room locator:

- `local-daemon:<uuid>` or `local-daemon:<path>` for rooms served by the local
  daemon.
- `runtimed.com/n/<uuid>` (or similar) for Anaconda-hosted rooms.
- `hub.example.com/<user>/n/<uuid>` only when that Hub deployment explicitly
  runs the room host. A JupyterHub runtime sidecar attached to an
  Anaconda-hosted room is not encoded in the room locator.

The locator says *where to reach the room host*, not *who can access it*, where
compute runs, or which blob store backs output bytes. The room host is the live
document authority for `NotebookDoc` and `RuntimeStateDoc`. Access is governed
by a **per-room ACL** that maps principals to scopes.

```
room: runtimed.com/n/9f3a...
acl:
  - principal: user:anaconda:550e...           scope: owner
  - principal: user:anaconda:6611...           scope: editor
  - principal: hub:hub.2i2c.org:rgbkrk         scope: viewer
```

The ACL can reference principals from any identity provider the host is configured to validate against. v1 deployments will typically use a single IdP per host (Anaconda hosted only validates Anaconda credentials, etc.), but that is convention, not a protocol constraint. Federation (host A trusting host B's identity claims) is a separate open follow-up.

Three properties fall out:

1. **Room locators are stable across ownership changes.** Changing the owner
   principal mutates the ACL, not the locator. Existing links keep working.
2. **Rooms can mix principals from multiple IdPs** when the host is configured to validate more than one. Cross-IdP collaboration (e.g., an Anaconda-hosted room shared with a JupyterHub user) is a deployment decision, not a protocol invention.
3. **Future organizational principals** (`org:acme:engineering`, group memberships, etc.) slot into the ACL as additional principal kinds without changing the wire or the validator.

### How authentication interacts with the ACL

1. Connection opens. Listener extracts a credential; the IdP validates it and yields a principal.
2. Room-host looks up the principal in the ACL.
3. If the principal is in the ACL, the connection inherits the ACL-stated scope. If not, the connection is rejected. An unauthenticated request may receive anonymous `viewer` scope when the room has a public-read ACL entry.
4. The connection's `AuthenticatedConnection` carries that principal and scope for the life of the socket.

What this changes from the older framing: rooms are no longer implicitly scoped to one IdP's principal space. They authenticate principals from whatever IdPs the host validates against, and the per-room ACL is the source of truth for who can do what. v1 enforces per-frame actor labels with a clone-preview validator before applying inbound `NotebookDoc` and `RuntimeStateDoc` sync frames. The Automerge fork patch tracked in `docs/architecture/automerge-fork-patches.md` remains the intended lower-cost replacement for that validator.

### ACL mechanics

The minimum v1 ACL is a flat set of rows keyed by `(room, subject_kind, subject, scope)`. The hosted Worker prototype persists those rows in D1 as `notebook_acl`. Owner-scoped HTTP requests can inspect, grant, and revoke individual rows; anonymous public read is represented as a normal row with `subject_kind = public`, `subject = anonymous`, and `scope = viewer`. Public rows cannot grant write scopes, and the prototype rejects removal of the final owner row.

The protocol shape locked here is: rooms have ACLs, ACLs reference principals or explicit public-read subjects, principals authenticate against the host's configured IdPs, and the room ACL is the source of truth for the connection scope. Inheritance from a containing org, group expansion, owner-transfer workflow, audit events, and Zanzibar/Authzed-style relationship evaluation are future layers on top of the flat ACL.

## Decision 3: Authentication at connect, scope checks per frame

Authentication is connection-scoped. The IdP (Identity Provider) is consulted at WebSocket open, never on the sync hot path.

1. Connection opens. Listener extracts the credential (bearer JWT for OIDC/Anaconda, cookie/OAuth token for JupyterHub, peer creds for Unix socket).
2. Identity provider validates the credential. One round-trip (JWKS fetch for OIDC is cached; `/hub/api/user` for JupyterHub; userinfo for Anaconda).
3. Room-host looks the validated principal up in the room's ACL. If present, the connection inherits the ACL scope; if absent, the connection is rejected. Unauthenticated requests may receive anonymous `viewer` scope when the room has a public-read ACL entry, such as the D1 public-read row defined in `hosted-room-authorization.md` for hosted rooms.
4. Validation yields an `AuthenticatedConnection { principal, scope, allowed_operator_kinds }` in server memory, scoped to this socket.
5. Handshake response includes the assembled actor label so the client knows what to author as.
6. Every subsequent frame is checked against `AuthenticatedConnection.scope` for **scope-level legality** at the frame layer (frame type and emptiness of `Message.changes`). Inbound frames that carry changes are also applied to a cloned document first so the room-host can extract new change actors and reject principal forgery before mutating the real room document.

If the credential expires while connected, the connection stays open. Revocation is future work: a server-pushed `SESSION_CONTROL` close frame ends affected connections when an out-of-band signal (admin revoke, plan downgrade, sign-out) arrives. v1 assumes that anyone who authenticated continues to have access for the connection's lifetime.

### What `AuthenticatedConnection` is and is not

`AuthenticatedConnection` is **server-side in-memory state**, owned by the room-host, scoped to exactly one WebSocket (or Unix-socket) connection. It is not a token. It is not transferable. It cannot be presented by a client. It is created when a socket completes authentication and dropped when that socket closes.

Bearer-token replay is a separate, well-known property of bearer auth: if a user's JWT is stolen, the thief can open a new socket and obtain their own `AuthenticatedConnection`. The mitigation is at the credential layer, not the connection layer (e.g., DPoP / proof-of-possession tokens, short token lifetimes, mTLS for system-to-system). v1 inherits the bearer-token threat model; tightening it is future work.

### Per-frame sync checks

The room-host enforces scope at frame ingress by inspecting frame type and emptiness:

- **viewer** scope: any inbound `0x00` or `0x05` frame with non-empty `Message.changes` is rejected. Empty negotiation frames (heads/have/need with `ChunkList::empty()`) pass.
- **runtime_peer** scope: any inbound `0x00` (NotebookDoc) frame with non-empty changes is rejected. `RuntimeStateDoc` writes are allowed only for runtime progress/output over already accepted execution entries, lifecycle state, comm topology, and output routing; trust, environment, path, save metadata, and project context remain room-host/daemon-owned. Execution intent creation still goes through `ExecuteCell`/`RunAllCells`. In the hosted prototype, runtime authorship uses a `RuntimeStatePeerHandle` surface separate from the browser `NotebookHandle`, so a runtime peer can publish execution progress/output state without acquiring notebook editing APIs.
- **editor** scope: `0x00` NotebookDoc edits are allowed only within the room host's current document-write policy. `0x05` RuntimeStateDoc edits are accepted only when the server-side policy proves the delta is an existing widget comm-state mutation; execution, queue, kernel, environment, output, comm topology, and schema/root changes are rejected.
- **owner** scope: same frame-level document rules as `editor`, plus ACL-mutation requests are honored. Owner does not imply arbitrary RuntimeStateDoc authorship; runtime lifecycle, execution progress, and output state still require `runtime_peer`, while execution intent still requires the request API.

For non-empty `NotebookDoc` and `RuntimeStateDoc` sync messages, the room-host also performs a v1 clone-preview validator: clone the current Automerge doc and sync state, apply the incoming message to the clone, extract the actors in the newly applied changes, and reject the frame if any new change's principal differs from the connection's authenticated principal. The real room document is mutated only after this preview succeeds.

This closes live principal forgery for v1, but it is intentionally a stopgap. It deep-clones the document and applies each non-empty inbound message twice, which is most expensive on the high-churn `RuntimeStateDoc` path. `docs/architecture/automerge-fork-patches.md` Patch 1 (`sync_message_new_changes`) is the planned v2 replacement: inspect the new changes from a sync message without cloning or applying to a throwaway document.

### Schema-seed actors get principal-prefixed labels

The frozen genesis actors today are not principal-prefixed:

- `nteract:notebook-schema:v4` (`crates/notebook-doc/src/lib.rs:79`)
- `nteract:runtime-state-schema:v2` (`crates/runtime-doc/src/doc.rs:318`)

As part of this work the schema bumps (notebook v5, runtime-state v3) and the new seed actors adopt the `system/schema:notebook:v5` and `system/schema:runtime-state:v3` form so they are first-class within the principal model. Existing notebooks keep the legacy labels in historical changes (immutable in the DAG); new rooms ship with the new genesis bytes from day one.

### Presence rewrite

Presence frames carry `peer_id`, `peer_label`, and `actor_label` (the last two optional, per `crates/notebook-doc/src/presence.rs:161, 200`). All three are self-declared today. On ingress:

- **`actor_label` present**: overwrite the principal prefix with the connection's authenticated principal. The operator suffix passes through unchanged.
- **`actor_label` missing**: synthesize one from the connection's authenticated principal plus the connection-level operator declared at handshake (or, if the client never declared one, a synthetic operator built from the listener's connection id, e.g., `unknown:<connection-uuid>`). The synthesized label always has the correct principal.
- **`actor_label` malformed** (no `/`, principal-only, or unrecognized shape): treat as missing. Synthesize as above.
- **`peer_label` (display name)**: passes through unchanged. It's UI text.
- **`peer_id`**: passes through unchanged. It's a transport-layer connection scope.

The principal prefix is always server-controlled; no presence ingress path lets a client choose what principal it appears as. Operator and display name are client-declared.

## Decision 4: Credentials and identity providers are separate concerns

Two concepts, two surfaces:

- **Identity providers** are server-side. One closed enum in the `nteract-identity` crate. They accept a normalized `Credential` and return an `AuthenticatedUser`.
- **Credentials** are everything else: the client-side keyring that stores them and the listener-side extractor that pulls them out of the upgrade request. Both sit outside the providers.


**Server-side: enum dispatch** (in `nteract-identity`)

In order to make this easy to work with we'll have a fixed set of providers: Local, OIDC, and JupyterHub. OIDC covers a broad collection of issuers (Anaconda, Cloudflare Access, Clerk, Auth0, Okta, WorkOS, generic OIDC) through configuration alone. The enum makes "which providers this build knows about" explicit in the type system, costs nothing at runtime, and avoids the `dyn`-incompatibility of Return-Position-`impl Trait`-in-Traits.

```rust
pub enum IdentityProvider {
    Local(LocalProvider),
    Oidc(OidcProvider),
    JupyterHub(JupyterHubProvider),
}

impl IdentityProvider {
    pub fn authenticate(
        &self,
        presented: Credential,
    ) -> impl std::future::Future<Output = Result<AuthenticatedUser, AuthError>> + Send + '_ {
        async move {
            match self {
                Self::Local(p) => p.authenticate(presented).await,
                Self::Oidc(p) => p.authenticate(presented).await,
                Self::JupyterHub(p) => p.authenticate(presented).await,
            }
        }
    }
}
```

Each variant's inner provider exposes its own `authenticate` as RPITIT (Return-Position impl Trait In Traits) with `+ Send`, matching the repo's existing convention (`crates/runtimed/src/kernel_connection.rs:80-98`). No `async_trait` boxing.

**Everything lives in one crate, `nteract-identity`.** Providers are modules, not separate crates:

```
nteract-identity/
+-- lib.rs            # ActorLabel, Principal, AuthenticatedUser, AuthError, Credential, IdentityProvider enum
+-- local.rs          # LocalProvider (peer creds)
+-- oidc.rs           # OidcProvider (JWKS bearer; configurable for Anaconda, Cloudflare Access, Clerk, Auth0, Okta, WorkOS, generic OIDC)
\-- jupyterhub.rs     # JupyterHubProvider (Hub cookie/token via /hub/api/user)
```

Multi-crate decomposition (`nteract-identity-local`, `-oidc`, `-jupyterhub`) would put `Credential`, `AuthenticatedUser`, and `AuthError` in `nteract-identity` while the implementor crates also need those types; the enum then has to depend back on its implementors, producing a Cargo cycle. One crate avoids it.

Provider-specific dependencies (jose, jwks, openidconnect for OIDC; reqwest for JupyterHub) are gated by Cargo features so a build that only needs `LocalProvider` does not pull them in:

```toml
[features]
default = ["local"]
local = []
oidc = ["dep:openidconnect", "dep:jose"]
jupyterhub = ["dep:reqwest"]
```

Each provider module is testable in isolation against fixture credentials and a fake IdP. The crate has no dependency on `runtimed`, `kernel-env`, or any daemon internals.

**Client-side: `Credential` keyring**

A small client-side keyring (proposed crate: `nteract-credentials`) holds per-host credentials. Stored encrypted at rest, looked up by room host when the daemon (or any client) needs to authenticate into a remote room. Separate from the IdP because the IdP doesn't care where the credential came from; the keyring doesn't care how it's validated.

The desktop daemon's keyring grows entries like:

```
runtimed.com           -> AnacondaApiKey { token: "..." }
hub.example.com        -> JupyterHubToken { token: "...", expires_at: ... }
local-socket           -> (none, peer creds used)
```

A user adds an entry once (paste a key, OAuth flow, JupyterHub session forward) and any subsequent room-open against that host uses it.

### Credential presentation on the WebSocket upgrade

Browsers cannot set custom request headers on `new WebSocket(url, subprotocols)`. The credential has to arrive via one of these mechanisms. Parsing each of them is a **listener-side concern**, not a provider concern: the listener (Cloudflare Worker, Unix socket, etc.) inspects the upgrade request and produces a normalized `Credential` that the provider then validates.

`docs/architecture/hosted-credential-transport.md` is the deployment-level ADR
for choosing among these transports. This section only records the base
credential vocabulary.

1. **Subprotocol smuggling** (the Kubernetes pattern). Client opens `new WebSocket(url, ["nteract-bearer.<base64url-token>", "nteract.v4"])`. Server reads `Sec-WebSocket-Protocol`, peels off the credential element, validates the decoded token, and echoes back only `nteract.v4` as the selected subprotocol. The token is not in the URL, not in the referer, not in server access logs. The token is still visible to any JS in the browser that can construct a WebSocket, which is the same trust boundary every other credential mechanism shares.

2. **One-time ticket**. Client POSTs `/api/session-tickets` with the real bearer (header-set, normal CORS). Server returns a short-lived (~10s, single-use) ticket. Client opens `wss://host/n/<id>?ticket=<one-time>`. Server validates the ticket, consumes it, and the connection is authenticated as the original user. The real bearer never appears in the WebSocket URL. Costs one extra round trip; the server tracks outstanding tickets in memory or D1.

3. **Cookie**. Browsers send cookies automatically on the WS upgrade when same-site. This is useful for deployments such as Cloudflare Access where the cookie is part of the perimeter session and the Worker validates a forwarded assertion. It is deployment-specific for providers such as JupyterHub because provider cookies also bring CSRF and origin handling.

4. **`Authorization` header** (system-to-system only). Native clients (desktop daemon, agents, CLI) set `Authorization: Bearer ...` directly on the upgrade request. Browsers cannot. This is the trivial path for the desktop daemon connecting to an Anaconda-hosted or JupyterHub-hosted room on the user's behalf.

Base options by provider:

| Provider | Browser clients | System clients |
|----------|-----------------|----------------|
| `Oidc` (Anaconda, Cloudflare Access, Clerk, ...) | Cloudflare Access assertion, subprotocol bearer token, or one-time ticket depending on deployment | `Authorization` header |
| `JupyterHub` | Hub-issued token via subprotocol or ticket; cookie only when the deployment owns CSRF/origin policy | `Authorization` header with Hub-issued token |
| `Local` | N/A (no WS) | Unix peer creds |

The Worker DO extracts the credential at upgrade time, validates via the configured `IdentityProvider`, and rejects the upgrade with HTTP 401 (or closes immediately with a typed close code) if validation fails. After upgrade, the WebSocket carries no further auth; per-frame validation runs against the in-memory `AuthenticatedConnection`.

The `Credential` enum therefore covers all of these:

```rust
pub enum Credential {
    BearerToken(String),     // from subprotocol, ticket exchange, or Authorization header
    Cookie(String),          // from upgrade-request cookies
    UnixPeer(PeerCredInfo),  // SO_PEERCRED for the local daemon's listener
}
```

The extraction logic (parse subprotocol header, look up ticket, read cookie, query peer creds) is listener-side concerns; it does not belong in the providers themselves. A `CredentialExtractor` trait sits on the listener implementation and feeds the provider a normalized `Credential`.

## Decision 5: Four scopes

A connection carries exactly one scope, determined at authentication time. The four scopes are:

- `viewer` - read-only. May send and receive sync, presence, and session-control frames, **but inbound sync frames must carry no changes**. Automerge sync is bidirectional even when the client never authors: a read-only consumer still negotiates heads/have/need with the server, applies incoming changes from the server, and produces reply frames (see `crates/notebook-sync/src/sync_task.rs:680-724`). The trust gate rejects any inbound `0x00` or `0x05` frame from a viewer connection whose `Message.changes` is non-empty; empty negotiation frames pass. Request frames are limited to read-only operations. The server's outbound to the viewer is unrestricted.
  - Note on the upstream Automerge `read_only` API: `State::new_read_only()` and `MessageFlags::READ_ONLY` are **not** the client-side viewer primitive. Upstream `read_only` means "the holder of this state will not apply incoming changes but will still send its own" (publish-only semantics; see `rust/automerge/src/sync.rs:408` and `rust/automerge/src/sync/state.rs:65-67`). A viewer client that uses `State::new_read_only()` will not apply live room updates. Hosted room hosts may still use `State::new_read_only()` for their per-viewer peer state as an optimization and protocol hint: the host will not apply that peer's changes while still sending room changes to the peer. That is not the authorization boundary; the server must still reject any viewer `Message.changes` explicitly.
- `editor` - live edit on `NotebookDoc` within the room host's document-write policy, plus a narrow allowed-write surface on `RuntimeStateDoc` for widget comm state. The widget surface is existing `doc.comms/*/state/*`, mediated client-side by the approved comm writer (`apps/notebook/src/App.tsx:465-477`, `set_comm_state_batch` + `triggerSync`) and enforced server-side by the shared runtime-doc policy (`crates/runtime-doc/src/policy.rs`). Outside that subtree, editor `RuntimeStateDoc` writes are rejected. Editors cannot create executions, manipulate queue/kernel/environment state, rewrite output routing, create/remove comms, or add hidden RuntimeStateDoc root keys.
- `runtime_peer` - permitted to write `RuntimeStateDoc` execution progress, output, lifecycle, and comm topology state for already accepted executions. It cannot create execution intent or edit `NotebookDoc`. Used by future remote-runtime services and by JupyterHub-spawned runtime sidecars/services when they connect a kernel. The hosted Worker prototype exercises this as direct `0x05` sync from a runtime authoring handle; it still does not host kernels inside the Durable Object.
- `owner` - editor plus publish-revisions and manage-ACL requests.

### Where scope comes from

Scope is determined by intersecting two sources: what the IdP says about the user (claims/roles in the validated credential) and what the room's ACL says about the principal. The narrower of the two wins. A principal that the IdP marks as `editor` but the ACL marks as `viewer` is a viewer in that room. A principal not present in the ACL at all is rejected at connection time. Anonymous viewer access is only considered for unauthenticated requests when the room contains a public-read entry.

### Scope enforcement points

Scope is enforced server-side at three points, each with a clear boundary:

1. **Frame ingress** (in `peer_notebook_sync.rs::handle_notebook_doc_frame`, `peer_runtime_sync.rs`, and the hosted WASM room host): the validator consults `AuthenticatedConnection.scope` and rejects frames that exceed the scope: viewer with non-empty changes on any doc, `runtime_peer` sending changes to `NotebookDoc`, or editor/owner `RuntimeStateDoc` changes outside the existing widget comm-state surface. The hosted Worker and daemon share the same RuntimeStateDoc policy helper so this is no longer a hosted-only TODO.
2. **Request dispatch**: each `NotebookRequest` variant declares its minimum required scope via an annotation or registry lookup. The request handler rejects with a typed `Unauthorized` response before any side effect. New scope-gated requests declare their requirement at the definition site; no scattered `if scope == ...` checks elsewhere.
3. **ACL mutations** are owner-only. The hosted Worker prototype exposes owner-only HTTP ACL management for individual D1 rows. No in-band Automerge ACL change is honored from a non-owner connection.

### Adding new scope-gated functionality

Every new request variant or frame type must specify its required scope at the definition site. A CI lint (or a small `#[derive]` macro) verifies that every variant has a scope annotation. This makes scope creep visible in code review and prevents the "wrong layer for enforcing it" failure mode.

### What does and does not appear on the wire

Scope is **not** sent on the wire today. The server is the only authority. A future protocol extension may add a `connection_scope` field to the handshake response so UIs can render "read-only" badges without inferring scope from request failures. That field would be advisory; the server still enforces.

## Decision 6: Publish is a fresh document in the destination space

A publish operation produces a **fresh Automerge document** in the destination's identity space. Historical actor labels from the source space are not carried across the boundary.

The reason is the same one that makes git commits with arbitrary `Author:` lines untrustworthy without GPG: actor labels in Automerge are self-attested. If we copied `local:quill/desktop:abc` historical changes into an Anaconda-hosted room, the room would be vouching for authorship it has no way to verify. Anyone could fabricate a doc claiming any local-space attribution and publish it. Better to make the publish boundary explicit: history-of-edits stops at the boundary, and the destination space records who *published* the snapshot, not who authored each historical edit.

Concretely: quill publishes a local untitled notebook to Anaconda.

1. Desktop captures the current rendered state of the local `NotebookDoc` and `RuntimeStateDoc`: cells, metadata, outputs, blob references. This is essentially the `.ipynb`-equivalent plus output blobs.
2. The destination creates a **new** Automerge document in its own identity space. A `system/schema:notebook:vN` seed actor establishes the schema; a fresh publisher actor (`user:anaconda:550e.../publisher:<timestamp>`) authors all the imported cells, metadata, and outputs as a single round of changes.
3. Blob references are uploaded by SHA-256 hash. R2 dedupes; the destination room references them by the same hashes.
4. The destination registers the room in its catalog (D1 row, latest revision pointer).
5. Future edits in the destination room author under destination-space principals normally. There are no `local:*` actors in the doc.

Attribution after publish reflects what the destination can actually vouch for: "this snapshot was published by `user:anaconda:550e...` on `<timestamp>`." Per-edit history of the source notebook is not preserved. Side effects:

- **Import-time forgery is closed.** A hosted deployment never accepts a *published* doc that contains historical Automerge attribution from outside its own scope; the import path strips source-space history and re-authors as a fresh publisher actor. Live in-room principal forgery is also rejected by the v1 clone-preview validator; the remaining caveat is its performance cost until the Automerge fork patch lands.
- **History is lost on publish.** Anyone who needs the pre-publish authorship trail keeps the source notebook around (it still lives in the source space). Re-publishing produces a new snapshot in the destination; old snapshots are immutable revisions.
- **Future cryptographic verification.** When Automerge gains signed-change support (keyhive direction; see `https://www.inkandswitch.com/keyhive/notebook/`), historical authorship from a source space could be carried across publish if every historical change is signed by its claimed author. Until then, this ADR closes the door on cross-space attribution.

## Limitations

v1 enforces the trust gate at room ingress: bearer auth and ACL membership at connect, scope-based frame rejection per frame, and actor-principal validation for newly received Automerge changes. The v1 validator is intentionally conservative: it clone-previews non-empty sync messages before applying them to the real `NotebookDoc` or `RuntimeStateDoc`.

The threat surface this leaves:

| Attack | Mitigated by | Status |
|--------|--------------|--------|
| Unauthorized read | ACL check at connect | closed |
| Unauthorized write at all | Bearer auth + ACL at connect | closed |
| Scope escalation (viewer authoring, runtime_peer editing NotebookDoc) | Scope-based frame rejection | closed |
| Import-time cross-IdP forgery (publishing a doc with historical foreign actor labels) | Publish-as-fresh-doc (Decision 6) | closed |
| **Live actor-principal spoofing** (an authenticated peer authors a new change under a different principal) | Clone-preview actor validation before apply | closed in v1 |
| Bearer-token replay (stolen JWT opens a new socket) | DPoP / mTLS / short token lifetimes | deferred |
| Clone-preview validator cost on large/high-churn docs | `sync_message_new_changes` Automerge fork patch | deferred performance hardening |

The v1 clone-preview validator closes principal forgery without new Automerge APIs by using the existing post-apply actor extraction primitive against a cloned document. The deferred work is performance, not correctness: parsing `automerge::sync::Message.changes` (`ChunkList(Vec<Vec<u8>>)` of raw chunks; V1 = one `Change` per chunk; V2 = potentially a whole-doc save) without cloning is what the companion `automerge-fork-patches.md` ADR proposes adding to our Automerge fork.

The upstream `filters` work (`origin/filters` branch on `automerge/automerge`, post-peer-review, `rust/automerge/src/filter.rs`) gives us a complementary subduction primitive once it lands in main: `Filter::Allow / AllowUpTo { heads } / Deny` per-actor or per-author. Filters do not reject changes pre-storage (rejected changes still ingest and sync) but they hide them from rendering, which is the right primitive for runtime revocation and post-hoc audit hiding. When filters lands, pairing them with a pre-apply validator becomes the natural next step. Keyhive ([inkandswitch/keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)) is orthogonal: change-level capability tokens with signed changes; composable later if needed.

## Migration

The repo currently persists `.automerge` only for untitled ephemeral notebooks. No production-shipped notebook has long-lived Automerge actor labels in the legacy format. The new `<principal>/<operator>` format is adopted from day one of the change. Old in-memory actor labels in current sessions get replaced on next daemon restart; nothing on disk to migrate.

## Open Questions

These follow-up ADRs and design decisions are tracked but not decided here:

1. **Room-host crate extraction.** Pulling `runtimed::notebook_sync_server::room` into `nteract-room-host` with pluggable `Listener` and `SnapshotStore` traits. Tracked in a separate ADR.
2. **Identity provider selection for Anaconda hosted v1.** Likely OIDC against Anaconda's existing SSO, with Cloudflare Access as the first browser session layer for the hosted Worker. `docs/architecture/hosted-credential-transport.md` tracks the exact credential transport and principal-namespace decision.
3. **Anonymous viewer scope.** Whether read-only public publish URLs require a session or run un-authenticated under a synthetic `system:anonymous` principal.
4. **Revocation signal and historical-change subduction.** Two parts. First, the wire signal: the exact `SESSION_CONTROL` close frame and the channel for admin revokes / plan downgrades. Second, what happens to changes a revoked principal already authored. The Automerge `filters` work (`origin/filters` branch, `rust/automerge/src/filter.rs`) is the natural primitive: install a `Filter::with_author(revoked, Rule::AllowUpTo { heads: validated })` to subduct edits authored after revocation while keeping causal integrity intact. Wait for `filters` to land in main before depending on it; until then, revocation is a hard connection close with no post-hoc audit hiding.
5. **Connection-scope field on the wire.** Optional handshake response field so UIs can render "read-only" badges without inferring from request failures.
6. **Federation.** A notebook host trusting another notebook host's identity claims (e.g., JupyterHub Anaconda interop). Not v1.
7. **`runtime_peer` connection topology.** The hosted prototype now supports direct `runtime_peer` `RuntimeStateDoc` ingress into the room. Still open: whether the production kernel sidecar connects to the room directly with its own `runtime_peer` scope credential, or whether a separate runtime-coordination protocol relays writes. Tied to the future remote-runtime work.
8. **Deployment topology.** How clients reach rooms (browser-direct WebSocket, local-daemon proxy, native client), where kernels run, TLS/CORS, credential keyring placement. Drafted in `docs/architecture/deployment-topology.md`.
9. **ACL mechanics beyond the Cloudflare v1 shape.** The hosted prototype covers flat D1 rows, public-read rows, and owner-only row mutation. Still open: owner transfer UX, group/org expansion, inherited ACLs, audit event retention, Zanzibar/Authzed-style evaluation, and product policy for anonymous public presence.
10. **Signed-change authorship across publish.** When Automerge gains signed changes (keyhive direction), publish flows could carry historical authorship across identity spaces with cryptographic verification. Until then, publish produces a fresh document in the destination space (see Decision 6).
11. **Bearer-token replay mitigation.** DPoP / proof-of-possession tokens, mTLS for system-to-system, short token lifetimes. v1 inherits the bearer-token threat model; tightening it is future work.
12. **Lower-cost actor-label validator.** Replace the v1 clone-preview validator with parsing of `automerge::sync::Message.changes` chunks (V1 and V2) before merge to reject changes whose actor's principal doesn't match the connection's authenticated principal. Deferred until we land a patch on our Automerge fork as part of the room-host crate extraction. Drafted in `docs/architecture/automerge-fork-patches.md`. Pairs with the filters work above for full attribution integrity once both are in.

## Worked examples

### quill editing a local untitled notebook

- Unix socket connect. Listener reads `SO_PEERCRED`, finds OS user `quill`. `IdentityProvider::Local(...)` returns principal `local:quill`, scope `owner`.
- Desktop UI opens the notebook via the daemon. Daemon stands up a WASM peer with actor `local:quill/desktop:7f3a`.
- Claude (via MCP) joins the same room from the same machine. Claude's MCP process connects on the same Unix socket; its principal is also `local:quill`. It picks operator `agent:claude:s1`. Actor label `local:quill/agent:claude:s1`.
- Both connections write changes. The room-host enforces scope at frame ingress: both are `owner` scope, so both can write allowed `NotebookDoc` edits and existing widget comm-state `RuntimeStateDoc` mutations. Runtime lifecycle/progress/output state still requires `runtime_peer`, and execution intent still requires the request API. Clone-preview validation rejects each newly received change whose author principal is not `local:quill`, including peer-authored `system` changes.
- Presence shows two operators under one principal. UI can render "quill (Desktop)" and "quill (Claude)" by reading the operator suffix.

### quill editing an Anaconda-hosted notebook

- quill's client opens an authenticated connection to the Anaconda-hosted room. The transport (browser-direct WebSocket, local-daemon proxy, native client, etc.) is a deployment-topology concern, separate from identity.
- Anaconda's room-host validates the credential. Returns principal `user:anaconda:550e...`. Looks the principal up in the room's ACL, finds scope `editor`.
- The client stands up a WASM peer in the hosted room with actor `user:anaconda:550e.../desktop:7f3a`.
- Edits flow over the established connection. Scope-level frame checks pass for allowed `NotebookDoc` edits and existing widget comm-state `RuntimeStateDoc` mutations, while runtime lifecycle/progress/output state remains `runtime_peer`-owned and execution intent remains request-owned. Clone-preview actor validation rejects any newly received change whose principal is not `user:anaconda:550e...`, including peer-authored `system` changes.
- The same process may simultaneously have an untitled local notebook open in a separate connection. That connection authenticates as `local:quill` against the local daemon. Two rooms, two ACLs, two separately authenticated connections.

### Claude editing the Anaconda-hosted notebook on quill's behalf

- quill's Claude (running locally) connects to the hosted room.
- Claude's MCP process authenticates against Anaconda using a credential quill made available to it (re-using quill's session, an Anaconda API key scoped for agents, or similar; the exact credential-delegation mechanic is out of scope here).
- Anaconda validates, returns principal `user:anaconda:550e...` (same as quill), scope `editor` (as the ACL permits).
- Claude's actor is `user:anaconda:550e.../agent:claude:s1`. Same principal as quill's desktop session, different operator. Attribution shows both clearly; the trust gate sees them as the same principal and authorizes both.

### Publishing a local notebook to Anaconda

- quill triggers "publish to Anaconda" from desktop.
- Desktop captures the current rendered state of the local `NotebookDoc` and `RuntimeStateDoc`: cells, metadata, outputs, blob references.
- The destination (Anaconda) creates a **new** Automerge document in its space: schema-seed actor for the genesis, then a fresh publisher actor (`user:anaconda:550e.../publisher:<timestamp>`) authoring all imported cells/metadata/outputs in one round.
- Output blobs upload by SHA-256 hash; R2 dedupes.
- A new room appears at `runtimed.com/n/<id>` with an ACL containing quill as `owner`. Opening it follows the previous example. New edits author under `user:anaconda:550e.../*`; the destination doc contains no `local:*` actors.
- The original local notebook is unchanged. Pre-publish authorship history lives only in the source space.

## Compatibility with Automerge semantics

This section records the audit against Automerge and automerge-repo so the trust model does not surprise us downstream.

**Actor IDs are self-attested in Automerge.** An Automerge `Change` carries an `actor_id` set by the author at write time. Automerge does not cryptographically bind the actor to anything; it uses the actor only for change ordering and conflict resolution. Two clients must not use the same actor concurrently or `(actor_id, seq)` collisions break CRDT correctness. The `<principal>/<operator>` format includes a `<session-uuid>` in the operator suffix, so uniqueness is preserved when a single user runs multiple operators in parallel. Compatible.

**Actor-label validation is v1 clone-preview, v2 parse-only.** `automerge::sync::Message.changes` is `ChunkList(Vec<Vec<u8>>)`, raw chunk bytes that are not pre-parsed `Change`s. v1 applies non-empty inbound sync messages to a cloned `NotebookDoc` or `RuntimeStateDoc`, extracts actors from the new heads on that clone, validates principals, then applies the same message to the real document only after validation passes. This is correct but costs a clone and duplicate apply per non-empty inbound frame. The planned Automerge fork patch (`sync_message_new_changes`) replaces the clone-preview with a parse-only pre-apply hook.

**Hash-pinned history is immutable.** Each `Change` references its parents by hash. A peer cannot rewrite history without changing every downstream hash, which then fails the room's existing heads check. The validator only needs to guard *new* changes; historical changes are protected by hash chaining. Compatible.

**automerge-repo's transport-layer trust model matches ours.** automerge-repo network adapters (WebSocket, BroadcastChannel, etc.) treat identity as a transport concern; the document layer assumes peers handed up by the adapter are legitimate. Per-room identity, connect-time auth, and per-frame actor validation slot in at the adapter/listener boundary. Compatible.

**Ephemeral messages stay separate.** automerge-repo's ephemeral messages (presence-like) are out-of-band from doc state. Our presence frames (`0x04`) follow the same shape. The per-ingress rewrite of the principal prefix in presence is a server-side policy, not a CRDT operation; it does not enter the Automerge DAG. Compatible.

**`set_actor` mid-session is allowed by Automerge but discouraged by us.** Automerge supports calling `set_actor` to change the actor used for subsequent changes. The trust model treats actor labels as a per-connection invariant: the operator suffix is fixed at WASM-peer construction time and not changed for the connection's life. Clients that want to write under a new operator open a new connection. This is a discipline, not an Automerge limitation.

**One place where Automerge defaults differ from ours.** Out of the box, Automerge generates a random `ActorId` per `AutoCommit`. Our code overrides this with a human-readable label (`crates/notebook-doc/src/lib.rs:486-505`). The trust model continues that override and extends the label format. No change to Automerge's wire shape.

## References

- `crates/notebook-wire/AGENTS.md` - frame types and v4 wire details.
- `crates/notebook-protocol/src/connection/handshake.rs` - handshake shape.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` - where the per-frame validator hooks in.
- `crates/notebook-doc/src/diff.rs:439` - `extract_change_actors`, the post-apply attribution primitive used by both `TextAttribution` and the v1 clone-preview actor validator.
- `automerge::sync::Message` (rust/automerge/src/sync.rs:516-588) - the `ChunkList` wire shape backing per-frame validation.
- `crates/notebook-doc/src/presence.rs` - presence frame shape.
- [`runtimed/intheloop`](https://github.com/runtimed/intheloop) `backend/auth.ts`, `backend/sync.ts` - bearer-JWT validation + connection-time auth model.
- [`runtimed/anaconda`](https://github.com/runtimed/anaconda) `api_key.ts` - Anaconda userinfo validation + scope mapping.
- JupyterHub `jupyterhub/services/auth.py` - Hub cookie/token validation, no `X-Forwarded-User`.
- Automerge `filters` branch (`origin/filters` on `automerge/automerge`), specifically `rust/automerge/src/filter.rs` - the subduction primitive that complements (but does not replace) our pre-apply gate, and the natural home for runtime revocation.
- automerge-repo `DocSynchronizer.receiveSyncMessage` and `NetworkAdapterInterface` - confirms there is no built-in per-message authorization hook; any gate has to sit above the synchronizer.
- Keyhive notebook: https://www.inkandswitch.com/keyhive/notebook/ - capability + E2EE; orthogonal to connection-level trust, composable later.
