# Identity and Trust for nteract Notebook Rooms

**Status:** Accepted, 2026-05-21.
**Replaces:** drafts at #2657 (web-sync-engine architecture) and #2761 (SwiftUI viewer + bearer-token endpoint), both since closed.

## Context

`NotebookDoc` and `RuntimeStateDoc` sync between peers via typed-frame v4 over a Unix socket today, with same-UID trust covering attribution. We want to extend the same protocol to hosted multi-user rooms (Anaconda hosted, JupyterHub-spawned, future deployments) without forking the wire format, and we want every change in the document to carry verifiable authorship.

The identity design is highly guided by these projects:

- **runtimed/intheloop** validates an OIDC bearer JWT via JWKS at WebSocket open. The validated `sub` claim becomes the actor identifier. No per-message re-validation.
- **runtimed/anaconda** validates bearer tokens against Anaconda's userinfo endpoint and maps Anaconda scopes to runtimed scopes.
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

A notebook room is an entity in its own right, identified by a host-derived URI:

- `local-daemon:<uuid>` or `local-daemon:<path>` for rooms served by the local daemon.
- `runtimed.com/n/<uuid>` (or similar) for Anaconda-hosted rooms.
- `hub.example.com/<user>/n/<uuid>` for JupyterHub-spawned rooms.

The URI says *where the room lives*, not *who can access it*. Access is governed by a **per-room ACL** that maps principals to scopes.

```
room: runtimed.com/n/9f3a...
acl:
  - principal: user:anaconda:550e...           scope: owner
  - principal: user:anaconda:6611...           scope: editor
  - principal: hub:hub.2i2c.org:rgbkrk         scope: viewer
```

