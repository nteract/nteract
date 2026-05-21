# Identity and Trust for nteract Notebook Rooms

**Status:** Accepted, 2026-05-21.
**Supersedes:** drafts at #2657 (web-sync-engine architecture) and #2761 (SwiftUI viewer + bearer-token endpoint). Both can be closed when this ADR lands.

## Context

`NotebookDoc` and `RuntimeStateDoc` sync between peers via typed-frame v4 over a Unix socket today, with same-UID trust covering attribution. We want to extend the same protocol to hosted multi-user rooms (Anaconda hosted, JupyterHub-spawned, future deployments) without forking the wire format, and we want every change in the document to carry verifiable authorship.

The hard problem is not the wire. It is identity. Three references shaped this design:

- **intheloop** validates an OIDC bearer JWT via JWKS at WebSocket open. The validated `sub` claim becomes the actor identifier. No per-message re-validation.
- **runtimed/anaconda** validates bearer tokens against Anaconda's userinfo endpoint and maps Anaconda scopes to runtimed scopes.
- **JupyterHub** stamps spawned single-user servers via environment variables at launch, and the spawned server validates user identity by calling back to `/hub/api/user`. No `X-Forwarded-User` header is trusted.

All three converge on the same rule: **never trust a locally-stamped identity claim; validate against the upstream authority that issued the credential.** This ADR adopts that rule.

The other recurring theme from this design discussion: nteract's world is agent-centric. A human user has many operators acting on their behalf - desktop, TUI, Claude via MCP, Codex, future agents - all of them legitimately authoring edits "as" the user. Attribution needs to distinguish operators while the trust gate enforces the user.

## Decision 1: Two-layer actor labels

Every Automerge actor label is a string of the form:

```
<principal>/<operator>
```

- **Principal**: the authenticated entity. Format: `<scheme>:<scheme-specific-id>`. Examples: `local:kylekelley`, `user:anaconda:550e8400-e29b-41d4-a716-446655440000`, `hub:hub.example.com:alice`, `system`.
- **Operator**: the thing doing the work right now, on behalf of the principal. Self-declared by the connecting client. Convention: `<kind>:<vendor?>:<session-uuid>`. Examples: `desktop:7f3a`, `tui:9d2b`, `agent:claude:s1`, `agent:codex:s2`, `runtime:py-3.12-s4`.

