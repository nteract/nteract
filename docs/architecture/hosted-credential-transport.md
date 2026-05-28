# Hosted Credential Transport and OIDC Binding

**Status:** Draft, 2026-05-24.

## Context

Hosted notebook rooms need browser, desktop, agent, and future runtime clients to
open the same typed-frame v4 WebSocket without putting long-lived credentials in
URLs or trusting client-stamped identity headers.

The base identity ADR (`identity-and-trust.md`) already decides the principal /
operator actor-label model and the per-room ACL model. The hosted authorization
ADR (`hosted-room-authorization.md`) already decides that D1 ACL rows are the
room authority. This ADR decides how credentials reach the hosted room and how
direct OIDC providers, optional Cloudflare Access deployments, JupyterHub,
native clients, and browser WebSockets fit into that model.

Important constraints:

- Browsers cannot set arbitrary `Authorization` headers on `new WebSocket(...)`.
- A WebSocket is authenticated during the initial HTTP upgrade. After upgrade,
  every sync frame is authorized against the connection state established at
  open.
- Cookies on WebSocket upgrades are convenient for same-site browser sessions
  but create CSRF/origin concerns because another site can attempt a
  credentialed WebSocket to the protected origin.
- JupyterHub deployments often prefer Hub tokens over Hub cookies for API and
  WebSocket clients. Cookie auth can work, but it is not the generic Hub
  recommendation because Hub cookie flows also bring CSRF handling.
- Anaconda is an OIDC identity provider. The earlier Cloudflare Access path
  added a second paid auth product in front of credentials we already control,
  so the first hosted notebook-cloud path should validate Anaconda-issued OIDC
  tokens directly in the Worker.
- `runtimed/intheloop` already has deployed OIDC precedent: `app.runt.run`
  uses production Anaconda OIDC, while `preview.runt.run` uses stage Anaconda
  OIDC and redirects to `/oidc`. The preview app is no longer the active
  prototype, so notebook-cloud can take over that staging domain and OIDC
  client.

## Decision 1: Credential transport is separate from identity provider

Credential transport answers "how did the listener receive proof?" Identity
provider validation answers "who does this proof authenticate?" Authorization
answers "what may this principal do in this notebook room?"

The listener normalizes transport-specific inputs into a credential:

- Access assertion header from Cloudflare Access.
- Access token header from `cloudflared access token` / CLI clients.
- Bearer token from `Authorization` for native clients.
- Bearer token from a WebSocket subprotocol for browser clients that already
  hold a token.
- One-time WebSocket ticket issued by the host.
- Provider cookie for deployments that deliberately choose cookie auth.
- Unix peer credentials for local rooms.

Exactly one identity-bearing credential transport is accepted for a connection.
If a request presents multiple credentials, the listener rejects it unless the
deployment has explicitly defined that combination as one credential. The common
exception is Cloudflare Access: an Access application cookie and the
`Cf-Access-Jwt-Assertion` derived from it are one Access credential, and the
Worker validates the assertion rather than treating the cookie as an independent
provider credential.

Do not rely on "first credential wins" behavior. If an Access assertion, bearer
header, subprotocol token, or ticket appear together and could authenticate
different principals, reject the upgrade instead of choosing one silently. This
prevents confused-deputy bugs where JavaScript supplies one identity while an
ambient cookie supplies another.

The provider validates the normalized credential and yields:

- principal
- provider maximum capability set
- optional identity metadata for display and audit, such as email

The room ACL still derives final connection scope. A provider claim or group may
cap what the credential can do globally, but it does not grant per-notebook
editor or owner access by itself.

## Decision 2: Direct OIDC is the hosted browser path for preview

For the Anaconda-friendly hosted demo, the notebook application owns the OIDC
browser flow directly:

1. Browser visits the notebook host.
2. The viewer/editor shell starts an OIDC Authorization Code + PKCE flow against
   the configured issuer.
