# Cookie-first auth: getting the browser out of the token business

Status: memo. Proposes moving all browser auth material out of localStorage
into HttpOnly cookies with server-side code exchange and server-owned refresh
custody, to enable authenticated SSR and collapse the dual-authority auth
states. Prompted by Kyle (2026-07-08): "Can we get off localStorage at all to
enable us to go all in on cookies? I'm hoping we can do some SSR at some
point."

Companion memo: `instant-paint-validity-ssr.md` identified the SSR opening the
app-session cookie creates and the presence-vs-validity gap in instant-paint's
gate; this memo is the migration plan that takes that opening. Stage 2's
identity hint should carry validity (session freshness), not just presence,
closing that memo's concern as a side effect.

## Problem

Cloud viewer auth today is localStorage-first: the OIDC access+refresh tokens,
claims, and the PKCE request state all live in `localStorage`; the HttpOnly
app-session cookie is minted *from* the token by the client
(`POST /api/auth/session`). Two consequences:

1. **No authenticated SSR.** The Worker cannot render authenticated HTML on a
   first navigation because the credential lives in JS storage it can't see.
   Everything app-shell (#3928's skeleton chain, the `/n` cold load) is a
   client-side bootstrap workaround for this one fact.
2. **Two auth authorities that disagree transiently.** The 2026-07-07 QA pass
   catalogued the split-brain states directly: signed-in chrome over
   "sign in to list notebooks" (design-doc state 2b), color-only session-expiry
   on Home, a client-side renewal driver whose laziness needed a root-cause
   investigation to understand (cloud-auth-store.ts:478-488 freshness guard).
   Every one of these exists because the browser holds a second copy of the
   truth.

Also: tokens in localStorage are exfiltratable by any XSS. HttpOnly cookies
are not.

## Target architecture

The session cookie becomes the *only* browser-held credential. Tokens never
reach JavaScript.

1. **Server-side code exchange.** `/oidc` becomes a Worker route: it holds the
   PKCE verifier (set as a short-lived HttpOnly cookie when the worker mints
   the authorize redirect), exchanges the code at the IdP, creates the session,
   sets the `__Host-` session cookie, and 302s to the return URL. PKCE works
   fine with a public client server-side; no client secret required, though we
   can add one if Anaconda issues it.
2. **Server-owned refresh custody.** The refresh token is stored server-side,
   encrypted (in the session record: D1 row or DO storage keyed by session id;
   the per-deploy session secret already exists for HMAC). Session middleware
   refreshes the IdP token when the session record needs it. The entire client
   renewal driver (`runRefreshOidc`, `refreshStoredOidcToken`,
   `renewIfNeeded`, the interval/focus/visibility exhaustMap) is deleted.
3. **SSR bootstrap becomes total.** The Worker already injects `initialSession`
   and the notebook list bootstrap; with the cookie as the sole authority it
   can server-render any app-owned page (`/n`, `/workstations`, room shell)
   authenticated on first byte. Identity claims the client needs pre-network
   (instant-paint principal matcher, avatar seed) ride the boot payload as a
   server-rendered identity hint - display claims only, never credentials.
4. **Clean cutover.** The localStorage token path is deleted in the same arc,
   not left as a fallback (no dual-authority period beyond the migration
   itself). Sign-out = `DELETE /api/auth/session` + cookie clear; nothing else
   to scrub.

## What stays as-is (existing doctrine)

- **Room WebSocket auth is already cookie-first.** Per
  `hosted-credential-transport.md`, the browser live-room WS authenticates
  with the app-session cookie when available, under strict Origin checks and
  mixed-credential rejection (`src/index.ts:752+`); explicit bearer/dev
  subprotocols are the no-session fallback, and tickets are explicitly not
  the current path. Cookie-first just makes the cookie path the only browser
  path. (The frontend-dev skill text still says "explicit/ticketed" - align
  it with the ADR during the revision; `instant-paint-validity-ssr.md`
  repeats the same stale phrasing.)
- **The isolated output-frame origin stays cookie-less.** Frames get blob
  URLs/tickets, never ambient credentials.
- **Desktop/daemon auth is untouched** - different transport, different
  doctrine.
- **Dev loopback mode**: the dev issuer flow works identically (it's just an
  issuer); the `/local-auth` dev-token path becomes a dev-only cookie mint.

## Decisions required (the ADR-revision surface)

1. `docs/adr/hosted-credential-transport.md` Decision 2 describes the browser
   running the Authorization Code + PKCE exchange and bridging the validated
   bearer into the app-session cookie. The localStorage-verifier custody is
   implementation detail (the `oidc-auth.ts` module comment), not ADR-stated
   rationale - but the decision text still specifies a client-side exchange,
   so moving it server-side is an ADR revision.
2. Refresh-token storage shape: encrypted blob inside the session cookie
   (stateless, size-bounded) vs server-side record in D1/DO (revocable,
   list-able, enables "sign out everywhere"). Recommendation: server-side
   record - we already have D1, and revocability is worth the row.
3. CSRF posture: `__Host-` + SameSite=Lax covers navigation; mutating API
   routes should get origin-check or token-header enforcement as part of the
   cutover (cheap in the Worker middleware).
4. Session TTL + sliding renewal policy (today's TTL: census pending).

## Migration stages

Each stage ships independently; the system works at every point.

- **Stage 0 (done, incidentally):** app-session cookie exists; server bootstrap
  injects `initialSession`; most API routes already accept the cookie.
- **Stage 1: server-side callback, behind a flag.** Worker-side `/oidc`
  exchange + flow-cookie PKCE. Sessions minted this way never materialize a
  localStorage token - the Worker must not re-expose tokens to JS, so there
  is deliberately NO transitional dual-write. The client already tolerates
  session-without-token (everything rides the cookie; the renewal driver
  no-ops without a stored token - verified in the 2026-07-07 renewal
  investigation), but the minimal identity hint (principal + display_name,
  already in the session record) must join the boot payload in this stage so
  instant-paint and the avatar work for flag-on sessions. The client-side
  flow stays intact as code for rollback. ADR revision lands here.
- **Stage 2: server refresh custody.** Refresh token moves into the new
  server-side session record; client renewal driver deleted; the flag
  defaults on; full display claims (`email`, `picture`) join the identity
  hint via session-mint enrichment or `principal_profiles`. The big client
  deletion.
- **Stage 3: SSR.** Server-render `/n` and `/workstations` authenticated;
  room shell SSR as a follow-on. This is where the #3928 arc closes for real.
- **Stage 4: cleanup.** Delete dev-token localStorage path, delete
  `oidc-token`/`oidc-request` key handling, migration note for stale keys
  (one-time `removeItem` on boot).

## Current-state census (verified against code, 2026-07-08)

Key facts from the full reader/writer census (file:line citations live in the
census output; highlights here):

**Storage keys.** Five auth keys: `oidc-token` (access+refresh+claims;
`oidc-auth.ts:51-65,630-648`; an expired token is never removed - expired
claims still seed UI), `oidc-request` (PKCE verifier/state/returnUrl, one
round-trip lifetime), and the dev triplet `dev-token`/`user`/`scope`
(`dev-auth-storage.ts:3-6`, written by `/local-auth` at `index.ts:552-568`).
Plus one auth-*keyed* non-credential: the notebook list cache
(`notebook-list-cache.ts:12-13`) keys entries by dev user or OIDC `sub`.

**Consumer dispositions.**
- *Delete*: the entire client renewal loop - `runRefreshOidc`
  (`cloud-auth-store.ts:467-515`), `storedOidcTokenNeedsRefresh`,
  `refreshStoredOidcToken`, the refresh-token exchange
  (`oidc-auth.ts:464-497`).
- *Replace with server callback*: the token->cookie bridge
  (`app-session.ts:41-70` Bearer POST, `renewIfNeeded`
  `cloud-auth-store.ts:517-552`, callback establish
  `oidc-callback-standalone.ts:92-117`) and the PKCE round trip
  (`beginOidcLogin`/`completeOidcRedirect`, `oidc-auth.ts:286-365`).
- *Needs identity hint*: instant-paint principal matcher (OIDC `sub`,
  `cloud-principal.ts:37-58`), the synchronous pre-React auth seed
  (`cloud-auth-store.ts:198-209,254-263`), avatar/display fallbacks
  (`claims.name/email/picture`), and list-cache keying.
- *Already cookie*: non-dev browser API fetches send `{}` headers with
  same-origin credentials today (`collaborator-auth.ts:276-300`);
  `syncAuthConnectionKey` collapses to `"app-session"` whenever a session
  exists. The raw bearer only rides the WS as a *fallback* when no session
  exists (`live-sync.ts:1011-1044`).
- *Stays bearer by design*: machine paths - workstation events/attach-job,
  `POST /api/workstations`, artifact/blob PUTs - are agent/CLI credentials,
  not browser sessions.

**Server side.** The app-session cookie is *self-contained and signed*
(`app-session.ts:17-31`): `principal`, `ns`, `display_name`, `provider`,
`iat`, `exp`, `sid`. TTL 6h, sliding renewal under half-life; secret
`NOTEBOOK_CLOUD_APP_SESSION_SECRET` (min 32 chars). The public session
response exposes only provider/expiry/cache_key. Of the claims the client
needs, `principal` (from which the OIDC `sub` is derivable - the principal
suffix IS the encoded sub, which is exactly what `cloud-principal.ts:46+`
matches on) and `display_name` are already in the cookie; `email` and
`picture` are NOT and must be added at session mint or served from the
`principal_profiles` table. WS upgrade has a first-class
cookie path that rejects mixed credentials (`index.ts:737-872`). Boot already
injects `#nteract-cloud-auth-config` + `#nteract-cloud-bootstrap` with
`initialSession`. Cookie-compatible coverage is already broad: list, catalog,
sharing/ACL/invites/access-requests, profiles, snapshots/blobs (read),
workstation management, live-sync WS.

**Gaps the census surfaced (now stage work-items):**
1. No server-side session/refresh record exists (cookie is stateless) - Stage
   2 needs the new table/DO for refresh custody. D1 has tables to pattern
   after: principal profiles/account links (`storage.ts:229-253`) and
   workstation credential token hashes (`storage.ts:360-371`).
2. The identity hint = expose principal + display_name from the session into
   the boot payload (extend `appSessionResponse`/bootstrap injection); add
   `email`/`picture` at session mint or from `principal_profiles` (they are
   not in the cookie today).
3. Cross-tab propagation: `storage$` events (`browser-signals.ts:79-94`) die
   with the keys; replace with a BroadcastChannel ping on session change.
4. CSRF: `SameSite=Lax` + `rejectUntrustedMutationOrigin`
   (`index.ts:874-908`) rejects a *mismatched* Origin but ALLOWS a *missing*
   Origin - tighten to require Origin on cookie-authenticated mutations
   during the cutover.
5. `/local-auth` is a localStorage-writing dev path; local OIDC is already the
   default dev flow, so `/local-auth` either converts to a dev cookie mint or
   is deleted with the cutover.
6. The expired-token-never-removed behavior (`oidc-auth.ts:111-130`) goes away
   with the keys, but Stage 4's boot cleanup must `removeItem` all five keys.

## Risks / open questions

- Anaconda IdP specifics: refresh-token rotation policy, whether a confidential
  client is available, token endpoint rate behavior under server-side refresh.
- Instant-paint principal matching must keep working offline-ish (cached pixels
  keyed to a principal with no network): the identity hint needs to persist
  across reloads without the network - an explicitly non-credential
  display-claims cache is acceptable (it's not auth material), or the matcher
  keys on the last SSR-delivered principal.
- Session TTL semantics change: today the OIDC token (5-min dev / IdP-set prod)
  and the 6h sliding cookie are independent; server refresh custody ties cookie
  renewal to refresh-token validity - pick the sliding-window policy
  deliberately (e.g. cookie renews while the refresh token is exercisable).
- Workstation/CLI flows are API-token based and uncoupled (census confirms) -
  no changes there.
