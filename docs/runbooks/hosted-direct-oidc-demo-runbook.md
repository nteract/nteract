# Hosted Direct OIDC Anaconda Demo Runbook

**Status:** Runbook, updated 2026-05-28.
**Review trigger:** Re-check before changing the `preview.runt.run` route,
direct-OIDC Worker variables, or Anaconda-backed hosted demo.

This runbook covers the notebook-cloud direct OIDC demo. Cloudflare hosts the
Worker, Durable Object, D1, R2, and custom domain. The Worker validates
Anaconda-issued OIDC tokens directly before checking the per-notebook D1 ACL.

Related architecture:

- `docs/adr/hosted-credential-transport.md`
- `docs/adr/hosted-room-authorization.md`
- `docs/adr/identity-and-trust.md`
- `docs/adr/hosted-output-origin-isolation.md`

## Staging Target

Notebook-cloud owns the staging lane formerly used by `runtimed/intheloop`:

```text
Notebook host:  https://preview.runt.run
OIDC callback:  https://preview.runt.run/oidc
OIDC issuer:    https://auth.stage.anaconda.com/api/auth
OIDC client id: cec4781f-853c-4267-bf09-4bc59a2a3750
Output origin:  https://preview.runtusercontent.com
```

Retired `runtimed/intheloop` route (for reference when verifying route
ownership):

```toml
[env.preview]
name = "anode-docworker-preview"
routes = [{ pattern = "preview.runt.run", custom_domain = true }]
```

Do not move the production `app.runt.run` route for this demo; it remains an
existing production OIDC lane.

## Worker Runtime Variables

Configure the direct-OIDC Worker with provider-neutral variable names:

```toml
[vars]
NOTEBOOK_CLOUD_OIDC_ISSUER = "https://auth.stage.anaconda.com/api/auth"
NOTEBOOK_CLOUD_OIDC_CLIENT_ID = "cec4781f-853c-4267-bf09-4bc59a2a3750"
NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE = "user:anaconda"
NOTEBOOK_CLOUD_OIDC_REDIRECT_URI = "https://preview.runt.run/oidc"
NOTEBOOK_CLOUD_OIDC_AUDIENCE = "anaconda,cec4781f-853c-4267-bf09-4bc59a2a3750"
NOTEBOOK_CLOUD_ALLOWED_ORIGINS = "https://preview.runt.run"
```

### Audience, discovery, and JWKS

- **`NOTEBOOK_CLOUD_OIDC_AUDIENCE`**: Set explicitly when the token `aud` claim
  differs from the client ID. Accepts a comma-separated list during migrations
  (preview accepts both the Anaconda resource audience and the client-ID
  audience so existing browser sessions rotate gradually).
- **`NOTEBOOK_CLOUD_OIDC_JWKS_JSON`**: Use only for pinned/offline tests or an
  emergency where remote JWKS fetching is disabled.
