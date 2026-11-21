# Cookie-first auth: getting the browser out of the token business

Status: memo. Proposes moving all browser auth material out of `localStorage`
into HttpOnly cookies with server-side code exchange and server-owned refresh
custody. That change enables authenticated SSR and collapses the dual-authority
auth states. Prompted by Kyle (2026-07-08): "Can we get off localStorage at all
to enable us to go all in on cookies? I'm hoping we can do some SSR at some
point."

Companion memo: `instant-paint-validity-ssr.md` identified the SSR opening that
the app-session cookie creates and the presence-vs-validity gap in
instant-paint's gate. This memo is the migration plan that takes that opening.
Stage 2's identity hint should carry validity (session freshness), not just
presence, closing that memo's concern as a side effect.

## Problem

Cloud viewer auth today is `localStorage`-first. The OIDC access+refresh
tokens, claims, and PKCE request state all live in `localStorage`. The client
then mints the HttpOnly app-session cookie *from* the token
(`POST /api/auth/session`). Two consequences follow:

1. **No authenticated SSR.** The Worker cannot render authenticated HTML on a
   first navigation because the credential lives in JS storage it cannot see.
   Everything app-shell (#3928's skeleton chain, the `/n` cold load) is a
   client-side bootstrap workaround for this one fact.
2. **Two auth authorities that disagree transiently.** The 2026-07-07 QA pass
   catalogued the split-brain states directly:
   - signed-in chrome over "sign in to list notebooks" (design-doc state 2b);
   - color-only session-expiry on Home; and
   - a client-side renewal driver whose laziness needed a root-cause
     investigation to understand (`cloud-auth-store.ts:478-488` freshness
     guard).

   Every one of these exists because the browser holds a second copy of the
   truth.

Also: tokens in `localStorage` are exfiltratable by any XSS. HttpOnly cookies
are not.

## Target architecture

The session cookie becomes the *only* browser-held credential. Tokens never
reach JavaScript.

1. **Server-side code exchange.** `/oidc` becomes a Worker route. When the
   Worker mints the authorize redirect, it stores the PKCE verifier in a
   short-lived HttpOnly cookie. On callback, it exchanges the code at the IdP,
   creates the session, sets the `__Host-` session cookie, and 302s to the
   return URL. PKCE works fine with a public client server-side; no client
   secret is required, though we can add one if Anaconda issues it.
2. **Server-owned refresh custody.** The refresh token is stored server-side
   and encrypted in the session record (D1 row or DO storage keyed by session
   id). The per-deploy session secret already exists for HMAC. Session
   middleware refreshes the IdP token when the session record needs it. The
   entire client renewal driver (`runRefreshOidc`, `refreshStoredOidcToken`,
   `renewIfNeeded`, and the interval/focus/visibility exhaustMap) is deleted.
3. **SSR bootstrap becomes total.** The Worker already injects `initialSession`
   and the notebook list bootstrap. With the cookie as the sole authority, it
   can server-render any app-owned page (`/n`, `/workstations`, room shell)
   authenticated on first byte. Pre-network client identity claims
   (instant-paint principal matcher, avatar seed) ride the boot payload as a
   server-rendered identity hint: display claims only, never credentials.
4. **Clean cutover.** The `localStorage` token path is deleted in the same arc,
   not left as a fallback. There is no dual-authority period beyond the
   migration itself. Sign-out is `DELETE /api/auth/session` plus cookie clear;
   nothing else needs scrubbing.

## What stays as-is (existing doctrine)

- **Room WebSocket auth is already cookie-first.** Per
  `hosted-credential-transport.md`, the browser live-room WS authenticates with
  the app-session cookie when available, under strict Origin checks and
  mixed-credential rejection (`src/index.ts:752+`). Explicit bearer/dev
  subprotocols are the no-session fallback, and tickets are explicitly not the
  current path. Cookie-first makes the cookie path the only browser path. (The
  `frontend-dev` skill text still says "explicit/ticketed"; align it with the
  ADR during the revision. `instant-paint-validity-ssr.md` repeats the same
  stale phrasing.)
- **The isolated output-frame origin stays cookie-less.** Frames get blob
  URLs/tickets, never ambient credentials.
- **Desktop/daemon auth is untouched.** It uses a different transport and a
  different doctrine.
- **Dev loopback mode:** the dev issuer flow works identically (it is just an
  issuer). The `/local-auth` dev-token path becomes a dev-only cookie mint.

## Decisions required (the ADR-revision surface)

1. `docs/adr/hosted-credential-transport.md` Decision 2 describes the browser
   running the Authorization Code + PKCE exchange and bridging the validated
   bearer into the app-session cookie. The `localStorage`-verifier custody is
   an implementation detail (the `oidc-auth.ts` module comment), not ADR-stated
   rationale. Because the decision text specifies a client-side exchange,
   moving it server-side requires an ADR revision.
2. Refresh-token storage shape: an encrypted blob inside the session cookie
   (stateless, size-bounded) vs a server-side record in D1/DO (revocable,
   list-able, enables "sign out everywhere"). Recommendation: server-side
   record. We already have D1, and revocability is worth the row.
3. CSRF posture: `__Host-` + `SameSite=Lax` covers navigation. Mutating API
   routes should get origin-check or token-header enforcement as part of the
   cutover (cheap in the Worker middleware).
4. Session TTL + sliding renewal policy (today's TTL: census pending).

## Migration stages

Each stage ships independently; the system works at every point.

- **Stage 0 (done, incidentally):** the app-session cookie exists, server
  bootstrap injects `initialSession`, and most API routes already accept the
  cookie.
- **Stage 1: server-side callback, behind a flag.**
  - Add Worker-side `/oidc` exchange with flow-cookie PKCE.
  - Never materialize a `localStorage` token for sessions minted this way; the
    Worker must not re-expose tokens to JS, so there is deliberately NO
    transitional dual-write.
  - The client already tolerates session-without-token: everything rides the
    cookie, and the renewal driver no-ops without a stored token (verified in
    the 2026-07-07 renewal investigation).
  - Add the minimal identity hint (`principal` + `display_name`, already in the
    session record) to the boot payload so instant-paint and the avatar work
    for flag-on sessions.
  - Keep the client-side flow intact as code for rollback. Land the ADR
    revision here.
- **Stage 2: server refresh custody.** Move the refresh token into the new
  server-side session record and delete the client renewal driver (the big
  client deletion). Flip the flag on by default. Add full display claims
  (`email`, `picture`) to the identity hint via session-mint enrichment or
  `principal_profiles`.
- **Stage 3: SSR.** Server-render `/n` and `/workstations` authenticated, with
  room shell SSR as a follow-on. This closes the #3928 arc for real.
- **Stage 4: cleanup.** Delete the dev-token `localStorage` path and
  `oidc-token`/`oidc-request` key handling. Add a migration note for stale keys
  (one-time `removeItem` on boot).

## Current-state census (verified against code, 2026-07-08)

Key facts from the full reader/writer census (file:line citations live in the
census output; highlights below).

**Storage keys.** Five auth keys plus one auth-*keyed* non-credential:

- `oidc-token` (`oidc-auth.ts:51-65,630-648`): access+refresh tokens plus
  claims. An expired token is never removed; expired claims still seed UI.
- `oidc-request`: PKCE verifier/state/returnUrl, with a one-round-trip
  lifetime.
- `dev-token` / `user` / `scope` (`dev-auth-storage.ts:3-6`): the dev triplet,
  written by `/local-auth` at `index.ts:552-568`.
- Notebook list cache (`notebook-list-cache.ts:12-13`): non-credential cache
  keyed by dev user or OIDC `sub`.

**Consumer dispositions.**

- *Delete*: the entire client renewal loop (`runRefreshOidc` at
  `cloud-auth-store.ts:467-515`, `storedOidcTokenNeedsRefresh`,
  `refreshStoredOidcToken`, and the refresh-token exchange at
  `oidc-auth.ts:464-497`).
- *Replace with server callback*: the token->cookie bridge
  (`app-session.ts:41-70` Bearer POST, `renewIfNeeded` at
  `cloud-auth-store.ts:517-552`, callback establish at
  `oidc-callback-standalone.ts:92-117`). Also replace the PKCE round trip
  (`beginOidcLogin`/`completeOidcRedirect`, `oidc-auth.ts:286-365`).
- *Needs identity hint*: instant-paint principal matcher (OIDC `sub`,
  `cloud-principal.ts:37-58`), synchronous pre-React auth seed
  (`cloud-auth-store.ts:198-209,254-263`), avatar/display fallbacks
  (`claims.name/email/picture`), and list-cache keying.
- *Already cookie*: non-dev browser API fetches send `{}` headers with
  same-origin credentials today (`collaborator-auth.ts:276-300`).
  `syncAuthConnectionKey` collapses to `"app-session"` whenever a session
  exists. The raw bearer only rides the WS as a *fallback* when no session
  exists (`live-sync.ts:1011-1044`).
- *Stays bearer by design*: machine paths (workstation events/attach-job,
  `POST /api/workstations`, artifact/blob PUTs) use agent/CLI credentials, not
  browser sessions.

**Server side.**

- **Signed self-contained cookie (`app-session.ts:17-31`):** carries
  `principal`, `ns`, `display_name`, `provider`, `iat`, `exp`, and `sid`. TTL
  is 6h with sliding renewal under half-life, signed with
  `NOTEBOOK_CLOUD_APP_SESSION_SECRET` (min 32 chars).
- **Public session response:** exposes only `provider`, expiry, and `cache_key`.
- **Available vs missing claims:** `principal` and `display_name` are already
  in the cookie. The OIDC `sub` is derivable from `principal` because the
  principal suffix IS the encoded `sub` (which `cloud-principal.ts:46+` matches
  on). `email` and `picture` are NOT in the cookie and must be added at session
  mint or served from `principal_profiles`.
- **WS upgrade and boot injection:** WS upgrade has a first-class cookie path
  that rejects mixed credentials (`index.ts:737-872`). Boot already injects
  `#nteract-cloud-auth-config` and `#nteract-cloud-bootstrap` with
  `initialSession`.
- **Existing cookie coverage:** already broad across list, catalog,
  sharing/ACL/invites/access-requests, profiles, snapshots/blobs (read),
  workstation management, and live-sync WS.

**Gaps the census surfaced (now stage work-items):**

1. **No server-side session/refresh record:** the cookie is stateless today.
   Stage 2 needs a new table or DO for refresh custody. Existing D1 patterns:
   principal profiles/account links (`storage.ts:229-253`) and workstation
   credential token hashes (`storage.ts:360-371`).
2. **Identity hint:** expose `principal` and `display_name` from the session in
   the boot payload (extend `appSessionResponse`/bootstrap injection). Add
   `email`/`picture` at session mint or from `principal_profiles`, since they
   are not in the cookie today.
3. **Cross-tab propagation:** `storage$` events (`browser-signals.ts:79-94`)
   die with the keys. Replace them with a `BroadcastChannel` ping on session
   change.
4. **CSRF:** `SameSite=Lax` plus `rejectUntrustedMutationOrigin`
   (`index.ts:874-908`) rejects a *mismatched* Origin but ALLOWS a *missing*
   Origin. Tighten this to require Origin on cookie-authenticated mutations
   during the cutover.
5. **`/local-auth` dev path:** writes `localStorage`, while local OIDC is
   already the default dev flow. Convert `/local-auth` to a dev cookie mint or
   delete it with the cutover.
6. **Stale key cleanup:** the expired-token-never-removed behavior
   (`oidc-auth.ts:111-130`) goes away with the keys. Stage 4's boot cleanup
   must still `removeItem` all five keys.

## Risks / open questions

- **Anaconda IdP specifics:** refresh-token rotation policy, whether a
  confidential client is available, and token endpoint rate behavior under
  server-side refresh.
- **Offline-ish instant-paint matching:** instant-paint principal matching must
  keep working with cached pixels and no network, so the identity hint needs to
  persist across reloads offline. An explicitly non-credential display-claims
  cache is acceptable (it is not auth material), or the matcher can key on the
  last SSR-delivered principal.
- **Session TTL semantics change:** today the OIDC token (5-min dev / IdP-set
  prod) and the 6h sliding cookie are independent. Server refresh custody ties
  cookie renewal to refresh-token validity. Pick the sliding-window policy
  deliberately (for example, renew the cookie while the refresh token is
  exercisable).
- **Workstation/CLI flows:** these are API-token based and uncoupled (census
  confirms), so no changes are needed there.
