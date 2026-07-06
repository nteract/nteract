# Cloud User Store: one principal → display resolution for every surface

**Status:** Proposed, 2026-07-06.

## Context

The `/n` dashboard renders a shared notebook's owner as a raw principal string
(`b0204af7084b…`) with two-letter initials taken from that same hex. It is not a
one-off: it is what happens on every surface that needs to show *a user who is
not the current viewer* and has no cheap way to name them. The notebook view and
comments avoid the worst of it because they each grew their own resolution path;
the dashboard did not, so it leaks the identifier.

The parts to fix this already exist. They are just not connected, and each
consumer reinvents the connection.

**The pure display layer (already shared, already correct).**
`resolveActorDisplay({actorLabel, peers, source})` in
`packages/runtimed/src/notebook-actor-display.ts` turns an opaque actor label
into an `ActorDisplay` — `{displayName, principalId, kind, isAgent, onBehalfOf,
onBehalfOfColor, color, initials, imageUrl}`. It parses the label
(`notebook-actor-projection.ts`), hashes a deterministic color
(`notebook-actor-color.ts`), computes initials, and overlays a caller-supplied
`peers: ReadonlyArray<ActorDisplayPeer>` directory (`{participantKey, label,
imageUrl}`) to replace the parsed fallback with a real name and avatar. It does
no I/O (its projection helpers keep module-level caches, but nothing fetches). It
is exported from `packages/runtimed/src/index.ts` and is framework agnostic.
Color is a pure hash of the identity key, so it is globally consistent for free —
resolution only has to solve **name and avatar**.

**The host source of truth (already durable).** The Worker runs a D1 table
`principal_profiles` (`apps/notebook-cloud/src/storage.ts`): `principal` (PK),
`provider`, `provider_subject`, `email_normalized`, `email_verified`,
`display_name`, `avatar_url`, `first_seen_at`, `last_seen_at`, `raw_claims_json`.
A companion table `principal_account_links` maps a transport principal to a
canonical `account:<ns>:email:<sha256>` principal on verified email, so the same
human arriving through different providers converges on one row. Rows are read in
batch through `getPrincipalProfiles(env, principals[])`
(`apps/notebook-cloud/src/sharing-storage.ts`, `PRINCIPAL_PROFILE_LOOKUP_BATCH_SIZE
= 50` per query). Rows are written on authenticated OIDC / Anaconda requests — at
login and on app-session re-sync, through `syncAuthenticatedProfile` /
`syncStoredAppSessionProfile` → `resolveNotebookInvitesForLogin` →
`upsertPrincipalProfileWithAccount`, gated to `provider === 'oidc' ||
'anaconda-api-key'`. Dev-auth and anonymous principals are never written.

**Why the dashboard leaks.** Two failures compound:

1. **Coverage is auth-gated.** A dev-auth principal, an anonymous principal, or a
   real user who has not yet authenticated at least once has no
   `principal_profiles` row. `getPrincipalProfiles` returns nothing for them,
   permanently, not transiently.
2. **The fallback derives from the identifier.** When the `/api/n` list handler's
   `listNotebookPrincipalDisplays` (`apps/notebook-cloud/src/index.ts`) finds no
   row it drops `owner_display`. The client
   (`cloudNotebookOwnerLabel` / `cloudNotebookOwnerInitials` in
   `apps/notebook-cloud/viewer/notebook-dashboard.ts`, rendered by
   `cloud-notebook-dashboard-view.tsx`) then derives a label from the raw
   principal — trim, take an email local-part, else split on `:` and use the tail
   or the whole string — which for an opaque subject like `b0204af7084b` yields
   the identifier itself, shown as both name and initials.

**"Never show a raw principal" is not yet a property any surface has.** The
comments path only partly avoids it: `friendlyUserPrincipalLabel`
(`notebook-actor-projection.ts`) hides `user:anaconda` UUID subjects behind a
generic label, but other opaque subjects are still humanized straight from the
principal, and the shared `NotebookCommentsPanel` with no resolver injected falls
back to the raw actor label. So the never-raw guarantee is new work this store
centralizes, not something to copy.

