# Identity and Trust for nteract Notebook Rooms

**Status:** Accepted, 2026-05-21.
**Replaces:** drafts at #2657 (web-sync-engine architecture) and #2761 (SwiftUI viewer + bearer-token endpoint), both since closed.

## Context

`NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and `CommentsDoc` sync between local peers over a Unix socket using typed-frame v4 and same-UID trust. Extending that protocol to hosted multi-user rooms (Anaconda hosted, JupyterHub-backed compute, and future deployments) requires verifiable authorship without forking the wire format.

Three existing systems shape this design:

- **[`runtimed/intheloop`](https://github.com/runtimed/intheloop):** validates an OIDC bearer JWT via JWKS at WebSocket open. The validated `sub` claim becomes the actor identifier, with no per-message re-validation.
- **[`runtimed/anaconda`](https://github.com/runtimed/anaconda):** validates bearer tokens against Anaconda's userinfo endpoint and maps Anaconda scopes to runtimed scopes.
- **JupyterHub:** stamps spawned single-user servers via environment variables at launch. The server validates user identity by calling `/hub/api/user` and never trusts an `X-Forwarded-User` header.

Our core rule follows directly: never trust a locally stamped identity claim. Always validate credentials against the issuing upstream authority.

nteract is also agent-centric. One human user often runs several operators under the same principal: Desktop, a TUI, MCP agents, `runtimed` bindings, and scheduled notebook jobs. All of them legitimately author edits as that user. Attribution must separate operators while the trust gate enforces the user principal.

## Decision 1: Two-layer actor labels

Every Automerge actor label uses the format:

```text
<principal>/<operator>
```

- **Principal:** the authenticated entity, formatted as `<scheme>:<scheme-specific-id>` (or the reserved literal `system`). Examples: `local:quill`, `user:anaconda:550e8400-e29b-41d4-a716-446655440000`, `hub:hub.2i2c.mybinder.org:rgbkrk-notebooks-i28hqg97`, `system`.
- **Operator:** connection- or import-scoped attribution declared by the initiating client. Convention: `<kind>[:<declared-label>]:<nonce>`. Examples: `desktop:7f3a`, `tui:9d2b`, `agent:claude:s1`, `agent:codex:s2`, `runtime:python:s4`. The optional label is opaque and may name an application, agent, model family, harness, or runtime; it is not a closed taxonomy.

The first `/` is the delimiter. Any literal `/` inside a principal is percent-encoded; in practice, UUIDs, hostnames, and usernames do not contain slashes.

The `ActorLabel` newtype (with `principal()` and `operator()` accessors) lives in the `nteract-identity` crate. Code that treats labels as opaque strings keeps working, while code needing the breakdown adopts the newtype.

The principal is the security boundary. The room host's configured identity provider verifies it, qualifies it by namespace, and matches it against the room ACL.

The operator is connection-scoped attribution, not authentication. The host may syntax-check it and restrict allowed operator kinds per credential class, but an operator string never proves the process is truly Desktop, Codex, Claude, or Python. UIs may render operator kind as an attribution hint; authorization must use the authenticated principal and scope.

`agent` is an open operator kind, not a product-specific identity class:

- Any agent product, model-serving client, orchestration harness, MCP client, or custom integration uses the same contract.
- Its declared label names whichever agent, model family, harness, or product helps attribution.
- Exact model IDs, providers, versions, and richer provenance stay in separate non-authorizing audit or display metadata. Those claims are advisory unless independently attested.
- None of those fields becomes the principal or creates a special connection topology.

See [Worked examples](#worked-examples) at the end of this document.

### Why two layers

The principal drives the trust gate; the operator drives attribution. Legacy operator-only labels like `agent:claude:abc123` conflated the two, making "Claude on quill's machine" indistinguishable from "Claude on someone else's machine" and forcing case-by-case trust rules.

The split mirrors Unix: principals are accounts, and operators are processes. It also gives audit logs a clean security-vs-attribution boundary.

## Decision 2: Rooms are entities; access is a per-room ACL

A notebook room is an independent entity addressed by a room locator:

- `local-daemon:<uuid>` or `local-daemon:<path>` for rooms served by the local daemon.
- `runtimed.com/n/<uuid>` (or similar) for Anaconda-hosted rooms.
- `hub.example.com/<user>/n/<uuid>` only when that Hub deployment explicitly runs the room host. A JupyterHub runtime sidecar attached to an Anaconda-hosted room is not encoded in the locator.

The locator states *where to reach the room host*, not *who can access it*, where compute runs, or which blob store holds outputs. The room host is the live document authority for `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`. A **per-room ACL** maps principals to scopes:

```yaml
room: runtimed.com/n/9f3a...
acl:
  - principal: user:anaconda:550e...           scope: owner
  - principal: user:anaconda:6611...           scope: editor
  - principal: hub:hub.2i2c.org:rgbkrk         scope: viewer
