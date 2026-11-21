# Hosted Credential Transport and OIDC Binding

**Status:** Draft, 2026-05-24.

## Context

Hosted notebook rooms need browser, desktop, agent, and runtime clients to open
typed-frame v4 WebSockets without putting long-lived credentials in URLs or
trusting client-stamped identity headers.

`identity-and-trust.md` defines the principal/operator actor-label model, and
`hosted-room-authorization.md` makes D1 ACL rows the room authority. This ADR
defines how credentials reach the hosted room across direct OIDC, JupyterHub,
browser WebSockets, native clients, and paired workstations.

Key constraints:

- Browsers cannot set arbitrary `Authorization` headers on `new WebSocket(...)`.
- WebSocket authentication happens during the initial HTTP upgrade; every later
  sync frame is authorized against that established connection identity.
- Cookies on WebSocket upgrades are convenient for same-site browser sessions
  but introduce CSRF risks if a third-party page opens a credentialed socket.
- JupyterHub deployments prefer Hub tokens over Hub cookies for API and
  WebSocket clients because cookie auth adds CSRF handling.
- Anaconda is an OIDC identity provider, so the Worker validates Anaconda-issued
  OIDC tokens directly.
- `preview.runt.run` uses stage Anaconda OIDC redirecting to `/oidc`, following
  the `app.runt.run` production OIDC precedent from `runtimed/intheloop`.

## Decision 1: Credential transport is separate from identity provider

Three layers stay distinct:

- **Credential transport** answers how the listener received proof.
- **Identity provider validation** answers who the proof authenticates.
- **Room ACL authorization** answers what that principal may do in this room.

The listener normalizes transport-specific inputs into one credential:

- Bearer token from `Authorization` for native clients.
- Bearer token from a non-echoed WebSocket subprotocol for browser token
  clients.
- One-time WebSocket ticket issued by the host (future option).
- Provider or app-session cookie where the deployment owns origin/CSRF policy.
- Unix peer credentials for local rooms.

Each connection may present at most one identity-bearing credential transport.
If a bearer header, subprotocol token, ticket, or cookie appear together and
could authenticate different principals, the listener rejects the upgrade
instead of picking one ("first credential wins" invites confused-deputy bugs
between JavaScript tokens and ambient cookies).

Provider validation yields:

- canonical `principal`;
- provider maximum capability set;
- optional display/audit metadata (such as email).

The room ACL derives final connection scope. Provider claims or groups may cap
global capabilities, but never grant per-notebook `editor` or `owner` access on
their own.

## Decision 2: Direct OIDC bootstraps hosted app sessions for preview

For the Anaconda-hosted preview, the notebook application runs the OIDC browser
flow directly and uses a first-party app-session cookie for browser APIs and
live-room WebSockets:

1. Browser visits the notebook host.
2. The viewer/editor shell runs OIDC Authorization Code + PKCE against the
   configured issuer.
3. The issuer redirects back to `/oidc`.
4. The browser exchanges the validated OIDC bearer at `/api/auth/session` for a
   first-party `HttpOnly`, `Secure`, `SameSite=Lax` app-session cookie.
5. First-party browser HTTP API calls use the app-session cookie with
   same-origin credentials.
6. Browser live-room WebSockets also use the app-session cookie, gated by a
   trusted `Origin` check. The Worker rejects missing or untrusted origins and
   rejects mixed app-session cookies plus bearer/dev credentials. It forwards
   only trusted identity headers and the non-sensitive `nteract.v4` subprotocol
   to the Durable Object.
7. The browser keeps OIDC token state only for sign-in renewal and refreshing
   the app-session cookie. Sandboxed output frames stay on the isolated output
   origin and never receive app-session cookies, OIDC material, or app-origin
   `localStorage`.
8. Native, CLI, agent, and runtime clients send
   `Authorization: Bearer <access-token>` directly on HTTP and WebSocket
   requests.
9. The Worker validates the OIDC JWT signature, issuer, audience/client ID,
   expiry, and not-before claims against provider JWKS before checking room
   ACLs.
10. The Durable Object trusts only Worker-stamped headers, never browser-supplied
    identity headers.