3. The OIDC provider redirects back to the notebook host's `/oidc` callback.
4. The browser stores the short-lived access token in origin-local storage and
   refreshes it through the normal OIDC refresh path.
5. Browser HTTP requests use `Authorization: Bearer <access-token>` when the
   platform allows headers.
6. Browser WebSockets use the non-echoed credential subprotocol
   `nteract-bearer.<base64url-token>` plus the application protocol
   `nteract.v4`.
7. Native, CLI, agent, and runtime clients use `Authorization: Bearer
   <access-token>` directly on HTTP and WebSocket requests.
8. The Worker validates the OIDC JWT signature, issuer, audience/client id,
   expiry, and not-before claims against the provider JWKS before calling the
   room ACL authorization path.
9. The Durable Object receives only trusted headers stamped by the Worker. It
   never trusts browser-provided identity headers.

This removes Cloudflare Access from the default auth path. Cloudflare still
hosts the Worker, Durable Object, D1, R2, assets, and custom domain, but it does
not own the notebook user's login session for this deployment.

### Staging and production domain reuse

The existing `runtimed/intheloop` Wrangler configuration records the OIDC lanes
we should reuse:

| Lane | Host | Issuer | Client id | Redirect URI | Output origin |
|------|------|--------|-----------|--------------|---------------|
| Local dev | `localhost:5173` | `https://auth.stage.anaconda.com/api/auth` | `b7296d39-c1eb-49f4-b9a1-f36e6d5b8b6d` | `http://localhost:5173/oidc` | local |
| Staging takeover | `preview.runt.run` | `https://auth.stage.anaconda.com/api/auth` | `cec4781f-853c-4267-bf09-4bc59a2a3750` | `https://preview.runt.run/oidc` | `https://preview.runtusercontent.com` |
| Production precedent | `app.runt.run` | `https://auth.anaconda.com/api/auth` | `74a51ff4-5814-48fa-9ae7-6d3ef0aca3e2` | `https://app.runt.run/oidc` | `https://runtusercontent.com` |

Notebook-cloud uses `preview.runt.run` as the staging route. The route transfer
from the old `runtimed/intheloop` preview Worker is historical context; current
work should keep the same OIDC redirect URI and deployment variables. The
production `app.runt.run` lane is precedent, not the notebook-cloud target.

### Principal namespace for direct OIDC login

A principal namespace must name the authority whose credential we validated.

If the Worker validates an Anaconda-issued OIDC token, the principal is
Anaconda-scoped:

```text
user:anaconda:<encoded-anaconda-sub>
```

Email is display metadata and invite UX material; it is not the stable
principal key. If a later deployment validates another OIDC provider, it must
use a provider-specific namespace and include an explicit subject mapping or
ACL-row backfill plan before linking those users to Anaconda subjects.

## Decision 3: Browser WebSocket bearer tokens use subprotocols

When a browser has a bearer token, prefer a WebSocket subprotocol credential
over a URL query parameter:

```text
Sec-WebSocket-Protocol:
  nteract-bearer.<base64url-token>, nteract.v4
```

The listener peels off the credential subprotocol, validates the token, and
selects the real application protocol (`nteract.v4`) in the response. The
credential subprotocol is not echoed back.

The "not echoed back" rule is also a prototype requirement. The hosted Worker
strips the current `nteract-access-token.*` and `nteract-dev-token.*`
credential-bearing subprotocols before it forwards the upgrade to the room
host. If the client offered the non-sensitive application protocol, the Worker
selects only `nteract.v4`; if it did not, the Worker selects no subprotocol.
Tests must assert that credential-bearing protocol elements are never returned
in upgrade responses or trusted room headers.

This is better than `?token=...` because the bearer does not enter the URL,
browser history, referrer paths, or ordinary route metrics. It is still a
bearer token visible to JavaScript and potentially to infrastructure that logs
request headers, so it is not proof-of-possession security.