```

An ACL can reference principals from any identity provider (IdP) the host validates against. v1 deployments typically use one IdP per host by convention, not protocol constraint. Cross-provider federation means the room host validates each credential against its configured upstream provider and produces a namespace-qualified principal in the same ACL space. Desktop and browsers never translate local display identity into a remote principal on their own.

Three properties follow:

1. **Locators survive ownership changes.** Changing the owner mutates the ACL, not the locator, so existing links keep working.
2. **Rooms can mix principals across IdPs.** Cross-IdP collaboration (for example, sharing an Anaconda-hosted room with a JupyterHub user) is a deployment choice, not a protocol change.
3. **Organizational principals fit cleanly later.** Groups or orgs (such as `org:acme:engineering`) slot into the ACL as new principal kinds without wire or validator changes.

### How authentication interacts with the ACL

1. A connection opens. The listener extracts a credential; the IdP validates it and yields a principal.
2. The room host looks up that principal in the room ACL.
3. If present, the connection inherits the ACL scope; otherwise it is rejected. Unauthenticated requests may receive anonymous `viewer` scope only when the room has a public-read ACL entry.
4. `AuthenticatedConnection` carries that principal and scope for the socket's lifetime.

Rooms are no longer scoped to one IdP's principal space; the per-room ACL is the single source of truth. In v1, the host enforces per-frame actor labels with a clone-preview validator before applying inbound `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` sync frames. The Automerge fork patch in `docs/memos/automerge-fork-patches.md` is the planned lower-cost replacement.

### Federated principal display

The principal ID is stable, namespace-qualified, and verified. Display metadata is separate and advisory. A local Desktop room may project `local:kylekelley` as `Kyle Kelley`, while an Anaconda-hosted room projects `user:anaconda:550e...` with the same display name. Those remain distinct principals unless a future account-linking layer explicitly joins them.

Desktop remote rooms consume the remote host's stamped identity projection. Local daemon credentials prove Desktop can reach the local runtime, while the remote principal comes from the remote service credential (API key, OIDC token, or hosted session). Shared UI must render the host-projected principal, provider namespace, and display label without assuming browser cloud auth is the only remote identity model.

### ACL mechanics

The v1 ACL is a flat table keyed by `(room, subject_kind, subject, scope)`. The hosted Worker prototype persists these rows in D1 as `notebook_acl`:

- Owner-scoped HTTP requests inspect, grant, and revoke individual rows.
- Anonymous public read uses a normal row: `subject_kind = public`, `subject = anonymous`, `scope = viewer`.
- Public rows cannot grant write scopes.
- Removing the final owner row is rejected.

The locked protocol shape is: rooms own ACLs, ACLs reference principals or explicit public-read subjects, hosts validate principals against configured IdPs, and the ACL governs connection scope. Org inheritance, group expansion, owner transfer, audit events, and Zanzibar/Authzed-style relationship evaluation are future layers.

## Decision 3: Authentication at connect, scope checks per frame

Authentication is connection-scoped. The IdP is consulted at WebSocket open, never on the sync hot path.

1. A connection opens. The listener extracts the credential (bearer JWT for OIDC/Anaconda, cookie or OAuth token for JupyterHub, peer credentials for a Unix socket).
2. The IdP validates the credential in one round-trip (cached JWKS for OIDC, `/hub/api/user` for JupyterHub, userinfo for Anaconda).
3. The room host checks the validated principal against the room ACL. Unauthenticated requests get anonymous `viewer` scope only if a public-read entry exists (such as the D1 public-read row in `hosted-room-authorization.md`).
4. Validation yields an in-memory `AuthenticatedConnection { principal, scope, allowed_operator_kinds }` scoped to that socket.
5. The handshake response returns the assembled actor label so the client knows what to author as.
6. Every subsequent frame is checked against `AuthenticatedConnection.scope` for frame type and `Message.changes` emptiness. Non-empty inbound change frames also pass through the clone-preview validator to reject principal forgery before mutating the real document.

If a credential expires mid-connection, the socket stays open in v1. Out-of-band revocation (admin revoke, plan downgrade, sign-out) is future work via a server-pushed `SESSION_CONTROL` close frame.

### What `AuthenticatedConnection` is and is not

`AuthenticatedConnection` is **server-side in-memory state**, owned by the room host and bound to one WebSocket or Unix-socket connection. It is neither a token nor transferable, and clients cannot present it. It is created when auth succeeds and dropped on socket close.

Bearer-token replay is a separate, known property of bearer auth: a stolen JWT lets an attacker open a new socket and obtain their own `AuthenticatedConnection`. Mitigating replay belongs to the credential layer (DPoP / proof-of-possession tokens, short lifetimes, or mTLS for system-to-system links). v1 inherits the standard bearer-token threat model.

### Per-frame sync checks

The room host enforces scope at frame ingress using frame type and change emptiness:

- **`viewer`:** rejects any inbound document sync frame (`0x00`, `0x05`, `0x09`, or `0x0a`) with non-empty `Message.changes`. Empty negotiation frames (`ChunkList::empty()`) pass.
- **`runtime_peer`:** rejects non-empty `0x00` (`NotebookDoc`) frames. Allows `RuntimeStateDoc` writes only for runtime progress and output on already accepted executions, lifecycle state, comm topology, and output routing. Trust, environment, path, save metadata, and project context stay room-host/daemon-owned, and execution intent still goes through `ExecuteCell`/`RunAllCells`. In the hosted prototype, runtime peers use `RuntimeStatePeerHandle` rather than the browser `NotebookHandle`, keeping notebook editing APIs separate.
- **`editor`:** allows `0x00` (`NotebookDoc`) edits within the host's document-write policy, `0x09` (`CommsDoc`) edits for mutable widget comm state (with kernel forwarding gated by `RuntimeStateDoc` comm topology), and `0x0a` (`CommentsDoc`) edits (validating change actors against the connection principal). Rejects `0x05` (`RuntimeStateDoc`) edits; execution, queue, kernel, environment, output, comm topology, and schema/root changes remain runtime-owned.
- **`owner`:** same frame-level document rules as `editor`, plus ACL-mutation requests. Owner scope does not grant arbitrary `RuntimeStateDoc` authorship; runtime progress/output still requires `runtime_peer`, and execution intent still requires the request API.

For every non-empty `NotebookDoc`, `RuntimeStateDoc`, or `CommsDoc` sync message, v1 runs a clone-preview validator:

1. Clone the current Automerge document and sync state.
2. Apply the inbound sync message to the clone.
3. Extract actor labels from the newly applied changes.
4. Reject the frame if any new change's principal differs from `AuthenticatedConnection.principal`.
5. Mutate the real room document only after validation passes.

This stopgap closes live principal forgery in v1 at the cost of cloning and double-applying every non-empty inbound message—most noticeable on high-churn `RuntimeStateDoc` traffic. Patch 1 (`sync_message_new_changes`) in `docs/memos/automerge-fork-patches.md` is the planned v2 replacement that inspects incoming changes without cloning.

### Schema-seed actors are canonical, with principal-prefixed labels as target

The current frozen genesis actors are canonical seed labels, not yet principal-prefixed:

- `nteract:notebook-schema:v5` (`crates/notebook-doc/src/lib.rs`)
- `nteract:runtime-state-schema:v2` (`crates/runtime-doc/src/doc.rs`)
- `nteract:comms-doc-schema:v1` (`crates/runtime-doc/src/comms.rs`)

Because genesis bytes hash-pin these labels, changing them requires a schema/genesis bump rather than a display-only rename. Future schema bumps target `system/schema:notebook:vN` and `system/schema:runtime-state:vN` so schema-authored changes fit natively in the principal model. Existing notebooks keep historical seed labels in their immutable DAGs; new seed labels apply only from fresh genesis bytes.

### Presence rewrite and actor projection

Current presence frames carry `peer_id`, optional `peer_label`, and optional `actor_label` (`crates/notebook-doc/src/presence.rs`). The room host is the authority on peer ID and principal projection. On ingress:

- **`actor_label` present:** overwrite the principal prefix with the connection's authenticated principal; keep the operator suffix.
- **`actor_label` missing:** synthesize one from the authenticated principal plus the handshake-declared operator (or a fallback such as `unknown:<connection-uuid>` built from the listener connection ID).
- **`actor_label` malformed** (no `/`, principal-only, or unrecognized shape): treat as missing and synthesize as above.
- **`peer_label` (display name):** pass through, sanitize, or replace with a display label from authenticated profile metadata. It is UI text, not authority.
- **`peer_id`:** replace or confirm with the room host's transport-scoped peer ID before broadcast. It identifies the connection, not the user.

No presence ingress path lets a client choose its displayed principal. While the wire carries only those three fields, the room host still rewrites them on ingress and shared UI derives a temporary projection from `actor_label`.

The target presence protocol keeps `actor_label` as the stable attribution key and adds a compact host-stamped actor projection to `Update` and `Snapshot` messages so UIs stop parsing raw strings as their primary identity source:

```ts
interface PresenceActorProjection {
  actorLabel: string;
  principal: {
    id: string;
    label?: string;
    imageUrl?: string;
    source?: {
      provider: "local" | "anaconda" | "oidc" | "jupyterhub" | "anonymous" | "dev";
      namespace: string;
    };
  };
  operator: {
    id: string;
    kind: string;
    label?: string;
  };
  scope?: "viewer" | "editor" | "runtime_peer" | "owner";
}
```

`actorLabel` remains the exact `<principal>/<operator>` key for CRDT attribution and color matching. `principal` is verified host state; `operator` is accepted connection attribution. Display strings like `"Codex for Kyle Kelley"` render an agent operator plus a principal without needing an `on_behalf_of` field unless a future feature models multi-principal delegation chains.

Scope does not exclude a viewer from syncing. Authenticated `viewer` peers still receive room updates, send empty negotiation frames, publish presence, and consume the structured actor projection; scope only blocks writes and mutating requests.

One product exception applies to hosted public read: anonymous public viewers have local or aggregate presence only. Their cursor and selection frames are acknowledged locally and are not broadcast as named collaborators unless product policy changes.

`principal.source.provider` names the principal authority for federation and display, never the credential transport. A browser OAuth session, OIDC bearer token, and API key for an Anaconda user all project provider `anaconda`; transport details belong to the credential layer. Do not confuse this with the hosted prototype's `identity_provider` field on `cloud_room_ready`, which reports auth-validator metadata such as `anaconda-api-key`. Shared UI should derive `NotebookActorSourceProvider` from the principal namespace (or a future explicit authority field), not credential-transport metadata.

## Decision 4: Credentials and identity providers are separate concerns

Two concepts live on separate surfaces:

- **Identity providers (server-side):** one closed enum in `nteract-identity` that accepts a normalized `Credential` and returns an `AuthenticatedUser`.
- **Credentials (client- and listener-side):** the client keyring that stores credentials and the listener extractor that pulls them from upgrade requests. Both sit outside the providers.

### Server-side enum dispatch (`nteract-identity`)

`nteract-identity` ships a fixed set of providers: `Local`, `Oidc`, and `JupyterHub`. `Oidc` covers Anaconda, Clerk, Auth0, Okta, WorkOS, and generic OIDC via configuration alone. Enum dispatch makes supported providers explicit in the type system, avoids runtime overhead, and avoids `dyn`-incompatibility with Return-Position `impl Trait` in Traits (RPITIT):

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

Each inner provider exposes `authenticate` using RPITIT with `+ Send`, matching the repository convention (`crates/runtimed/src/kernel_connection.rs`) with no `async_trait` boxing.

Providers live as modules inside the single `nteract-identity` crate:

```text
crates/nteract-identity/src/
+-- lib.rs            # ActorLabel, Principal, AuthenticatedUser, AuthError, Credential, IdentityProvider
+-- local.rs          # LocalProvider (peer credentials)
+-- oidc.rs           # OidcProvider (JWKS bearer; configurable for Anaconda, Clerk, Auth0, Okta, WorkOS, generic OIDC)
\-- jupyterhub.rs     # JupyterHubProvider placeholder (pending /hub/api/user validation)
```

Splitting providers into separate crates (`nteract-identity-local`, `-oidc`, `-jupyterhub`) would create a Cargo cycle: each implementor needs `Credential`, `AuthenticatedUser`, and `AuthError` from `nteract-identity`, while `IdentityProvider` depends back on every implementor. Keeping them in one crate avoids the cycle.

Cargo features gate provider-specific dependencies so builds needing only `LocalProvider` stay lean. `OidcProvider` uses `jsonwebtoken` for JWKS validation. `JupyterHubProvider` is feature-gated in the enum and currently returns `AuthError::ProviderUnavailable("jupyterhub")` until Hub API validation lands:

```toml
[features]
default = ["local"]
local = []
oidc = ["dep:jsonwebtoken"]
jupyterhub = []
```

Each implemented provider tests in isolation against fixture credentials and fake IdP material. `nteract-identity` has no dependency on `runtimed`, `kernel-env`, or daemon internals.

### Client-side `Credential` keyring (planned target state)

A dedicated client-side keyring crate (planned as `nteract-credentials`, not yet implemented) will store per-host credentials encrypted at rest and look them up by room host when the daemon or another client authenticates to a remote room. Keeping it separate ensures providers never care where credentials originate, and the keyring never cares how they are validated.

Target daemon keyring entries:

```text
runtimed.com           -> AnacondaApiKey { token: "..." }
hub.example.com        -> JupyterHubToken { token: "...", expires_at: ... }
local-socket           -> (none, peer creds used)
```

A user configures a host once (pasted key, OAuth flow, or JupyterHub session forward), and subsequent room opens against that host reuse it.

### Credential presentation on the WebSocket upgrade

Browsers cannot attach custom headers to `new WebSocket(url, subprotocols)`. Credentials therefore arrive via one of four transports. Parsing them is a **listener-side concern**: the listener (Cloudflare Worker, Unix socket, etc.) reads the upgrade request and passes a normalized `Credential` to the provider.

`docs/adr/hosted-credential-transport.md` governs deployment-level transport selection; this section records the base vocabulary:

1. **Subprotocol smuggling (Kubernetes pattern):** the client opens `new WebSocket(url, ["nteract-bearer.<base64url-token>", "nteract.v4"])`. The server strips and validates the bearer element and echoes only `nteract.v4`. The token stays out of URLs, referers, and access logs, though browser JS shares the same trust boundary as any browser-held credential.
2. **One-time ticket:** the client POSTs `/api/session-tickets` with a header-set bearer token over normal CORS and receives a short-lived (~10 s, single-use) ticket, then connects to `wss://host/n/<id>?ticket=<one-time>`. The server validates and consumes the ticket; the real bearer never enters the WebSocket URL. Costs one extra round-trip and requires server-side tracking (in memory or D1).
3. **Cookie:** browsers send same-site cookies automatically on upgrade. This is deployment-specific (such as JupyterHub) because cookie auth requires explicit CSRF and origin handling.
4. **`Authorization` header (system-to-system only):** native clients (desktop daemon, agents, CLI) send `Authorization: Bearer ...` directly on the upgrade request. Browsers cannot use this path.