**Everything else is duplicated.** The same principal is resolved several
different ways server-side — `owner_display` and `current_user_display` strings on
`/api/n`, the `ShareTargetDisplay` union on `/acl` and `/access-requests`,
`{principal, label, image_url}` on `/api/n/:notebookId/author-profiles`, and
`display_name` on presence control frames — and assembled client-side per surface:
comments merge a fetched author-profiles batch with live presence peers; presence
(`cloud-presence-status.tsx`) shows initials-only avatars because the room roster
protocol carries no image; self-identity flows through a separate `identityLabel`
/ `identityImageUrl` side channel (`apps/notebook-cloud/viewer/shell-capabilities.ts`).
`avatar_url` is plumbed end to end and `upsertPrincipalProfile` will store it, but
no production caller supplies one (the OIDC `picture` claim stays browser-side),
so in practice the viewer's own badge is the only avatar that ever renders. The
comment-author image path exists but resolves to null. So the same person can
render with a different name, and no avatar, depending on which surface is asking.

### Neighbors

- `docs/adr/frontend-sync-bridge.md` — the store/projection discipline this store
  follows: engine streams into `useSyncExternalStore`-backed stores, React never
  owns the source of truth, stale async writes are invalidated not just cleared.
- `docs/adr/identity-and-trust.md` — actor label grammar (`<principal>/<operator>`)
  and the principal namespaces this store keys on.
- `docs/adr/notebook-comments-document.md` — the first consumer of actor display.
- `docs/adr/hosted-room-authorization.md` — the relationship gate the resolver
  must honor.
- `.claude/skills/frontend-dev` — App-Shell Latency, Projection Discipline, and
  State Boundary rules this store is built to satisfy.

### Goals

1. **One name and one avatar per principal, everywhere.** The dashboard owner,
   the comment author, the presence peer, and the viewer's own badge resolve the
   same principal to the same display, from one cache.
2. **Never render a raw principal.** A `b0204af7084b…` string is never shown as a
   name or initials on any surface. Unknown principals degrade to a kind label,
   and the client can tell "resolved name" from "fallback."
3. **Host owns the identity facts.** Names and avatars come from D1 over an
   explicit API, not from parsing principal strings in React and not from
   Automerge.
4. **Works on pages that have no notebook document.** `/n` and future
   workstation/collaborator lists resolve owners they have never had in a room.
5. **Cross-page, not cross-feature-duplicated.** Adding a new surface consumes the
   store; it does not hand-roll another fetch-merge-fallback path.

### Constraints

- **Identity facts are host-owned, not Automerge.** Per the frontend-dev State
  Boundary rule, D1/ACL/OIDC/session data is projected into shared UI, never
  mirrored into `runtimed-wasm` or a notebook document. The store is a Cloud
  viewer store fed by host APIs.
- **`runtimed` stays framework-agnostic.** The pure `resolveActorDisplay` layer
  and the `ActorDisplay` type stay in `packages/runtimed` with no React, no fetch,
  no store. The reactive cache lives in the Cloud viewer.
- **Resolution is relationship-gated, and never an enumeration oracle.** You may
  learn the display of a principal you already share a notebook relationship with.
  There is no endpoint that answers "does principal X exist" for an X the caller
  names. This is not a directory search.
- **Desktop is unchanged.** The desktop app resolves one local identity from the
  OS username (`App.tsx`); it does not get this store.

## Decision 1: Keep the pure display layer; add the reactive cache underneath it

`resolveActorDisplay` and its projection/color helpers stay exactly as they are.
They are the leaf: given an actor label and a peer directory, they produce an
`ActorDisplay`. The problem was never the compute — it was that every consumer
built the peer directory itself, from whatever inputs it happened to have.

The store's job is to *be* that peer directory: one canonical, cached,
subscribable `principal → {label, avatar}` map that feeds `peers` into
`resolveActorDisplay`. Consumers stop assembling peers and instead ask the store
to resolve a label. This keeps all the already-correct behavior (kind detection,
on-behalf-of, deterministic color, initials) and replaces only the ad hoc
directory assembly — and it is where the single never-raw fallback policy lives.

## Decision 2: `CloudUserStore` — a Cloud-viewer source store, read through `useSyncExternalStore`

A new module `apps/notebook-cloud/viewer/cloud-user-store.ts`. Mirror the
structure of `cloud-auth-store.ts` exactly — a private source, a synchronous
snapshot, a named domain hook — rather than exporting a naked subject. Follow the
RxJS Shape rules in the frontend-dev skill.

**Shape.**

- One authoritative `BehaviorSubject<Map<string, ResolvedProfile>>` keyed by
  principal id, **private**, exposed only as a readonly `Observable` via
  `.asObservable()` and a synchronous `getSnapshot()`. `ResolvedProfile` is
  `{principal, displayName?, avatarUrl?, source: 'self' | 'presence' | 'profile'
  | 'unresolved'}`.