Cloudflare hosts the Worker, Durable Object, D1, R2, assets, and custom domain,
but does not own the user's login session.

### Staging and production OIDC lanes

| Lane | Host | Issuer | Client ID | Redirect URI | Output origin |
|------|------|--------|-----------|--------------|---------------|
| Local dev | `localhost:5173` | `https://auth.stage.anaconda.com/api/auth` | `b7296d39-c1eb-49f4-b9a1-f36e6d5b8b6d` | `http://localhost:5173/oidc` | local |
| Staging (`notebook-cloud`) | `preview.runt.run` | `https://auth.stage.anaconda.com/api/auth` | `cec4781f-853c-4267-bf09-4bc59a2a3750` | `https://preview.runt.run/oidc` | `https://preview.runtusercontent.com` |
| Production precedent | `app.runt.run` | `https://auth.anaconda.com/api/auth` | `74a51ff4-5814-48fa-9ae7-6d3ef0aca3e2` | `https://app.runt.run/oidc` | `https://runtusercontent.com` |

`preview.runt.run` is the `notebook-cloud` staging lane and preserves the `/oidc`
redirect URI and deployment variables. `app.runt.run` is production OIDC
precedent, not a `notebook-cloud` target.

### Principal namespace for direct OIDC login

A principal namespace names the validated identity authority. Anaconda-issued
OIDC tokens map to:

```text
user:anaconda:<encoded-anaconda-sub>
```

Email is display and invite UX metadata, never the stable principal key. Any
future OIDC provider must use its own namespace and an explicit subject-mapping
or ACL backfill plan before linking to Anaconda subjects.

## Decision 3: Browser WebSocket bearer tokens use subprotocols as an explicit fallback

When a browser client authenticates with a bearer token instead of an
app-session cookie, send it in a WebSocket subprotocol rather than a query
parameter:

```text
Sec-WebSocket-Protocol:
  nteract-bearer.<base64url-token>, nteract.v4
```

The Worker peels off and validates the credential subprotocol, strips it before
forwarding to the room host, and selects only `nteract.v4` in the upgrade
response (or no subprotocol if the client omitted `nteract.v4`). Credential
subprotocols must never be echoed back or copied into trusted room headers;
tests must assert this.

Subprotocols keep bearer tokens out of URLs, browser history, referrers, and
route metrics. Because page JavaScript and header-logging proxies can still see
the token, this is bearer auth, not proof-of-possession.

Subprotocol bearer auth is a supported fallback (not the default when an
app-session cookie exists) for:

- browser clients holding an OIDC token from an app login flow;
- browser clients talking to hosts without cookies or perimeter assertions;
- future JupyterHub browser paths where the page can fetch a short-lived token.