Subprotocol bearer tokens are appropriate for:

- browser clients that have obtained an OIDC token through an application login
  flow;
- browser clients talking to a notebook host that is not using cookies or
  forwarded perimeter assertions as its credential transport;
- future JupyterHub browser paths if the Hub or single-user server can provide a
  short-lived token to the page.

`nteract-bearer.*` is the proposed generic bearer-token convention. The hosted
prototype currently has narrower prefixes for already-implemented paths:
`nteract-access-token.*` for Access JWTs and `nteract-dev-token.*` for deployed
dev-token smoke tests. Those prefixes can coexist while direct OIDC/JupyterHub
bearer support lands. A later cleanup may migrate them behind the generic
`nteract-bearer.*` prefix once the credential payload carries enough issuer
metadata to dispatch safely.

## Decision 4: One-time tickets are an optional bridge

One-time tickets are useful when a browser cannot safely or conveniently present
the real credential during the WebSocket upgrade.

Flow:

1. Browser sends a normal HTTPS request to `/api/session-tickets` with the real
   credential using whichever mechanism the deployment supports.
2. Server validates the credential and stores a short-lived, single-use ticket
   bound to notebook id, requested role, principal, operator, origin, and
   expiry.
3. Browser opens `wss://.../n/<id>/sync?ticket=<opaque-ticket>`.
4. Listener consumes the ticket, creates the connection identity, and deletes
   the ticket.

The ticket may appear in the WebSocket URL, but it is not the real credential.
It should expire within seconds, be single use, and be scoped to the target
room and requested role.

Ticket validation and consumption must happen before the WebSocket upgrade is
accepted. Consumption must be atomic, such as one D1 `DELETE ... RETURNING`
operation, a compare-and-swap equivalent, or a Durable Object gate that
serializes ticket use. A read-then-delete implementation is not sufficient
because two concurrent upgrade requests could both validate the same ticket.

The URL can still appear in CDN, WAF, browser, or Worker analytics before the
Worker consumes it, so tickets are a narrow fallback rather than the preferred
path for sensitive deployments. Deployments that cannot tolerate even
short-lived opaque ticket exposure should use bearer-in-subprotocol auth with
non-echoed credential subprotocols or a cookie/assertion perimeter whose origin
policy is explicitly owned by the deployment.

Tickets are not the default for the direct-OIDC demo because the browser can
present the OIDC access token as a non-echoed WebSocket subprotocol. They
remain the preferred fallback when a deployment would otherwise need to put a
long-lived bearer token in a WebSocket URL.

## Decision 5: Provider cookies are deployment-specific, not generic

Cookies are acceptable only when the deployment owns the CSRF and origin policy
for the provider.

For Cloudflare Access browser sessions:

- the cookie is the Access application session, not a notebook room token;
- the Worker validates `Cf-Access-Jwt-Assertion`, not arbitrary user headers;
- cookie-backed WebSocket upgrades must pass an explicit `Origin` allowlist;
- public viewer sockets may still use the same origin checks when cookies are
  present, so public read does not accidentally become authenticated write.

For JupyterHub:

- prefer Hub-issued tokens for native clients and API-style clients;
- browser WebSocket auth can use subprotocol bearer tokens or one-time tickets
  if the page can obtain a short-lived token;
- Hub cookies remain possible for same-site Hub-hosted notebook pages, but they
  are not the generic recommended path because they also require Hub CSRF and
  origin handling.

This corrects the earlier shorthand that "JupyterHub uses cookies." JupyterHub
can use cookies, but tokens are usually the cleaner notebook-room credential.

## Decision 6: Native, agent, and runtime clients use headers

Non-browser clients should use `Authorization: Bearer ...` on the WebSocket
upgrade when the platform allows it:

- desktop daemon connecting to a hosted room on behalf of a user;
- CLI or TUI;
- local or hosted agent process;
- remote runtime sidecar or kernel service.