Base options by provider:

| Provider | Browser clients | System clients |
|----------|-----------------|----------------|
| `Oidc` (Anaconda, Clerk, ...) | Subprotocol bearer token or one-time ticket depending on deployment | `Authorization` header |
| `JupyterHub` | Hub-issued token via subprotocol or ticket; cookie only when the deployment owns CSRF/origin policy | `Authorization` header with Hub-issued token |
| `Local` | N/A (no WS) | Unix peer creds |

At upgrade time, the Worker Durable Object extracts the credential, validates it through `IdentityProvider`, and rejects failures with HTTP 401 (or an immediate typed close code). After upgrade, per-frame checks run solely against the in-memory `AuthenticatedConnection`.

`nteract-identity` models all four transports in `Credential`:

```rust
pub enum Credential {
    BearerToken(String),            // from subprotocol, ticket exchange, or Authorization header
    Cookie(String),                 // from upgrade-request cookies
    OneTimeTicket(String),          // short-lived ticket issued by the listener/host
    LocalPeer(LocalPeerCredential), // listener-verified local peer credentials
}
```

Extraction (parsing subprotocols, consuming tickets, reading cookies, querying peer creds) belongs to a listener-side `CredentialExtractor` trait, not the identity providers.

## Decision 5: Four scopes

Every connection carries exactly one scope set at authentication time:

- **`viewer`:** read-only sync participant.
  - May send and receive sync, presence, and session-control frames, **but inbound sync frames must carry no changes**.
  - Automerge sync stays bidirectional: a read-only peer negotiates heads/have/need, applies server updates, and replies through the normal `notebook-sync` loop.
  - The trust gate rejects any inbound `0x00`, `0x05`, `0x09`, or `0x0a` frame with non-empty `Message.changes`; empty negotiation frames pass. Request frames are restricted to read-only operations. Server outbound traffic is unrestricted.
  - **Upstream Automerge `read_only` caveat:** `State::new_read_only()` and `MessageFlags::READ_ONLY` are *not* client-side viewer primitives. In upstream Automerge (`rust/automerge/src/sync.rs` and `state.rs`), `read_only` means publish-only: the holder ignores incoming changes while still sending its own, so a viewer client using it will stop applying live updates. A room host *may* use `State::new_read_only()` on its server-side per-viewer peer state as an optimization and protocol hint, but it must still explicitly reject any viewer `Message.changes` as the authorization boundary.
- **`editor`:** live edits to `NotebookDoc` within the host's document-write policy, plus mutable widget state in `CommsDoc` (with `RuntimeStateDoc` comm topology governing kernel forwarding). Rejects all `RuntimeStateDoc` writes: editors cannot create executions, mutate queue/kernel/environment state, alter output routing, modify comm topology, or add hidden root keys.
- **`runtime_peer`:** writes `RuntimeStateDoc` execution progress, output, lifecycle, and comm topology for already accepted executions. Cannot create execution intent or edit `NotebookDoc`. Used by remote-runtime services and JupyterHub-spawned runtime sidecars. The hosted Worker prototype exercises this via direct `0x05` sync from a runtime handle without running kernels inside the Durable Object.
- **`owner`:** all `editor` permissions plus publish-revision and ACL-management requests.