- Consumers subscribe to the **narrowest** projection —
  `select(m => m.get(principal), Object.is)` with `distinctUntilChanged` — so a
  backfill for one principal does not re-render every avatar. The
  `useSyncExternalStore` adapter emits synchronously on subscribe (the
  `BehaviorSubject` seeds the first value).
- The public read is `resolve(actorLabel): ActorDisplay` — it parses the label to
  a principal, looks up the cached `ResolvedProfile`, builds the single-entry
  `peers` array, and calls `resolveActorDisplay`. A React hook
  `useResolvedActor(actorLabel)` wraps it so any surface can name a label and
  re-render when its backfill lands.

**Seeding, in precedence order.**

1. **Self** — seed from the OIDC claims / dev auth already in `CloudPrototypeAuthState`
   (name + `picture` avatar). This retires the `identityLabel` / `identityImageUrl`
   side channel: the viewer's own badge resolves through the same cache as everyone
   else.
2. **Presence** — subscribe to the existing `CloudViewerPresenceStore` roster
   (itself a `useSyncExternalStore` store) and seed `{principal → label}` as peers
   join. Presence carries a name today and an avatar once Decision 4 lands.
3. **Backfill** — for any principal requested but not yet cached, enqueue a batched
   fetch to the notebook-scoped resolver (Decision 3). Batch and dedupe (reuse the
   50-per-query size); coalesce concurrent misses into one request.

**Fallback policy (single owner).** Resolution prefers `profile` > `presence` >
`unresolved`. An `unresolved` principal produces the generic kind label from
`resolveActorDisplay` — **never the raw principal**. The dashboard's
`cloudNotebookOwnerLabel` raw-string derive is deleted.

**Async-write discipline.** The backfill writes into the store after `await`.
Follow the frontend-sync-bridge stale-write rule and the reconnect-empty-store
rule: carry an activation epoch (bumped on sign-out / viewer teardown), and after
the fetch resolves, merge only if the epoch still matches. A profile row that
arrives after teardown or an identity change is dropped, not written. Never demote
a cached `profile`/`presence` entry to `unresolved` on a failed or empty fetch —
absence of a fresh answer is not evidence the name is gone.

**Tests.** Virtual-time tests (`rxjs/testing`) for batch coalescing, dedupe,
distinct-until-changed per principal, and the epoch stale-write guard; snapshot
tests for synchronous seeding and the never-raw fallback.

## Decision 3: Resolve within a notebook relationship, not a global directory

The tempting shape — a global `GET /api/users?principals=…` — is an enumeration
oracle: it would answer "this principal has a profile" for any principal the
caller can associate with any visible notebook. Do not build it. Keep resolution
scoped to a relationship the caller already holds.

- **`/n` owners resolve server-side in the list response.** The list handler
  already runs with the caller's visibility and already batch-resolves owners
  (`listNotebookPrincipalDisplays`). Fix them there: add `avatar_url`, and stop
  dropping unknowns — return a `resolved` flag so the client shows a kind-label
  fallback instead of the hex. `/n` then needs no client resolver at all.
- **In-notebook surfaces use a notebook-scoped endpoint.** Generalize today's
  `/api/n/:notebookId/author-profiles` (do not replace it with a global surface)
  to resolve the owner + ACL + comment-author + live-presence principals **of a
  notebook the caller can already see**. The endpoint only ever resolves
  principals that appear in that notebook's own sets — never an arbitrary
  principal the caller names.
- **No oracle, no leak.** Cap batch size; return only positive display payloads
  (no "no such principal" signal, no reason codes); rate-limit and audit misses.
  Never reveal a canonical account link: resolving a transport principal must not
  expose its linked `account:<email-hash>` principal unless that canonical
  principal is itself in the allowed set. `email` is never returned — display name
  and avatar only.
- **One server-side projector.** A single `principal → {displayName, avatarUrl,
  resolved}` mapper is reused by the list projection, the notebook-scoped
  resolver, `/acl`, `/access-requests`, and `/author-profiles`, retiring the
  several divergent shapes.
- **Fail closed to a label, open to the UI.** A D1 error resolves every requested
  principal to `resolved: false` (the client shows kind-label fallbacks), never a
  500 that blanks the list.

Honor `docs/adr/hosted-room-authorization.md` and `identity-and-trust.md`. This
gate gets an explicit human security review before it ships; it is the one part
of this ADR that is summoned, not self-merged.

## Decision 4: Populate `avatar_url` — the prerequisite that makes avatars appear at all