Cloudflare Access service tokens are deployment-specific and not part of the
default direct-OIDC path. If a host elects to add Access as an outer perimeter,
the Worker must still validate the resulting assertion or bearer token before it
stamps trusted room headers.

Longer term replay mitigation is out of scope for this ADR. DPoP,
proof-of-possession tokens, mTLS, device posture, and short token lifetimes can
all tighten the bearer-token story without changing the typed-frame wire.

## Decision 7: Requested role is explicit and bounded

Authenticated clients request a role for the connection: `viewer`, `editor`,
`runtime_peer`, or `owner`.

The Worker computes:

```text
effective = requested_role
allowed if capabilities(requested_role)
  subset_of provider_max_capabilities
  and subset_of acl_capabilities_for_principal
```

If the check fails, reject mutation routes and non-browser system clients. Do
not silently downgrade write APIs to viewer, because a downgraded editor fails
later in harder-to-debug ways.

The browser notebook page has one narrow exception for public notebooks:
same-origin live-room WebSocket requests may fall back from a stale or eager
`editor` request to `viewer` when the notebook has an explicit public-read ACL
row and the authenticated principal lacks editor ACL rows. This keeps signed-in
users able to read public notebooks without logging out. The connected scope is
still stamped as `viewer`, viewer-authored document/runtime mutations are still
rejected by the room host, and HTTP mutation routes do not use this downgrade.
The intended UI is to connect as `viewer` by default and reconnect with
`editor` only after the user requests editing.

Anonymous requests have provider maximum capabilities of exactly viewer and are
accepted only if the room has a public-read ACL row.

This answers the central authorization question: the identity provider does not
need to encode nteract room roles. It may bound global capabilities, but D1 room
ACL rows grant notebook-specific scopes.

## Decision 8: Origin checks are part of browser WebSocket auth

Any credential that rides automatically with browser requests requires an
origin gate for WebSocket upgrades.

Minimum policy:

- Reject cookie-backed and forwarded assertion-backed WebSocket upgrades with
  missing or untrusted `Origin`. This applies to viewer and writer
  connections. A private viewer socket can still leak notebook contents to a
  malicious page if ambient cookies are enough to authenticate it.
- Reject browser-visible credential subprotocol upgrades with missing or
  untrusted `Origin`, because page JavaScript can initiate those connections.
- Maintain an allowlist of notebook application origins that are allowed to
  initiate room WebSockets. The hosted Worker treats same-origin notebook pages
  as allowed by default and extends that set with
  `NOTEBOOK_CLOUD_ALLOWED_ORIGINS`.
- Do not allow sandboxed output iframes or renderer asset origins to open
  authenticated notebook-room WebSockets.
- Keep renderer asset origins and output-document origins separate from
  notebook-room origins. `hosted-output-origin-isolation.md` defines that
  origin split.

Header-authenticated CLI, native, and runtime clients may omit `Origin` even
when an allowlist is configured. If any client sends `Origin`, malformed or
untrusted values are rejected. One-time ticket flows still benefit from origin
checks, but they do not rely on ambient cookies and therefore reduce CSRF risk.

## Operational path for the Anaconda demo

The exact deployment steps, direct OIDC variables, route takeover, and smoke
shape live in `docs/architecture/hosted-direct-oidc-demo-runbook.md`.

1. Transfer `preview.runt.run` from the retired `runtimed/intheloop` preview
   Worker to notebook-cloud.
2. Reuse the existing Anaconda stage OIDC client:
   - issuer: `https://auth.stage.anaconda.com/api/auth`
   - client id: `cec4781f-853c-4267-bf09-4bc59a2a3750`
   - redirect URI: `https://preview.runt.run/oidc`