### Where scope comes from

In the target model, effective scope is the intersection (narrower wins) of the credential's validated authority and the room ACL. A credential asking for `editor` against a `viewer` ACL entry yields `viewer`. Principals absent from the ACL are rejected at connect; anonymous `viewer` access applies only to unauthenticated requests on rooms with a public-read entry.

In the current Cloud Worker, requests pass a desired scope via `x-scope` or query parameters, provider validation may cap it, and the room host authorizes or downgrades it against the ACL. The resulting `connection_scope` is the server-authorized effective scope for UI rendering.

### Scope enforcement points

Target architecture enforces scope server-side at three explicit boundaries:

1. **Frame ingress** (`peer_notebook_sync.rs::handle_notebook_doc_frame`, `peer_runtime_sync.rs`, `peer_comms_sync.rs`, `peer_comments_sync.rs`, and the hosted WASM room host): checks `AuthenticatedConnection.scope` and rejects out-of-scope document frames. The hosted Worker and local daemon share the same `RuntimeStateDoc` policy helper.
2. **Request dispatch:** each `NotebookRequest` variant declares its minimum scope via annotation or registry lookup and rejects violations with a typed `Unauthorized` response before side effects—no scattered `if scope == ...` checks.
3. **ACL mutations:** owner-only. The hosted Worker exposes owner-only HTTP endpoints for D1 ACL rows; in-band Automerge ACL changes from non-owners are never honored.

### Adding new scope-gated functionality

Target rule: every new request variant or frame type declares its required scope at the definition site, verified by a CI lint or `#[derive]` macro so scope creep surfaces in review.

Current shipped status is narrower: frame-level scope gating and `RuntimeStateDoc` policy validation are active on the hosted room path, while full semantic request-scope dispatch remains target state for future execution-intent and hosted mutation APIs.

### What does and does not appear on the wire

The post-handshake capability payload includes `actor_label` and `connection_scope` so UIs render read-only or `runtime_peer` state without inferring permissions from failed requests. Remote hosts should always emit `connection_scope`; local daemon compatibility paths may omit it, and Desktop treats omission as local `owner` capability.

This payload is strictly informational to the server. The server remains the sole authority and enforces scope at frame ingress, request dispatch, and ACL mutation boundaries.

## Decision 6: Publish re-authenticates and re-authors at the destination boundary

**Shipped gap:** Current publish uploads saved Automerge bytes directly (`crates/runt-publish/src/lib.rs` uploads `source_snapshot.snapshot.notebook_bytes`, `runtime_state_bytes`, and `comms_doc_bytes`; `apps/notebook-cloud/src/index.ts` stores those bodies before inserting a catalog revision row). Destination ACLs and catalog metadata record the publisher, but the stored `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` retain full source change histories and actor labels—including `local:*` actors.

Publishing across identity spaces must be an authenticated import, not a history migration. Automerge actor labels are self-attested; accepting historical `local:quill/desktop:abc` changes makes the destination vouch for authorship it cannot verify, since anyone can fabricate a local document with arbitrary actor strings.