Slash is the delimiter, taken on the first occurrence. If a principal ever contains a literal `/` it is percent-encoded; in practice this does not arise (UUIDs, hostnames, and usernames don't contain slashes).

An `ActorLabel` newtype with `principal()` and `operator()` accessors lives in the new `nteract-identity` crate. Existing code that treats the label as an opaque string keeps working; code that wants the breakdown adopts the newtype.

Worked examples are at the end of this document.

### Why two layers

The principal is what the trust gate enforces. The operator is what attribution distinguishes. Conflating them - as today's `agent:claude:abc123` does - makes "Claude on kylekelley's machine" indistinguishable from "Claude on someone else's machine" and forces the trust gate into either case-by-case rules or implicit trust of operator names.

Two layers also matches reality: operators are processes, principals are accounts. Unix already works this way. Audit logs in well-designed systems already work this way.

## Decision 2: Identity space is per-room

Each notebook room belongs to exactly one identity space, determined by its host:

- A room served by the local daemon: identity space is `local:*`. Principal derived from peer credentials on the listening socket.
- A room served by Anaconda hosted: identity space is `user:anaconda:*` for human users, plus `system` for seed actors. Principal derived from validated Anaconda credential.
- A room served by a JupyterHub-spawned host: identity space is `hub:<hub-domain>:*`. Principal derived from validated Hub token/cookie.

A connection to a room is authenticated into that room's space. The principal returned by authentication is in the room's namespace, not the client's process namespace. **One client process can hold connections to many rooms in many spaces simultaneously; each connection's principal reflects which room and how it authenticated, not which host it lives on.**

The validator on a room only accepts NEW changes whose actor principal matches the connection's authenticated principal (or the system seed). Historical changes already in the doc are not re-validated; they're part of the merkle DAG and immutable.

### Cross-space scenarios

When kylekelley uses his desktop to edit an Anaconda-hosted notebook, his local daemon holds an Anaconda credential (an API key in the daemon's keyring). The daemon opens an authenticated WebSocket to the Anaconda room using that credential. Anaconda validates the key, returns "you are `user:anaconda:550e...`". The daemon stands up a WASM peer in that room with actor label `user:anaconda:550e.../desktop:<session>`.

The desktop UI process is unaware that the room is remote. It receives frames from the daemon over the existing Tauri channel. When it asks the daemon "what's my actor for this room?", the daemon answers with the Anaconda-prefixed label. The UI's WASM peer authors changes under that label. From the Anaconda room's perspective, every edit kylekelley's desktop sends is a valid `user:anaconda:550e.../*` actor.

The daemon is a **bridge**, not an identity terminator. It can be a peer in `local:*` rooms for kylekelley's untitled scratch notebooks and a peer in `user:anaconda:*` rooms for hosted notebooks at the same time, in the same process.

## Decision 3: Authentication at connect, validation per frame

Authentication is connection-scoped. The IdP is consulted at WebSocket open, never on the sync hot path.

1. Connection opens. Listener extracts the credential (bearer JWT for OIDC/Anaconda, cookie/OAuth token for JupyterHub, peer creds for Unix socket).
2. Identity provider validates the credential. One round-trip (JWKS fetch for OIDC is cached; `/hub/api/user` for JupyterHub; userinfo for Anaconda).
3. Validation yields an `AuthenticatedConnection { principal, scope, allowed_operator_kinds }`.
4. Handshake response includes the assembled actor label so the client knows what to author as.
5. Every subsequent frame is validated against the in-memory `AuthenticatedConnection`. No IdP calls.

If the credential expires while connected, the connection stays open. Revocation is future work: a server-pushed `SESSION_CONTROL` close frame ends affected connections when an out-of-band signal (admin revoke, plan downgrade, sign-out) arrives. v1 assumes that anyone who authenticated continues to have access for the connection's lifetime.

### Per-frame validator

The validator runs inside the existing critical section in `peer_notebook_sync.rs::handle_notebook_doc_frame` between `sync::Message::decode` and `doc.receive_sync_message_recovering`. Same for `peer_runtime_sync.rs` and the presence ingress.

```rust
// inside nteract-room-host
impl AuthenticatedConnection {
    pub fn validate_sync_message(&self, msg: &sync::Message) -> Result<(), UnauthorizedActor> {
        for change in msg.changes() {
            let actor = ActorLabel::from_id(change.actor_id());
            if actor.principal() == "system" { continue; }
            if actor.principal() != self.principal.as_str() {
                return Err(UnauthorizedActor {
                    expected: self.principal.clone(),
                    got: actor.principal().to_string(),
                });
            }
        }
        Ok(())
    }
}
```

`extract_change_actors` at `crates/notebook-doc/src/diff.rs:439` already walks the change actors for attribution. The validator is the same primitive used for enforcement instead of display. Cost is microseconds per frame, no I/O, no extra locks.

### Presence rewrite

Presence frames carry `peer_id`, `peer_label`, and `actor_label`, all self-declared today. On ingress:

- Overwrite the **principal prefix** of `actor_label` with the connection's authenticated principal. Always.
- Pass the **operator suffix** of `actor_label` through unchanged. The client picks its own operator name.
- Pass `peer_label` (display name) through unchanged. It's UI text.

No validation, no rejection. Just rewrite. Cheap and unforgeable.

## Decision 4: Credentials and identity providers are separate concerns

Two pluggable traits, two separate crates:

**Server-side: enum dispatch** (in `nteract-identity`)

The provider set is small and closed; OIDC covers a broad collection of issuers (Anaconda, Cloudflare Access, Clerk, Auth0, Okta, WorkOS, generic OIDC) through configuration alone. The enum makes "which providers this build knows about" explicit in the type system, costs nothing at runtime, and avoids the `dyn`-incompatibility of Return-Position-`impl Trait`-in-Traits.

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

Each variant's inner provider exposes its own `authenticate` as RPITIT with `+ Send`, matching the repo's existing convention (`crates/runtimed/src/kernel_connection.rs:80-98`). No `async_trait` boxing.

Implementations live in their own crates so the daemon and the Worker can each pick a subset:

- `nteract-identity-local` (peer creds, used by the desktop daemon)
- `nteract-identity-oidc` (JWKS bearer, configurable issuer / scope mapping; this is how Anaconda gets covered, since Anaconda is OIDC underneath with a specific issuer URL and scope translation)
- `nteract-identity-jupyterhub` (Hub cookie/token validated against `/hub/api/user`)

Each implementation crate is testable in isolation against fixture credentials and a fake IdP. None of them depend on `runtimed`, `kernel-env`, or any daemon internals.

**Client-side: `Credential` keyring**

A small client-side keyring (proposed crate: `nteract-credentials`) holds per-host credentials. Stored encrypted at rest, looked up by room host when the daemon (or any client) needs to authenticate into a remote room. Separate from the IdP because the IdP doesn't care where the credential came from; the keyring doesn't care how it's validated.

The desktop daemon's keyring grows entries like:

```
runtimed.com           -> AnacondaApiKey { token: "..." }
hub.example.com        -> JupyterHubToken { token: "...", expires_at: ... }
local-socket           -> (none, peer creds used)
```

A user adds an entry once (paste a key, OAuth flow, JupyterHub session forward) and any subsequent room-open against that host uses it.

## Decision 5: Four scopes

A connection carries a scope determined by the identity provider:

- `viewer` - receives sync, presence, and session-control frames. Outbound `0x00` (NotebookDoc) and `0x05` (RuntimeStateDoc) frames rejected. Requests limited to read-only.
- `editor` - full live edit. Today's desktop peer.
- `runtime_peer` - permitted to write `RuntimeStateDoc` and emit kernel lifecycle broadcasts. Cannot edit `NotebookDoc`. Used by future remote-runtime services and by JupyterHub-spawned room-hosts when they connect a kernel.
- `owner` - editor plus publish-revisions and manage-ACLs requests.

Scope is determined by the IdP at authentication. It does not need to be conveyed on the wire today; it's enforced server-side. A future protocol extension may add a `connection_scope` field to the handshake response so the client can surface scope to the UI.

## Decision 6: Publish is import, not transformation

A publish operation copies a notebook from one identity space into another. The Automerge changes carry whatever actor labels were on them when authored. The destination room's validator does not re-validate historical changes; they're part of the merkle DAG and immutable.

Concretely: kylekelley publishes a local untitled notebook to Anaconda.

1. Daemon collects current `NotebookDoc` heads and `RuntimeStateDoc` heads from the local room.
2. Daemon saves both docs, writes them to R2 under `n/<id>/snapshots/<headsHash>.am`.
3. Walk blob references using the existing GC walker, upload missing blobs by SHA-256 hash.
4. Insert a `notebook_revisions` row in D1, update `notebooks.latest_revision_id`.
5. Anaconda's room for that notebook now exists. Its history contains changes with actor labels like `local:kylekelley/desktop:abc`. Those labels are preserved exactly.
6. The first post-publish edit, made via Anaconda's room, uses actor `user:anaconda:550e.../desktop:def`.

Attribution naturally shows the transition: pre-publish edits attributed to `local:kylekelley`, post-publish edits attributed to `user:anaconda:550e...`. This is honest about when each edit was made and in which trust context.

An optional "squash on publish" mode (collapse to a single fresh-doc snapshot with one synthetic publisher actor) is a future feature, not a default.

## Migration

The repo currently persists `.automerge` only for untitled ephemeral notebooks. No production-shipped notebook has long-lived Automerge actor labels in the legacy format. The new `<principal>/<operator>` format is adopted from day one of the change. Old in-memory actor labels in current sessions get replaced on next daemon restart; nothing on disk to migrate.

## What this leaves open

These follow-up ADRs and design decisions are tracked but not decided here:

1. **Room-host crate extraction.** Pulling `runtimed::notebook_sync_server::room` into `nteract-room-host` with pluggable `Listener` and `SnapshotStore` traits. Tracked in a separate ADR.
2. **Identity provider selection for Anaconda hosted v1.** Likely OIDC against Anaconda's existing SSO. Confirmed when the runtimed.com prototype lands.
3. **Anonymous viewer scope.** Whether read-only public publish URLs require a session or run un-authenticated under a synthetic `system:anonymous` principal.
4. **Revocation signal.** The exact `SESSION_CONTROL` close frame and the channel for admin revokes / plan downgrades.
5. **Connection-scope field on the wire.** Optional handshake response field so UIs can render "read-only" badges without inferring from request failures.
6. **Federation.** A notebook host trusting another notebook host's identity claims (e.g., JupyterHub Anaconda interop). Not v1.
7. **`runtime_peer` connection topology.** Whether the kernel sidecar connects to the room directly with its own `runtime_peer` scope credential, or whether a separate runtime-coordination protocol relays writes. Tied to the future remote-runtime work.

## Worked examples

### kylekelley editing a local untitled notebook

- Unix socket connect. Listener reads `SO_PEERCRED`, finds OS user `kylekelley`. `IdentityProvider::Local(...)` returns principal `local:kylekelley`, scope `owner`.
- Desktop UI opens the notebook via the daemon. Daemon stands up a WASM peer with actor `local:kylekelley/desktop:7f3a`.
- Claude (via MCP) joins the same room from the same machine. Claude's MCP process connects on the same Unix socket; its principal is also `local:kylekelley`. It picks operator `agent:claude:s1`. Actor label `local:kylekelley/agent:claude:s1`.
- Both connections write changes. Validator checks `principal == "local:kylekelley"` on every incoming change. Passes for both.
- Presence shows two operators under one principal. UI can render "kylekelley (Desktop)" and "kylekelley (Claude)" by reading the operator suffix.

### kylekelley editing an Anaconda-hosted notebook from desktop

- Desktop UI requests `anaconda://runtimed.com/n/<id>`.
- Daemon looks up the Anaconda credential for `runtimed.com` in its keyring. Finds an API key.
- Daemon opens WebSocket to `wss://runtimed.com/n/<id>`. Presents the key as `Authorization: Bearer ...`.
- Anaconda's room-host validates the key against Anaconda's userinfo. Returns principal `user:anaconda:550e...`, scope `editor`.
- Daemon stands up a WASM peer in the hosted room with actor `user:anaconda:550e.../desktop:7f3a`.
- Edits flow desktop UI -> daemon -> WebSocket -> Anaconda room. Anaconda's validator checks `principal == "user:anaconda:550e..."` on every incoming change. Passes.
- Same desktop simultaneously has an untitled local notebook open under `local:kylekelley/desktop:abc`. Two rooms, two identity spaces, one process.

### Claude editing the Anaconda-hosted notebook on kylekelley's behalf

- kylekelley's Claude (running locally) wants to edit the hosted notebook.
- Two paths:
  - Path A: Claude talks to the local runtimed daemon, which already holds the Anaconda credential. The daemon's hosted-room connection is shared; Claude joins as a second operator on the same daemon-side WASM peer? No - one operator per connection. Cleaner path:
  - Path B: Claude's MCP process opens its own connection to the hosted room. It needs a credential. Options: re-use the daemon's keyring (the daemon mints a derived credential and hands it to Claude for the duration of the session), or Claude has its own keyring entry. Both are valid; default to re-using the daemon's via a local credential broker.
- Either way, Claude's connection authenticates as `user:anaconda:550e...`, with operator `agent:claude:s1`. Edits flow as `user:anaconda:550e.../agent:claude:s1`. Same principal, different operator.

### Publishing the local notebook to Anaconda

- kylekelley triggers "publish to Anaconda" from desktop.
- Daemon saves local `NotebookDoc` and `RuntimeStateDoc` bytes, computes blob references via the existing GC walker.
- Daemon uses the Anaconda credential to push snapshots to R2 and metadata to D1 via Anaconda's publish API.
- Historical changes in the snapshot carry `local:kylekelley/*` labels. They are preserved.
- A new room is now visible at `runtimed.com/n/<id>`. Opening it from any client follows the "editing an Anaconda-hosted notebook" path. New edits use `user:anaconda:550e.../*`. The notebook's history shows the publish transition.

## References

- `crates/notebook-wire/AGENTS.md` - frame types and v4 wire details.
- `crates/notebook-protocol/src/connection/handshake.rs` - handshake shape.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` - where the per-frame validator hooks in.
- `crates/notebook-doc/src/diff.rs:439` - `extract_change_actors`, the primitive for both attribution and enforcement.
- `crates/notebook-doc/src/presence.rs` - presence frame shape.
- intheloop `backend/auth.ts`, `backend/sync.ts` - bearer-JWT validation + connection-time auth model.
- runtimed/anaconda `api_key.ts` - Anaconda userinfo validation + scope mapping.
- JupyterHub `jupyterhub/services/auth.py` - Hub cookie/token validation, no `X-Forwarded-User`.