The avatar write path exists but is never fed, so the viewer's own badge is the
only avatar that ever renders. Two changes unblock avatars everywhere:

1. **Capture the avatar at auth time.** In the `upsertPrincipalProfile` write
   path, read the OIDC `picture` claim (and the Anaconda profile avatar) into
   `avatar_url`. This is the single write that lets *other* viewers ever see a
   face.
2. **Project it on the list.** Add `avatar_url` to the `/api/n` list projection
   (the sibling `/author-profiles` already returns it); the shared projector from
   Decision 3 does this once.

Optional, follow-on: add an image field to the room roster protocol
(`cloud_peer_joined` / `CloudRoomPeerRosterEntry`) so live presence avatars stop
being permanently initials-only. This is a protocol change; it can lag the rest.

## Decision 5: Converge the consumers, delete the duplicates

Once the store and endpoint exist, every *display* surface reads the store:

- **Comments** — `resolveCloudCommentAuthor` (`notebook-viewer.tsx`) becomes
  `useResolvedActor`; delete the bespoke fetch-and-merge in
  `comment-author-profiles.ts` (keep its batch-URL helpers if the store reuses
  them).
- **Presence** — `cloud-presence-status.tsx` resolves peer labels through the
  store, gaining avatars for free once Decision 4 lands.
- **Self-identity** — `NotebookIdentity` / `NotebookToolbarIdentity` /
  `shell-capabilities.ts` read self from the store, including
  `current_user_display` and the dashboard's self avatar; retire the
  `identityLabel` / `identityImageUrl` side channel.
- **`/n` owners and live peers** — `cloud-notebook-dashboard-view.tsx` resolves
  owners (server-projected per Decision 3) and any dashboard live-peer avatars
  from room summaries through the store; delete `cloudNotebookOwnerLabel` /
  `cloudNotebookOwnerInitials`.
- **Sharing UI** — the ACL / access-request label/detail/title fallbacks in
  `sharing-client.ts` resolve through the store instead of hand-formatting the
  `ShareTargetDisplay` union where a display is all that is needed.

**Not display consumers — leave them.** Auth diagnostics and collaborator-debug
surfaces intentionally show the raw principal / provider subject; do not converge
them. Instant-paint and persistence principal *matching* are security keys, not
display, and must keep comparing raw principals — never route them through the
store.

The competing fallback formatters collapse to one policy in the store; the server
label formatters collapse to `identityDisplayLabel` as the single "no profile
yet" formatter.

## Rollout

Delivered as one implementation PR after this ADR merges, staged internally as
ordered commits so review can follow the progression. Cross-model review
(implementer and reviewer from different model families); the Decision 3 auth gate
gets a human security review before merge, not self-merge.

- **Stage 0 — stop the leak.** First commit, so the visible symptom dies early.
  No visible raw-principal fallback *anywhere*: the dashboard owner fallback
  (`notebook-dashboard.ts`) and the sharing ACL / access-request fallback labels
  (`sharing-client.ts`) adopt the never-raw policy — an unresolved principal shows
  a generic kind label, never the raw id. No store, no endpoint. Contained fix for
  the visible symptom.
- **Stage 1 — server.** One shared projector for owner / current-user / ACL /
  access-request / author-profile displays; OIDC `picture` avatar capture
  (Decision 4); `avatar_url` and a `resolved` flag on the list projection; the
  generalized notebook-scoped resolver with its relationship gate (Decision 3).
  Ships with the auth-gate review.
- **Stage 2 — the store.** `cloud-user-store.ts` with `useSyncExternalStore`
  binding, self + presence seeding, batched backfill, epoch stale-write guard, and
  virtual-time tests (Decision 2). No consumer changes yet; land it green behind
  the existing paths.
- **Stage 3 — converge.** Move consumers onto the store one surface at a time
  (comments, presence, self, `/n` owners, sharing UI), deleting the duplicated
  fetch-merge-fallback code — including `sharing-client.ts` and the comment-author
  fetch/merge — as each moves (Decision 5).

## Boundaries and non-goals

- **Not Automerge.** Identity facts stay host-owned D1 projected through APIs.
  The notebook document does not carry a user directory.
- **Not a people search.** Relationship-gated, notebook-scoped resolution only; no
  directory enumeration, no email lookup surface, no existence oracle.
- **Color is unchanged.** The deterministic hash already gives every principal a
  stable color on every surface; the store does not touch it.
- **Desktop keeps its local resolver.** One OS-derived identity; no cache, no
  endpoint.