Deployed dev-token smoke tests currently use a separate `nteract-dev-token.*`
prefix; consolidating it under `nteract-bearer.*` is tracked in
[Open Follow-ups](#open-follow-ups).

## Decision 4: One-time tickets are a future hardening bridge, not the preview default

One-time tickets let a browser authenticate a WebSocket upgrade without sending
the underlying credential on the upgrade request:

1. Browser calls `POST /api/session-tickets` over HTTPS with its real
   credential.
2. Server validates the credential and stores a single-use, short-lived ticket
   (seconds TTL) bound to notebook ID, requested role, principal, operator,
   origin, and expiry.
3. Browser opens `wss://.../n/<id>/sync?ticket=<opaque-ticket>`.
4. Listener atomically consumes the ticket before accepting the upgrade.

Ticket consumption must be atomic — for example, a single D1
`DELETE ... RETURNING`, compare-and-swap, or serialized Durable Object gate. A
read-then-delete check is unsafe against concurrent upgrades. Because query
strings can still reach CDN, WAF, or Worker analytics before consumption,
tickets remain a narrow fallback behind non-echoed subprotocols or
deployment-owned cookie/origin policies.

Tickets are not used in preview because minting a short-lived ticket on every
open and reconnect complicates reconnect failure handling without improving over
same-origin cookie upgrades plus strict `Origin` checks. Reintroducing tickets
requires reconnect diagnostics, browser reload/flaky-socket smoke coverage, and
a demonstrated security gain.

## Decision 5: Provider cookies are deployment-specific, not generic

Cookies are allowed only when the deployment explicitly owns CSRF and origin
policy.

`notebook-cloud`'s app-session cookie meets that bar: it works on first-party
browser APIs and trusted-origin live-room WebSocket upgrades, and is rejected
from renderer asset origins and isolated output origins.

For JupyterHub:

- Prefer Hub-issued tokens for native and API clients.
- Use subprotocol bearer tokens or one-time tickets for browser WebSockets when
  the page can obtain a short-lived token.
- Reserve Hub cookies for same-site Hub-hosted pages that enforce Hub CSRF and
  origin checks. Tokens remain the cleaner default.

## Decision 6: Native, agent, and runtime clients use headers

Non-browser clients use `Authorization: Bearer ...` on WebSocket upgrades and
HTTP requests whenever the platform permits:

- desktop daemons connecting to hosted rooms;
- CLI and TUI clients;
- local or hosted agent processes;
- remote runtime sidecars and kernel services.

Stronger replay protection (DPoP, proof-of-possession, mTLS, device posture,
short token lifetimes) can layer onto this transport without changing the
typed-frame wire protocol.

## Decision 7: Requested role is explicit and bounded

Authenticated clients request one role: `viewer`, `editor`, `runtime_peer`, or
`owner`.

The Worker checks:

```text
effective = requested_role
allowed if capabilities(requested_role)
  subset_of provider_max_capabilities
  and subset_of acl_capabilities_for_principal
```

If the check fails, reject mutation routes and non-browser clients rather than
silently downgrading to `viewer` (silent downgrades hide permission errors until
later writes).

Same-origin browser live-room WebSockets have one narrow public-room fallback:
if a signed-in user requests `editor` without an editor ACL row on a room with
an explicit public-read ACL row, the Worker stamps the connection as `viewer`.
Document and runtime mutations are still rejected by the room host, and HTTP
mutation routes never downgrade. The intended UI connects as `viewer` by default
and reconnects as `editor` only when the user requests editing.

Anonymous requests have provider maximum capabilities of exactly `viewer` and
succeed only with a public-read ACL row. Identity providers never need to encode
per-notebook room roles; they bound global capabilities while D1 ACL rows grant
room scopes.

## Decision 8: Origin checks are part of browser WebSocket auth

Every browser-accessible WebSocket credential requires a Worker origin gate:

- Reject cookie-backed and forwarded-assertion WebSocket upgrades with missing
  or untrusted `Origin`, for both viewers and writers (a private viewer socket
  still leaks notebook contents).
- Reject browser-visible credential subprotocol upgrades with missing or
  untrusted `Origin`.
- Allow same-origin notebook pages by default and extend via
  `NOTEBOOK_CLOUD_ALLOWED_ORIGINS`.
- Never allow sandboxed output iframes or renderer asset origins to open
  authenticated notebook-room WebSockets.
- Keep renderer asset origins and output-document origins separate from
  notebook-room origins (`hosted-output-origin-isolation.md`).

Header-authenticated CLI, native, and runtime clients may omit `Origin`, but any
supplied `Origin` must be valid and trusted.

## Decision 9: Workstation pairing codes mint scoped workstation credentials

Remote workstation agents register through short-lived pairing codes instead of
holding a full-user Anaconda API key, OIDC token, or dev token. This keeps
registration provider-neutral and least-privilege.

### Flow

1. A signed-in owner mints a pairing code via
   `POST /api/workstations/pairing-codes`. The code is a 12-character
   unambiguous string (~59 bits of entropy), valid for 10 minutes, single-use,
   and stored hashed. Cleartext is returned only in this response.
2. The remote agent redeems the code via
   `POST /api/workstations/pairing-codes/redeem` (the code is the sole
   credential) and receives a revocable workstation token (`nwc_` prefix,
   256-bit random, stored hashed).
3. The agent registers and heartbeats with `Authorization: Bearer nwc_...`. The
   owner's browser polls `GET /api/workstations/pairing-codes/:id` (owner auth)
   through `pending` -> `redeemed` -> `registered`.

### Security properties and persistence model

- **Owner-scoped principal:** Each `nwc_` token resolves to the minting owner's
  canonical principal, so existing owner-principal `runtime_peer` ACL rows and
  room WebSocket dials work without change. Tokens bind to the owner rather than
  one workstation ID, so one token can serve multiple registrations from the
  same host.
- **Deny-by-default central allowlist:** Enforced in the central request-auth
  wrapper rather than per-route opt-outs. `nwc_` tokens authenticate only the
  workstation surface (registration/heartbeat, attach-job SSE stream, fallback
  attach-job polling, status patches) and room WebSocket dials, capped to
  `viewer` or `runtime_peer` scope. Every other route rejects them.
- **Brute-force resistance:** ~59 bits of entropy prevents code guessing, which
  matters because first registration auto-selects the owner's default
  workstation target.
- **Atomic single-use redeem:** Code consumption and credential creation commit
  in one atomic D1 batch keyed by a per-request `redeemed_by_credential_id`
  marker, preventing both burned-without-mint failures and same-millisecond
  concurrent double-mints.
- **Revocable rows without expiry:** Credentials stay valid until revoked via
  `revoked_at`. Owners list tokens at `GET /api/workstations/credentials` and
  revoke them at `POST /api/workstations/credentials/:id/revoke` (both
  owner-auth only, so a stolen `nwc_` token cannot enumerate or revoke sibling
  tokens). Short-lived attachment tickets (Decision 4) remain the hardening path
  for deployments that disallow long-lived agent tokens.

## Open Follow-ups

- **Verify browser session renewal across reloads and tabs:** Prove app-session
  cookie and OIDC refresh behavior across reloads, reconnects, and multiple tabs
  before private notebooks expand, so stale OIDC refresh state never triggers
  spurious sign-in prompts while the app session remains valid.
- **Expose explicit provider maximum capabilities:** Replace the prototype's
  implicit `owner` bound on dev credentials with explicit provider capability
  sets derived from OIDC and JupyterHub claims before broad deployment.
- **Add live revocation via `SESSION_CONTROL`:** Close active WebSockets on
  admin revocation or provider sign-out rather than waiting for natural
  disconnect.
- **Retire `nteract-dev-token.*` subprotocol prefix:** Migrate deployed
  dev-token smoke tests onto `nteract-bearer.*` once payloads carry issuer
  metadata.

## Open Questions

1. **Additional OIDC providers:** If a public `runtimed.com` viewer validates a
   second OIDC provider, define its principal namespace and subject-linking
   strategy up front.
2. **Invite-by-email:** D1 ACLs key by principal while people share by email;
   see `docs/prd/hosted-sharing-invites.md` for pending invites, first-login
   resolution, display metadata, and public viewer UX.
3. **Service-token runtime peers:** Choose the credential path for non-paired
   runtime sidecars (Anaconda scoped credentials, OIDC machine credentials, or
   host-issued runtime tickets).
4. **Per-workstation credential binding:** Decide whether shared multi-user
   hosts need `nwc_` credentials bound to one workstation ID at redeem time
   rather than to the owner.

## References

- `docs/adr/identity-and-trust.md` — principals, operators, providers, actor
  validation, and base credential vocabulary.
- `docs/adr/hosted-room-authorization.md` — room ACLs and scope derivation.
- `docs/runbooks/hosted-direct-oidc-demo-runbook.md` — direct OIDC Anaconda demo
  deployment and smoke steps.
- `docs/prd/hosted-sharing-invites.md` — email invite to principal ACL
  resolution.
- `docs/adr/hosted-output-origin-isolation.md` — output document, renderer
  asset, and blob-origin separation.
- `apps/notebook-cloud/src/identity.ts` — OIDC and dev-token credential
  extraction.
- Cloudflare WebSockets docs:
  `https://developers.cloudflare.com/network/websockets/`
- JupyterHub services auth implementation: `jupyterhub/services/auth.py`
- PR #2801 review discussion:
  `https://github.com/nteract/nteract/pull/2801#pullrequestreview-4348156180`
  and
  `https://github.com/nteract/nteract/pull/2801#discussion_r3290622903`