The ACL can reference principals from any identity provider the host is configured to validate against. v1 deployments will typically use a single IdP per host (Anaconda hosted only validates Anaconda credentials, etc.), but that is convention, not a protocol constraint. Federation (host A trusting host B's identity claims) is a separate open follow-up.

Three properties fall out:

1. **Room URIs are stable across ownership changes.** Changing the owner principal mutates the ACL, not the URI. Existing links keep working.
2. **Rooms can mix principals from multiple IdPs** when the host is configured to validate more than one. Cross-IdP collaboration (e.g., an Anaconda-hosted room shared with a JupyterHub user) is a deployment decision, not a protocol invention.
3. **Future organizational principals** (`org:acme:engineering`, group memberships, etc.) slot into the ACL as additional principal kinds without changing the wire or the validator.

### How authentication interacts with the ACL

1. Connection opens. Listener extracts a credential; the IdP validates it and yields a principal.
2. Room-host looks up the principal in the ACL.
3. If the principal is in the ACL, the connection inherits the ACL-stated scope. If not, the connection is rejected (or downgraded to anonymous `viewer` if the ACL has a public-read entry).
4. The per-frame validator continues to enforce that change actors carry the connection's authenticated principal.

The validator's job does not change. What changes is that the room is no longer implicitly scoped to one IdP's principal space.

### ACL mechanics (deferred)

The minimum v1 ACL is a flat `Vec<(Principal, Scope)>`. The specifics of ACL editing (which principals may add/remove others), inheritance from a containing org, group expansion, anonymous public-read, and ACL persistence are deferred to a follow-up ADR. The protocol shape locked here is: rooms have ACLs, ACLs reference principals, principals authenticate against the host's configured IdPs.

## Decision 3: Authentication at connect, validation per frame

Authentication is connection-scoped. The IdP (Identity Provider) is consulted at WebSocket open, never on the sync hot path.

1. Connection opens. Listener extracts the credential (bearer JWT for OIDC/Anaconda, cookie/OAuth token for JupyterHub, peer creds for Unix socket).
2. Identity provider validates the credential. One round-trip (JWKS fetch for OIDC is cached; `/hub/api/user` for JupyterHub; userinfo for Anaconda).
3. Validation yields an `AuthenticatedConnection { principal, scope, allowed_operator_kinds }`.
4. Handshake response includes the assembled actor label so the client knows what to author as.
5. Every subsequent frame is validated against the in-memory `AuthenticatedConnection`. No IdP calls.

If the credential expires while connected, the connection stays open. Revocation is future work: a server-pushed `SESSION_CONTROL` close frame ends affected connections when an out-of-band signal (admin revoke, plan downgrade, sign-out) arrives. v1 assumes that anyone who authenticated continues to have access for the connection's lifetime.

### What `AuthenticatedConnection` is and is not

`AuthenticatedConnection` is **server-side in-memory state**, owned by the room-host, scoped to exactly one WebSocket (or Unix-socket) connection. It is not a token. It is not transferable. It cannot be presented by a client. It is created when a socket completes authentication and dropped when that socket closes.

Bearer-token replay is a separate, well-known property of bearer auth: if a user's JWT is stolen, the thief can open a new socket and obtain their own `AuthenticatedConnection`. The mitigation is at the credential layer, not the connection layer (e.g., DPoP / proof-of-possession tokens, short token lifetimes, mTLS for system-to-system). v1 inherits the bearer-token threat model; tightening it is future work.

### Per-frame validator

The validator runs inside the existing critical section in `peer_notebook_sync.rs::handle_notebook_doc_frame` between `sync::Message::decode` and `doc.receive_sync_message_recovering`. Same for `peer_runtime_sync.rs` and the presence ingress.

The enforcement primitive must be **pre-apply**, i.e., it must enumerate the changes carried in the decoded `sync::Message` *before* they reach `doc.receive_sync_message_recovering`. The existing `extract_change_actors` in `crates/notebook-doc/src/diff.rs:439` is post-apply: it calls `doc.get_changes(before)` against an already-mutated `AutoCommit`, which would put the trust boundary on the wrong side of the merge.

What's actually on the wire is uncomfortable. `automerge::sync::Message.changes` is `ChunkList(Vec<Vec<u8>>)`; its `iter()` yields `&[u8]`, not parsed `Change`s. Two cases need handling:

1. **V1**: each chunk is one length-delimited `Change` blob. Parse each via `automerge::Change::try_from(&[u8])` to get an `ActorId` and a `ChangeHash`.
2. **V2**: the `ChunkList` may contain a single chunk that is the output of `Automerge::save()` (a whole-document chunk), used when syncing a large slice of history. Parsing this as a single `Change` fails; it needs the document-chunk parser. See `automerge::sync::Message` docstring at sync.rs:523-528.

The simplest safe approach is: load each chunk into a throwaway `Automerge` peer (`load_incremental`), enumerate the new `Change`s it now holds, and walk their actors. This is correct for both V1 and V2 but allocates a temporary doc per frame.

The cheaper approach for V1-only deployments is to parse each chunk directly as a `Change`. If we keep V1 as the default wire format for hosted rooms initially (which we can, since both sides are our code), the throwaway-peer path is the fallback for V2 capability negotiation.

Either way, the validator must also **filter changes already present in the room by hash** before checking authorship. Heads/have negotiation should prevent re-sending known changes in normal sync, but a reconnecting peer or a peer-state reset can cause legitimate replays. Skipping known-hash changes avoids false rejections.

### Prior art and why we still need a new helper

Three adjacent efforts in the Automerge ecosystem are worth naming, because two of them are easy to confuse with this work and one is genuinely orthogonal.

- **Automerge `filters` branch** (`origin/filters` in `automerge/automerge`, post-peer-review at the time of writing, see `rust/automerge/src/filter.rs`). Adds a persistent visibility filter with three rule types: `Allow`, `AllowUpTo { heads }`, `Deny`, scoped per-actor / per-author / document-default. **Critical semantic from the docstring:** "Changes that are rejected by the active filter are still ingested and synced to peers — only their effect on the rendered state is suppressed." This is subduction: changes stay in the merkle DAG, they just stop rendering. That is the right primitive for **revocation and audit** (the open follow-up below); it is not the right primitive for our trust gate, which needs to reject changes at the network boundary before they enter the doc at all. The two compose: pre-apply gate prevents storage of unauthorized changes; `Filter` (when it lands in main) gives us a way to hide previously-stored changes from a later-revoked principal without breaking causal integrity.
- **automerge-repo `NetworkAdapter`** has no pre-apply authorization hook. `DocSynchronizer.receiveSyncMessage` applies the raw sync bytes directly. The `senderId` is available but unused for auth. If we adopt automerge-repo at any layer, the gate has to live above the synchronizer (a wrapper or a custom adapter), not inside it.
- **Keyhive** ([inkandswitch/keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)) is orthogonal: capability-token access control and end-to-end encryption with signed changes. Our trust gate is connection-level (the server enforces who can author what); keyhive is change-level (the change itself carries a capability). They compose cleanly if we ever need E2EE or cross-host capability delegation, but neither replaces the other. v1 does not adopt keyhive.

The pre-apply helper we need does not exist upstream. It is a candidate for an Automerge contribution (a hook on `receive_sync_message`, or a public `parse_change_chunks` that handles V1 and V2 chunk shapes safely). Until then, the helper lives in our tree:

```rust
// new helper, location TBD: notebook-doc::diff, runtime-doc, or nteract-room-host
pub fn sync_message_new_changes(
    msg: &automerge::sync::Message,
    have_hashes: &std::collections::HashSet<automerge::ChangeHash>,
) -> Result<Vec<(automerge::ActorId, automerge::ChangeHash)>, ParseError>;
```

The validator then runs strictly before `receive_sync_message_recovering`:

```rust
// inside nteract-room-host
impl AuthenticatedConnection {
    pub fn validate_sync_message(
        &self,
        msg: &automerge::sync::Message,
        room_known_hashes: &HashSet<ChangeHash>,
    ) -> Result<(), UnauthorizedActor> {
        for (actor_id, _hash) in sync_message_new_changes(msg, room_known_hashes)? {
            let label = ActorLabel::from_actor_id(&actor_id);
            if label.is_genesis_schema_seed() {
                return Err(UnauthorizedActor::ReservedGenesis(label));
            }
            if label.principal() != self.principal.as_str() {
                return Err(UnauthorizedActor::PrincipalMismatch {
                    expected: self.principal.clone(),
                    got: label.principal().to_string(),
                });
            }
        }
        Ok(())
    }
}
```

`extract_change_actors` is kept for what it was built for (post-apply attribution into `TextAttribution`). It is **not** an enforcement primitive; the two helpers sit on different sides of the merge and have different signatures.

### Frozen genesis actors

The seed actors that establish the frozen genesis docs are not principal-prefixed:

- `nteract:notebook-schema:v4` (defined at `crates/notebook-doc/src/lib.rs:79`)
- `nteract:runtime-state-schema:v2` (defined at `crates/runtime-doc/src/doc.rs:318`)

These predate this ADR. They appear only in the immutable genesis bytes that every room loads at construction; they are never authored by a live peer and should never travel inbound over a sync connection (Automerge sync's heads negotiation prevents peers from re-sending changes the room already has).

The validator therefore **rejects** any inbound change whose actor is one of the known genesis labels. This is defensive: legitimate sync never carries them inbound; if one shows up it is either redundant or hostile, and rejecting it is safer than allowing it.

As part of this work, we will make a schema bump (notebook v5, runtime-state v3, etc.) to adopt the new format and use `system/schema:notebook:v5` and `system/schema:runtime-state:v3` so the genesis actors are first-class within the principal model. Migration: regenerate frozen genesis bytes with the new labels at the schema-version bump; existing notebooks keep the legacy labels in their historical changes (immutable in the DAG, never validated inbound).

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
├── lib.rs            # ActorLabel, Principal, AuthenticatedUser, AuthError, Credential, IdentityProvider enum
├── local.rs          # LocalProvider (peer creds)
├── oidc.rs           # OidcProvider (JWKS bearer; configurable for Anaconda, Cloudflare Access, Clerk, Auth0, Okta, WorkOS, generic OIDC)
└── jupyterhub.rs     # JupyterHubProvider (Hub cookie/token via /hub/api/user)
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

1. **Subprotocol smuggling** (the Kubernetes pattern). Client opens `new WebSocket(url, ["bearer.<base64url-token>", "nteract.v4"])`. Server reads `Sec-WebSocket-Protocol`, peels off the `bearer.*` element, validates the decoded token, and echoes back `nteract.v4` as the selected subprotocol. The token is not in the URL, not in the referer, not in server access logs. The token is still visible to any JS in the browser that can construct a WebSocket, which is the same trust boundary every other credential mechanism shares.

2. **One-time ticket**. Client POSTs `/api/session-tickets` with the real bearer (header-set, normal CORS). Server returns a short-lived (~10s, single-use) ticket. Client opens `wss://host/n/<id>?ticket=<one-time>`. Server validates the ticket, consumes it, and the connection is authenticated as the original user. The real bearer never appears in the WebSocket URL. Costs one extra round trip; the server tracks outstanding tickets in memory or D1.

3. **Cookie**. Browsers send cookies automatically on the WS upgrade when same-site (or with the right CORS dance). This is the path JupyterHub already provides because Hub login issues a signed session cookie. No client code needed.

4. **`Authorization` header** (system-to-system only). Native clients (desktop daemon, agents, CLI) set `Authorization: Bearer ...` directly on the upgrade request. Browsers cannot. This is the trivial path for the desktop daemon connecting to an Anaconda-hosted or JupyterHub-hosted room on the user's behalf.

Recommendation by provider:

| Provider | Browser clients | System clients |
|----------|-----------------|----------------|
| `Oidc` (Anaconda, Cloudflare Access, Clerk, ...) | Subprotocol smuggling; tickets as a deployment opt-in for high-security setups | `Authorization` header |
| `JupyterHub` | Cookie (Hub already issues one) | `Authorization` header with Hub-issued token |
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
  - Note on the upstream Automerge `read_only` API: `State::new_read_only()` and `MessageFlags::READ_ONLY` are **not** the right primitive here. Upstream `read_only` means "the holder of this state will not apply incoming changes but will still send its own" (publish-only semantics; see `rust/automerge/src/sync.rs:408` and `rust/automerge/src/sync/state.rs:65-67`). The viewer's read-only-ness is a server-side authorization policy enforced at ingress, not an Automerge sync-state mode.
- `editor` - full live edit on `NotebookDoc`, plus a narrow allowed-write surface on `RuntimeStateDoc` for widget comm state. The widget surface is `doc.comms/*/state/*`, mediated client-side by the approved comm writer (`apps/notebook/src/App.tsx:465-477`, `set_comm_state_batch` + `triggerSync`). The daemon already accepts these writes (`crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`). Outside that subtree, editor `RuntimeStateDoc` writes are rejected. v1 enforces the subtree client-side (via the comm-writer interface) and at the server only by scope; path-level server enforcement of the `doc.comms/*/state/*` subtree is future hardening.
- `runtime_peer` - permitted to write `RuntimeStateDoc` and emit kernel lifecycle broadcasts. Cannot edit `NotebookDoc`. Used by future remote-runtime services and by JupyterHub-spawned room-hosts when they connect a kernel.
- `owner` - editor plus publish-revisions and manage-ACL requests.

### Where scope comes from

Scope is determined by intersecting two sources: what the IdP says about the user (claims/roles in the validated credential) and what the room's ACL says about the principal. The narrower of the two wins. A principal that the IdP marks as `editor` but the ACL marks as `viewer` is a viewer in that room. A principal not present in the ACL at all is rejected at connection time (or downgraded to anonymous viewer if the ACL contains a public-read entry).

### Scope enforcement points

Scope is enforced server-side at three points, each with a clear boundary:

1. **Frame ingress** (in `peer_notebook_sync.rs::handle_notebook_doc_frame` and equivalents): the validator already runs here. Extend it to consult `AuthenticatedConnection.scope` and reject frames that exceed the scope: viewer with non-empty changes on any doc, runtime_peer sending changes to `NotebookDoc`. Editor writes pass at the frame layer for both docs; the `RuntimeStateDoc` subtree restriction is enforced client-side via the comm-writer interface in v1 and is a candidate for server-side path enforcement later.
2. **Request dispatch**: each `NotebookRequest` variant declares its minimum required scope via an annotation or registry lookup. The request handler rejects with a typed `Unauthorized` response before any side effect. New scope-gated requests declare their requirement at the definition site; no scattered `if scope == ...` checks elsewhere.
3. **ACL mutations** are owner-only. The room-host enforces this at the request-dispatch layer; no in-band ACL change is honored from a non-owner connection.

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

- **Trust is honest.** A hosted deployment never carries Automerge attribution outside its own scope. Cross-IdP forgery is impossible because the destination simply does not accept foreign actor labels.
- **History is lost on publish.** Anyone who needs the pre-publish authorship trail keeps the source notebook around (it still lives in the source space). Re-publishing produces a new snapshot in the destination; old snapshots are immutable revisions.
- **Future cryptographic verification.** When Automerge gains signed-change support (keyhive direction; see `https://www.inkandswitch.com/keyhive/notebook/`), historical authorship from a source space could be carried across publish if every historical change is signed by its claimed author. Until then, this ADR closes the door on cross-space attribution.

## Migration

The repo currently persists `.automerge` only for untitled ephemeral notebooks. No production-shipped notebook has long-lived Automerge actor labels in the legacy format. The new `<principal>/<operator>` format is adopted from day one of the change. Old in-memory actor labels in current sessions get replaced on next daemon restart; nothing on disk to migrate.

## What this leaves open

These follow-up ADRs and design decisions are tracked but not decided here:

1. **Room-host crate extraction.** Pulling `runtimed::notebook_sync_server::room` into `nteract-room-host` with pluggable `Listener` and `SnapshotStore` traits. Tracked in a separate ADR.
2. **Identity provider selection for Anaconda hosted v1.** Likely OIDC against Anaconda's existing SSO. Confirmed when the runtimed.com prototype lands.
3. **Anonymous viewer scope.** Whether read-only public publish URLs require a session or run un-authenticated under a synthetic `system:anonymous` principal.
4. **Revocation signal and historical-change subduction.** Two parts. First, the wire signal: the exact `SESSION_CONTROL` close frame and the channel for admin revokes / plan downgrades. Second, what happens to changes a revoked principal already authored. The Automerge `filters` work (`origin/filters` branch, `rust/automerge/src/filter.rs`) is the natural primitive: install a `Filter::with_author(revoked, Rule::AllowUpTo { heads: validated })` to subduct edits authored after revocation while keeping causal integrity intact. Wait for `filters` to land in main before depending on it; until then, revocation is a hard connection close with no post-hoc audit hiding.
5. **Connection-scope field on the wire.** Optional handshake response field so UIs can render "read-only" badges without inferring from request failures.
6. **Federation.** A notebook host trusting another notebook host's identity claims (e.g., JupyterHub Anaconda interop). Not v1.
7. **`runtime_peer` connection topology.** Whether the kernel sidecar connects to the room directly with its own `runtime_peer` scope credential, or whether a separate runtime-coordination protocol relays writes. Tied to the future remote-runtime work.
8. **Deployment topology.** How clients reach rooms (browser-direct WebSocket, local-daemon proxy, native client), where kernels run, TLS/CORS, credential keyring placement. Drafted in `docs/architecture/deployment-topology.md`.
9. **ACL mechanics.** Editing semantics, owner transfer, group/org principals, anonymous public-read entries, persistence layout. Drafted in a separate ACL ADR (to be written).
10. **Signed-change authorship across publish.** When Automerge gains signed changes (keyhive direction), publish flows could carry historical authorship across identity spaces with cryptographic verification. Until then, publish produces a fresh document in the destination space (see Decision 6).
11. **Bearer-token replay mitigation.** DPoP / proof-of-possession tokens, mTLS for system-to-system, short token lifetimes. v1 inherits the bearer-token threat model; tightening it is future work.

## Worked examples

### quill editing a local untitled notebook

- Unix socket connect. Listener reads `SO_PEERCRED`, finds OS user `quill`. `IdentityProvider::Local(...)` returns principal `local:quill`, scope `owner`.
- Desktop UI opens the notebook via the daemon. Daemon stands up a WASM peer with actor `local:quill/desktop:7f3a`.
- Claude (via MCP) joins the same room from the same machine. Claude's MCP process connects on the same Unix socket; its principal is also `local:quill`. It picks operator `agent:claude:s1`. Actor label `local:quill/agent:claude:s1`.
- Both connections write changes. Validator checks `principal == "local:quill"` on every incoming change. Passes for both.
- Presence shows two operators under one principal. UI can render "quill (Desktop)" and "quill (Claude)" by reading the operator suffix.

### quill editing an Anaconda-hosted notebook

- quill's client opens an authenticated connection to the Anaconda-hosted room. The transport (browser-direct WebSocket, local-daemon proxy, native client, etc.) is a deployment-topology concern, separate from identity.
- Anaconda's room-host validates the credential. Returns principal `user:anaconda:550e...`. Looks the principal up in the room's ACL, finds scope `editor`.
- The client stands up a WASM peer in the hosted room with actor `user:anaconda:550e.../desktop:7f3a`.
- Edits flow over the established connection. The room's validator checks `principal == "user:anaconda:550e..."` on every incoming change. Passes.
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

**Sync messages enumerate new changes pre-apply, with chunk parsing required.** `automerge::sync::Message.changes` is `ChunkList(Vec<Vec<u8>>)` (raw chunk bytes), not pre-parsed `Change`s. The validator parses each chunk (V1: one `Change` per chunk via `Change::try_from`; V2: whole-doc chunks may need `load_incremental` into a throwaway peer), subtracts changes already present in the room by hash, and only then walks the actor IDs of the genuinely new changes. The validator runs before `receive_sync_message`. Compatible with the underlying Automerge sync surface; the missing helper (`sync_message_new_changes`) is a candidate for upstream contribution.

**Hash-pinned history is immutable.** Each `Change` references its parents by hash. A peer cannot rewrite history without changing every downstream hash, which then fails the room's existing heads check. The validator only needs to guard *new* changes; historical changes are protected by hash chaining. Compatible.

**automerge-repo's transport-layer trust model matches ours.** automerge-repo network adapters (WebSocket, BroadcastChannel, etc.) treat identity as a transport concern; the document layer assumes peers handed up by the adapter are legitimate. Per-room identity, connect-time auth, and per-frame actor validation slot in at the adapter/listener boundary. Compatible.

**Ephemeral messages stay separate.** automerge-repo's ephemeral messages (presence-like) are out-of-band from doc state. Our presence frames (`0x04`) follow the same shape. The per-ingress rewrite of the principal prefix in presence is a server-side policy, not a CRDT operation; it does not enter the Automerge DAG. Compatible.

**`set_actor` mid-session is allowed by Automerge but discouraged by us.** Automerge supports calling `set_actor` to change the actor used for subsequent changes. The trust model treats actor labels as a per-connection invariant: the operator suffix is fixed at WASM-peer construction time and not changed for the connection's life. Clients that want to write under a new operator open a new connection. This is a discipline, not an Automerge limitation.

**One place where Automerge defaults differ from ours.** Out of the box, Automerge generates a random `ActorId` per `AutoCommit`. Our code overrides this with a human-readable label (`crates/notebook-doc/src/lib.rs:486-505`). The trust model continues that override and extends the label format. No change to Automerge's wire shape.

## References

- `crates/notebook-wire/AGENTS.md` - frame types and v4 wire details.
- `crates/notebook-protocol/src/connection/handshake.rs` - handshake shape.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` - where the per-frame validator hooks in.
- `crates/notebook-doc/src/diff.rs:439` - `extract_change_actors`, the post-apply attribution primitive feeding `TextAttribution`. Distinct from the pre-apply enforcement primitive this ADR specifies (`sync_message_new_changes`).
- `automerge::sync::Message` (rust/automerge/src/sync.rs:516-588) - the `ChunkList` wire shape backing per-frame validation.
- `crates/notebook-doc/src/presence.rs` - presence frame shape.
- intheloop `backend/auth.ts`, `backend/sync.ts` - bearer-JWT validation + connection-time auth model.
- runtimed/anaconda `api_key.ts` - Anaconda userinfo validation + scope mapping.
- JupyterHub `jupyterhub/services/auth.py` - Hub cookie/token validation, no `X-Forwarded-User`.
- Automerge `filters` branch (`origin/filters` on `automerge/automerge`), specifically `rust/automerge/src/filter.rs` - the subduction primitive that complements (but does not replace) our pre-apply gate, and the natural home for runtime revocation.
- automerge-repo `DocSynchronizer.receiveSyncMessage` and `NetworkAdapterInterface` - confirms there is no built-in per-message authorization hook; any gate has to sit above the synchronizer.
- Keyhive notebook: https://www.inkandswitch.com/keyhive/notebook/ - capability + E2EE; orthogonal to connection-level trust, composable later.