3. Configure Worker OIDC validation:
   - `NOTEBOOK_CLOUD_OIDC_ISSUER`
   - `NOTEBOOK_CLOUD_OIDC_AUDIENCE` or `NOTEBOOK_CLOUD_OIDC_CLIENT_ID`
   - optional pinned `NOTEBOOK_CLOUD_OIDC_JWKS_JSON`
   - `NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=user:anaconda`
4. Configure viewer OIDC in the Worker runtime shell:
   - `NOTEBOOK_CLOUD_OIDC_ISSUER`
   - `NOTEBOOK_CLOUD_OIDC_CLIENT_ID`
   - `NOTEBOOK_CLOUD_OIDC_REDIRECT_URI`
5. Keep credential subprotocol stripping covered by tests. The listener must
   return only a non-sensitive application protocol such as `nteract.v4`, never
   `nteract-access-token.*`, `nteract-dev-token.*`, or `nteract-bearer.*`.
6. Configure `NOTEBOOK_CLOUD_ALLOWED_ORIGINS` for any notebook application
   origin that is not the Worker origin itself.
7. Keep notebook sharing in D1 ACL rows:
   - owner row created at publish/import;
   - explicit collaborator rows for editors;
   - optional public-read row for anonymous viewers.
8. Display provider metadata such as email/name without using it as the
   principal key.

This path is provider-neutral in the public architecture. Anaconda is the first
hosted OIDC deployment, not a protocol dependency. Other OIDC-backed hosts can
use the same transport and ACL model with different issuer, audience, principal
namespace, and optional perimeter configuration.

## Open Questions

1. **Browser token storage and refresh.** The direct-OIDC viewer can reuse the
   `runtimed/intheloop` PKCE/localStorage shape initially. Before private
   notebooks become broad production surface, decide whether tokens should move
   behind a same-site BFF/session-cookie layer.
2. **Additional OIDC providers.** If a public `runtimed.com` viewer validates a
   different OIDC provider, define the principal namespace and future
   subject-linking story up front.
3. **Invite-by-email.** D1 ACLs key by principal, but people share by email.
   `docs/architecture/hosted-sharing-invites.md` sketches the pending-invite
   table, first-login resolution, display metadata, and public viewer UX.
4. **Provider maximum capabilities.** The hosted prototype currently treats
   dev credentials as effectively owner-bounded and relies on ACL rows. Real
   OIDC/JupyterHub providers should expose provider maximum capabilities
   explicitly before broad deployment.
5. **Revocation.** Existing connection lifetime remains connection-scoped.
   Admin revocation and provider sign-out need the future `SESSION_CONTROL`
   close path.
6. **Service-token runtime peers.** Runtime sidecars need a clean credential
   story, likely Anaconda scoped credentials, another configured OIDC machine
   credential, or a notebook-host-issued runtime ticket.

## References

- `docs/architecture/identity-and-trust.md` - principals, operators, providers,
  actor validation, and base credential vocabulary.
- `docs/architecture/hosted-room-authorization.md` - room ACLs and scope
  derivation.
- `docs/architecture/hosted-direct-oidc-demo-runbook.md` - exact direct OIDC
  Anaconda demo deployment and smoke steps.
- `docs/architecture/hosted-sharing-invites.md` - email invite to principal ACL
  resolution.
- `docs/architecture/hosted-output-origin-isolation.md` - hosted output
  document, renderer asset, and blob-origin separation.
- `apps/notebook-cloud/src/identity.ts` - current Cloudflare Access JWT and
  dev-token credential extraction.
- Cloudflare WebSockets docs:
  `https://developers.cloudflare.com/network/websockets/`
- Cloudflare Access authorization cookie docs:
  `https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/`
- Cloudflare Access JWT validation docs:
  `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`
- JupyterHub services auth implementation:
  `jupyterhub/services/auth.py`
- PR #2801 review discussion:
  `https://github.com/nteract/nteract/pull/2801#pullrequestreview-4348156180`
  and
  `https://github.com/nteract/nteract/pull/2801#discussion_r3290622903`