Local OS identity has authority only in the local space. At publish time, the destination validates the publish credential against its IdP and derives an immutable, namespace-qualified destination principal. Neither Desktop nor an agent may assert that `local:kylekelley` maps to a hosted account. Emails or usernames like `rgbkrk@gmail.com` are display metadata; the actor label uses the stable hosted principal.

The publish request declares an initiating operator descriptor separately from source history (such as `desktop` or `agent:<declared-label>`):

- Codex, Claude, OpenCode, and custom agents share the same open contract; none has a separate publish path.
- Source session IDs are not preserved.
- Model, provider, and version details may accompany the request as advisory, non-authorizing audit metadata.
- The destination syntax-checks the descriptor, enforces accepted operator kinds (Decision 1), and combines the verified principal, descriptor, and a fresh destination-minted publish nonce:

```text
user:anaconda:550e.../desktop:<fresh-publish-uuid>
user:anaconda:550e.../agent:<declared-label>:<fresh-publish-uuid>
```

Target publish flow:

1. **Capture rendered content projection:** the publisher captures cells, metadata, completed outputs, published widget state, and blob references from `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`. Source structural document IDs are excluded. Untrusted identity-bearing fields inside the projection—such as `RuntimeStateDoc.executions[*].submitted_by_actor_label`—are dropped rather than copied or relabeled. Any future identity-bearing field requires an explicit, destination-verifiable import rule to survive.
2. **Authenticate and mint destination IDs:** the destination validates the credential, derives the hosted principal, validates the operator descriptor, and mints fresh destination notebook, runtime-state, and comms document IDs plus a fresh import actor before creating a discoverable room.
3. **Author fresh documents:** the destination initializes fresh Automerge documents in its own identity space. Canonical schema-seed actors establish schemas; the fresh import actor authors the imported state. Non-canonical source history is neither copied nor relabeled; matching canonical genesis changes are established independently at the destination.
4. **Verify blob closure:** blob references keep their SHA-256 hashes; the destination verifies and stores the transitive closure of referenced bytes.
5. **Register catalog and audit rows:** after documents and blobs validate, the destination registers the room and initial revision. Durable revision, ACL, and audit attribution uses either the destination-minted import actor or separate typed fields (`principal`, validated operator descriptor, destination import ID) that reconstruct it exactly—never persisting a client-supplied source actor or source session suffix.
6. **Continue under destination identity:** subsequent edits author under normal destination principals and operators. No source user/operator actor (including `local:*`) or non-canonical source change exists in destination documents.

The import actor records *who published and how*, not authorship of every prior edit. UIs may render `"published by rgbkrk@gmail.com via Desktop"` or `"<agent label> on behalf of rgbkrk@gmail.com"` (for example, `"Codex on behalf of rgbkrk@gmail.com"`). The source notebook and its history remain untouched.

If Automerge later gains signed changes (see the [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)), cryptographically verified historical authorship could optionally travel across publish boundaries.

## Limitations

v1 enforces the trust gate at room ingress: bearer auth and ACL membership at connect, scope-based frame rejection per frame, and clone-preview actor validation before applying non-empty `NotebookDoc`, `RuntimeStateDoc`, or `CommsDoc` sync frames.

### Threat surface

| Attack | Mitigated by | Status |
|--------|--------------|--------|
| Unauthorized read | ACL check at connect | closed |
| Unauthorized write at all | Bearer auth + ACL at connect | closed |
| Scope escalation (viewer authoring, `runtime_peer` editing `NotebookDoc`) | Scope-based frame rejection | closed |
| Import-time cross-IdP forgery (publishing historical foreign actor labels) | Destination auth + fresh-document re-authoring (Decision 6) | open — current publish copies source history |
| **Live actor-principal spoofing** (authenticated peer authors under another principal) | Clone-preview actor validation before apply | closed in v1 |
| Bearer-token replay (stolen JWT opens a new socket) | DPoP / mTLS / short token lifetimes | deferred |
| Clone-preview validator cost on large or high-churn docs | `sync_message_new_changes` Automerge fork patch | deferred performance hardening |

### Deliberate v1 boundaries and orthogonal primitives