- **Discovery and key loading**: Remote keys load from
  `/.well-known/openid-configuration` and its `jwks_uri`. The discovery issuer
  must match the configured issuer exactly. `jwks_uri` must use HTTPS (local
  dev also allows HTTP on the issuer's loopback origin).
- **Fetch limits**: Discovery and JWKS fetches reject redirects, time out after
  10 seconds each, and share a 5-minute cache. Invalid discovery or fetch
  failures fail authentication closed and retry on the next request.

### Required client ID (`NOTEBOOK_CLOUD_OIDC_REQUIRED_CLIENT_ID`)

- Set this to the deployment's OAuth client ID when a provider shares one
  resource audience across multiple OAuth clients.
- The verifier then requires a matching signed `client_id` claim on both bearer
  and WebSocket credentials. Missing or mismatched values are rejected.
- Leave unset when access tokens omit `client_id`, including the current
  Anaconda configuration.

### Optional OIDC UserInfo (`NOTEBOOK_CLOUD_OIDC_USERINFO = "true"`)

Enable this only for providers whose access tokens omit profile claims. Leave
UserInfo disabled for the current Anaconda flow.

- **Request rules**: After verifying the access JWT, the Worker POSTs to
  `userinfo_endpoint` with the bearer token. The response `sub` must match the
  signed `sub` exactly. The endpoint must share the issuer's HTTPS origin
  unless you trust another origin via `NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN`
  (origin only, no path; loopback HTTP allowed in local dev). Requests reject
  redirects, cap JSON at 16 KiB, and enforce a 5-second total deadline for
  headers and body.
- **Profile retention and cache**: Only validated profile fields are kept.
  Email account linking and pending invitations require `email_verified: true`;
  an unverified UserInfo email cannot inherit verification from a different JWT
  email. Successful lookups coalesce in an in-memory cache of up to 256 token
  fingerprints for 60 seconds (capped by token expiry). Failures retry on the
  next request. Raw access tokens and provider response bodies are never cached
  or logged.
- **Login failure codes**: UserInfo failures block new bearer logins before
  profile writes or cookie creation:
  - `401`: subject mismatch or provider token rejection.
  - `503`: provider outage, invalid response, or configuration error.
- **Existing app sessions**: Stored sessions continue using their last verified
  profile without calling the provider, including on WebSocket joins. Provider
  profile or email changes appear after a new bearer login (subject to cache).
  Normal session lifetime and sliding renewal rules still apply; UserInfo does
  not poll for continuous revocation or email freshness.
- **Verified-email cookie proof**: A successful OIDC exchange with a verified
  email signs an opaque email binding and `identity_verified_at` into the
  cookie (preserved unchanged on renewal). The binding does not expose the
  email and prevents a failed profile write from attaching fresh proof to a
  previously stored email. Profile-sensitive features can require proof under
  6 hours old matching the stored verified email; legacy, stale, or missing
  proof never blocks notebook access. When UserInfo is enabled, accepting
  pending email invitations from a stored session requires this fresh matching
  proof; existing notebook ACLs remain usable, and a fresh OIDC exchange
  restores invite acceptance.
- **Compatibility**: Transport principal and namespace stay unchanged, and
  verified-email account linking preserves prior ownership and ACLs when a
  profile first gains a verified email. Pinned `NOTEBOOK_CLOUD_OIDC_JWKS_JSON`
  still skips remote keys, but enabled UserInfo requires discovery and a
  reachable endpoint.

### Local dev token

`NOTEBOOK_CLOUD_DEV_TOKEN` is for local-only smoke tests and emergency
prototype diagnostics. It is never a browser auth path or hosted publishing
credential.

## API-key Publishing

Non-browser publishing agents use a bearer token with write capability plus an
explicit provider header (`Authorization: Bearer` with):

```text
X-Notebook-Cloud-Auth-Provider: anaconda-api-key
```

This header keeps API-key routing explicit when OIDC and API-key auth share a
Worker. The Worker validates the token against the configured Anaconda `whoami`
endpoint and derives the ACL principal from that response, never from
unverified JWT payload fields. Successful `whoami` responses cache for 60
seconds in a bounded per-isolate cache, so token revocation can take up to 60
seconds on a hot isolate.

### Publishing with `runt publish`

1. Store the host URL and publish token in your environment or `.env`:

   ```bash
   NTERACT_CLOUD_URL=https://preview.runt.run
   NTERACT_API_KEY=...
   ```

2. Run `runt publish` (backed by the `runt-publish` crate):

   ```bash
   cargo run -p runt -- publish --vanity-name topic-viz ~/notebooks/topic-viz.ipynb
   ```

Key behaviors:

- **Notebook IDs**: Generated by the remote host. The publisher reserves a
  target and reads `notebook_id` and the viewer URL from the response. There is
  no `--id` flag; `--vanity-name` only adds an optional path segment to the
  reported viewer URL.
- **Defaults and `.env`**: Defaults to `https://preview.runt.run` and loads
  publish keys from `.env`. Set `NTERACT_CLOUD_URL` for another deployment, or
  pass `--env-file path/to/.env` when running from another checkout.
- **Auth and scopes**: Sends `X-Notebook-Cloud-Auth-Provider: anaconda-api-key`
  with `NTERACT_API_KEY`. Owner publish requests require `cloud:write` in the
  validated `whoami` scopes.
- **Env var names**: Use `NTERACT_API_KEY`. `ANACONDA_API_KEY` is intentionally
  not a public publish variable. `NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN` remains
  a compatibility alias.

## Viewer Runtime OIDC Config

The Worker injects OIDC config into the first-party HTML shell from runtime
variables so one viewer bundle serves both `workers.dev` and `preview.runt.run`
while the Worker owns the active redirect URI:

```toml
NOTEBOOK_CLOUD_OIDC_ISSUER = "https://auth.stage.anaconda.com/api/auth"
NOTEBOOK_CLOUD_OIDC_CLIENT_ID = "cec4781f-853c-4267-bf09-4bc59a2a3750"
NOTEBOOK_CLOUD_OIDC_REDIRECT_URI = "https://preview.runt.run/oidc"
```

Browser session flow:

1. The browser holds short-lived OIDC access material only long enough to
   establish or refresh a first-party session.
2. It exchanges the validated OIDC bearer at `/api/auth/session` for an
   HttpOnly app session cookie.
3. First-party HTTP APIs and live-room WebSockets authenticate with that cookie
   under same-origin/trusted-origin checks.
4. The non-echoed `nteract-bearer.<base64url-token>` WebSocket subprotocol
   remains an explicit fallback for browser clients that cannot use the cookie
   path.

## Principal Shape

Direct Anaconda OIDC validation produces:

```text
user:anaconda:<encoded-sub>
```

- Email, name, and avatar are display/audit metadata only. Never use them as
  `notebook_acl.subject` values.
- If a public `runtimed.com` viewer uses another OIDC provider, assign it a
  provider-specific principal namespace until a deliberate account-linking
  migration maps those users. Never reuse email addresses as ACL subjects
  across providers.

## Deployment Validation Sequence

1. Deploy notebook-cloud's main Worker to `preview.runt.run`.
2. Verify token validation and ACL behavior with a scripted bearer token or
   browser callback flow.
3. Deploy and verify renderer asset and output-document Workers. Do not put the
   renderer or output origins behind notebook app credentials.
4. Run hosted smoke checks against:
   - anonymous public viewer;
   - authenticated viewer;
   - authenticated editor markdown edit;
   - room WebSocket origin policy;
   - render parity fixtures including isolated Sift and widget progress output.

## Expected Health Shape

With direct OIDC configured, `/api/health` returns a non-secret readiness
object:

```json
{
  "auth": {
    "oidc": {
      "status": "configured",
      "jwks": "remote",
      "audience": "client_id",
      "principal_namespace": "configured"
    }
  }
}
```

The response intentionally omits issuer, client ID, audience values, and
principal namespace names. Never expose client secrets, access tokens, refresh
tokens, or raw JWT claims.

## Avoid Edge-Only Login

Do not put the login decision in a host-level edge perimeter for this demo. The
notebook host must validate OIDC credentials directly, authorize public viewer
links through the room ACL, and let authenticated users fall back to public
read when they lack editor permissions.