- **Host-to-host federation is out of scope for v1.** One notebook host trusting another host's identity claims (such as JupyterHub-to-Anaconda interop) is deferred beyond v1.
- **Clone-preview performance is a known v1 trade-off.** `automerge::sync::Message.changes` holds raw `ChunkList(Vec<Vec<u8>>)` bytes (V1: one `Change` per chunk; V2: potentially a full-document save). v1 validates correctness via post-apply actor extraction on a cloned document without requiring fork patches yet.
- **Automerge `filters` complement, rather than replace, ingress validation.** Upstream's `origin/filters` branch (`rust/automerge/src/filter.rs`) adds per-actor/per-author `Filter::Allow / AllowUpTo { heads } / Deny`. Filters hide changes at render time rather than rejecting them pre-storage, making them the right primitive for post-hoc revocation hiding rather than ingress blocking.
- **Keyhive signed changes are orthogonal.** Change-level capability tokens and signed history ([inkandswitch/keyhive](https://www.inkandswitch.com/keyhive/notebook/)) compose cleanly on top of this connection-level trust model later if needed.

## Open Follow-ups

- **Publish-time destination authentication and re-authoring ([#3900](https://github.com/nteract/nteract/issues/3900)):** replace raw Automerge save-byte uploads with fresh-document import per Decision 6. Required test coverage:
  - Destination principal derives solely from destination auth; import actor keeps the initiating operator descriptor with a fresh destination-controlled nonce.
  - No source-space user/operator actors or non-canonical source history survive; independently established canonical schema genesis is the only shared history exception.
  - Rendered state and transitive blob closure preserve the publish contract.
  - A malicious embedded `local:*` submitter label is stripped.
  - Publishing the same source twice produces distinct, internally consistent notebook, runtime-state, and comms IDs.
  - Catalog, revision, and ACL audit rows bind to destination-authenticated import attribution; if decomposed into typed fields, a test proves exact reconstruction of the import actor including its fresh import ID.
  - Unknown future operator labels round-trip through import attribution without altering principal, effective scope, or authorization.
- **Lower-cost actor-label validator:** replace v1 clone-preview validation with parse-only inspection of V1 and V2 `automerge::sync::Message.changes` chunks before merge (`sync_message_new_changes`, drafted in `docs/memos/automerge-fork-patches.md`), landing alongside room-host extraction.
- **Revocation signal and historical-change subduction:** specify the `SESSION_CONTROL` close frame and channel for admin revokes and plan downgrades. Once upstream Automerge `filters` lands in `main`, pair hard disconnects with `Filter::with_author(revoked, Rule::AllowUpTo { heads: validated })` to hide post-revocation edits while preserving causal integrity.
- **JupyterHub provider implementation:** implement `/hub/api/user` validation in `crates/nteract-identity/src/jupyterhub.rs` to replace the current `AuthError::ProviderUnavailable("jupyterhub")` placeholder.
- **Semantic request-scope dispatch:** enforce definition-site scope annotations on `NotebookRequest` variants (backed by a CI lint or `#[derive]` macro) for execution-intent and hosted mutation APIs.
- **Room-host crate extraction:** extract `runtimed::notebook_sync_server::room` behind pluggable `Listener` and `SnapshotStore` traits (tracked in a separate ADR).
- **Anaconda hosted v1 OIDC and credential transport:** finalize direct Anaconda SSO OIDC (staging against the retired `preview.runt.run` lane from `runtimed/intheloop` with Anaconda stage OIDC and `/oidc` callback) and principal-namespace rules in `docs/adr/hosted-credential-transport.md`.
- **Public viewer presence visibility:** decide whether anonymous public viewers (`anonymous:<session>/browser:<session>`) see each other, see aggregate counts, or remain local-only.
- **`runtime_peer` production connection topology:** decide whether production kernel sidecars connect directly to hosted rooms with a `runtime_peer` credential (as in the current hosted prototype) or relay writes through a separate runtime-coordination protocol.
- **Deployment topology and keyring placement:** finalize browser-direct WebSocket vs daemon proxy, kernel placement, TLS/CORS, and the planned `nteract-credentials` client keyring in `docs/adr/deployment-topology.md`.
- **ACL mechanics beyond flat D1 rows:** design owner transfer UX, group/org expansion, inherited ACLs, audit event retention, and Zanzibar/Authzed-style relationship evaluation.
- **Bearer-token replay hardening:** evaluate DPoP / proof-of-possession tokens, mTLS for system-to-system links, and short token lifetimes.

## Migration

At adoption, `.automerge` files were persisted only for untitled ephemeral notebooks, so no production notebook held long-lived legacy actor labels on disk. New `<principal>/<operator>` labels apply from day one; old in-memory labels clear on daemon restart with no disk migration required.

## Worked examples

### quill editing a local untitled notebook

1. Desktop connects over the Unix socket. The listener reads `SO_PEERCRED` for OS user `quill`; `IdentityProvider::Local` returns principal `local:quill` with scope `owner`.
2. The daemon stands up a WASM peer with actor `local:quill/desktop:7f3a`.
3. Claude joins the same room over the Unix socket via MCP. Its principal is also `local:quill`, with operator `agent:claude:s1`, yielding `local:quill/agent:claude:s1`.
4. Both connections hold `owner` scope and may write allowed `NotebookDoc` edits and mutable `CommsDoc` widget state. Runtime lifecycle/progress/output still requires `runtime_peer`, and execution intent still requires the request API. Clone-preview validation rejects any incoming change whose author principal is not `local:quill`, including peer-authored `system` changes.
5. Presence shows two operators under one principal; UI renders `"quill (Desktop)"` and `"quill (Claude)"`.

### quill editing an Anaconda-hosted notebook

1. quill's client opens an authenticated connection to the Anaconda-hosted room (transport choice belongs to deployment topology).
2. The room host validates the credential, returning principal `user:anaconda:550e...`, and finds `editor` scope in the room ACL.
3. The client stands up a WASM peer with actor `user:anaconda:550e.../desktop:7f3a`.
4. Allowed `NotebookDoc` and `CommsDoc` edits flow through; `RuntimeStateDoc` stays `runtime_peer`-owned and execution intent stays request-owned. Clone-preview validation rejects any incoming change whose principal is not `user:anaconda:550e...`, including peer-authored `system` changes.
5. The same Desktop process may concurrently open a local untitled notebook as `local:quill` against the local daemon: two rooms, two ACLs, two independent authenticated connections.

### Claude editing the Anaconda-hosted notebook on quill's behalf

1. quill's local Claude MCP process connects to the hosted room using a credential quill made available (session reuse, agent-scoped Anaconda API key, or similar; delegation mechanics are out of scope here).
2. Anaconda validates the credential, returning principal `user:anaconda:550e...` and ACL scope `editor`.
3. Claude authors as `user:anaconda:550e.../agent:claude:s1`—same principal as quill's Desktop session, distinct operator. Attribution separates them while the trust gate authorizes both under the same principal.

### Target: publishing a local notebook to Anaconda

Current publish still uploads source Automerge save bytes. The target flow is:

1. quill triggers "publish to Anaconda" from Desktop. The local principal `local:quill` has no authority at Anaconda.
2. Anaconda validates the publish credential and derives `user:anaconda:550e...`. It may project `rgbkrk@gmail.com` as display metadata, but rejects any client claim mapping `local:quill` to that account.
3. Desktop captures the rendered state of `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` (cells, metadata, outputs, published widget state, and blob references).
4. The destination creates fresh Automerge documents and imports state under `user:anaconda:550e.../desktop:<fresh-publish-uuid>` (or `user:anaconda:550e.../agent:<declared-label>:<fresh-publish-uuid>` for an agent, such as `"Codex on behalf of rgbkrk@gmail.com"`).
5. Source change DAGs are not copied; output blobs keep their SHA-256 hashes and preserve the publish contract.
6. A new room opens at `runtimed.com/n/<id>` owned by the hosted principal. New edits author under `user:anaconda:550e.../*`, with no `local:*` actors in the destination documents.
7. The local notebook and its pre-publish history remain untouched.

## Compatibility with Automerge semantics

Audit against Automerge and `automerge-repo` confirming no downstream conflicts:

- **Self-attested actor IDs (compatible):** Automerge sets `actor_id` at write time for ordering and conflict resolution without cryptographic binding. Concurrent writers must never reuse an actor or `(actor_id, seq)` collisions corrupt CRDT state. The `<nonce>` suffix in `<principal>/<operator>` guarantees uniqueness across parallel operators for one user.
- **v1 clone-preview, v2 parse-only validation (compatible):** `automerge::sync::Message.changes` stores raw `ChunkList(Vec<Vec<u8>>)` chunks. v1 validates principals on a cloned doc before applying to the real room doc; the planned `sync_message_new_changes` fork patch replaces cloning with parse-only pre-apply inspection.
- **Hash-pinned history is immutable (compatible):** every `Change` hashes its parent heads, so rewriting history invalidates downstream hashes and fails room head checks. The validator only needs to inspect *new* changes.
- **Transport-layer trust matches `automerge-repo` (compatible):** `automerge-repo` network adapters handle identity at the transport layer and assume peers passed upward are legitimate. Connect-time auth and per-frame checks sit at the listener/adapter boundary.
- **Ephemeral messages stay out-of-band (compatible):** presence frames (`0x04`) never enter the Automerge DAG, matching `automerge-repo` ephemeral messages. Rewriting the principal prefix on ingress is a pure server policy.
- **`set_actor` mid-session is discouraged (discipline, not limitation):** Automerge permits `set_actor`, but this trust model fixes `<principal>/<operator>` at peer construction for the connection's lifetime. Switching operators requires a new connection.
- **Human-readable actor override (compatible):** Automerge defaults to random `ActorId`s per `AutoCommit`, which nteract already overrides with readable labels (`crates/notebook-doc/src/lib.rs`). This model extends that string format with no Automerge wire change.

## References

- `crates/nteract-identity/src/` - shipped `ActorLabel`, `Principal`, `Credential`, `IdentityProvider`, and provider modules.
- `crates/notebook-wire/AGENTS.md` - frame types and v4 wire details.
- `crates/notebook-protocol/src/connection/handshake.rs` - handshake shape.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` - per-frame validator hook.
- `crates/notebook-doc/src/diff.rs` - `extract_change_actors`, used by both `TextAttribution` and the v1 clone-preview actor validator.
- `automerge::sync::Message` (`rust/automerge/src/sync.rs`) - `ChunkList` wire shape backing per-frame validation.
- `crates/notebook-doc/src/presence.rs` - presence frame shape.
- [`runtimed/intheloop`](https://github.com/runtimed/intheloop) (`backend/auth.ts`, `backend/sync.ts`) - bearer-JWT validation and connection-time auth model.
- [`runtimed/anaconda`](https://github.com/runtimed/anaconda) (`api_key.ts`) - Anaconda userinfo validation and scope mapping.
- JupyterHub (`jupyterhub/services/auth.py`) - Hub cookie/token validation without `X-Forwarded-User`.
- Automerge `filters` branch (`origin/filters` on `automerge/automerge`, `rust/automerge/src/filter.rs`) - post-hoc subduction primitive for runtime revocation.
- `automerge-repo` (`DocSynchronizer.receiveSyncMessage`, `NetworkAdapterInterface`) - confirms no built-in per-message authorization hook exists inside the synchronizer.
- Keyhive notebook: https://www.inkandswitch.com/keyhive/notebook/ - change-level capability tokens and signed history.
