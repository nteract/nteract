# Hosted Direct OIDC Anaconda Demo Runbook

**Status:** Runbook, 2026-05-27.
**Review trigger:** Re-check before any `preview.runt.run` route takeover,
direct-OIDC Worker deployment, or Anaconda-backed hosted demo.

This is the operational path for the notebook-cloud direct OIDC demo:
Cloudflare hosts the Worker, Durable Object, D1, R2, and custom domain, while
the Worker validates Anaconda-issued OIDC tokens directly before consulting the
per-notebook D1 ACL.

Related architecture:

- `docs/architecture/hosted-credential-transport.md`
- `docs/architecture/hosted-room-authorization.md`
- `docs/architecture/identity-and-trust.md`
- `docs/architecture/hosted-output-origin-isolation.md`

## Staging Target

Take over the retired `runtimed/intheloop` preview lane:

```text
Notebook host:  https://preview.runt.run
OIDC callback:  https://preview.runt.run/oidc
OIDC issuer:    https://auth.stage.anaconda.com/api/auth
OIDC client id: cec4781f-853c-4267-bf09-4bc59a2a3750
Output origin:  https://preview.runtusercontent.com
```

The old `runtimed/intheloop` route was:

```toml
[env.preview]
name = "anode-docworker-preview"
routes = [{ pattern = "preview.runt.run", custom_domain = true }]
```

Notebook-cloud should own that route after the direct-OIDC Worker path lands.
Do not move the production `app.runt.run` route for this demo; it remains a
production precedent and existing OIDC lane.

## Worker Runtime Variables

The direct-OIDC Worker implementation should use provider-neutral names:

```toml
[vars]
NOTEBOOK_CLOUD_OIDC_ISSUER = "https://auth.stage.anaconda.com/api/auth"
NOTEBOOK_CLOUD_OIDC_CLIENT_ID = "cec4781f-853c-4267-bf09-4bc59a2a3750"
NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE = "user:anaconda"
NOTEBOOK_CLOUD_OIDC_REDIRECT_URI = "https://preview.runt.run/oidc"
NOTEBOOK_CLOUD_OIDC_AUDIENCE = "anaconda,cec4781f-853c-4267-bf09-4bc59a2a3750"
NOTEBOOK_CLOUD_ALLOWED_ORIGINS = "https://preview.runt.run"
```

If the token `aud` claim differs from the client id, use
`NOTEBOOK_CLOUD_OIDC_AUDIENCE` explicitly. The value may be a comma-separated
list during provider migrations; preview accepts both the Anaconda resource
audience and the historical client-id audience so existing browser sessions can
be replaced gradually. Use
`NOTEBOOK_CLOUD_OIDC_JWKS_JSON` only for pinned/offline tests or an emergency
where fetching the provider JWKS is intentionally disabled.

`NOTEBOOK_CLOUD_DEV_TOKEN` may remain for scripted demo publishing and smoke
tests until publish tooling has a first-class OIDC/API-key credential path. It
is not the browser auth path.

## API-key Publishing

Browser sessions use direct OIDC. Non-browser publishing agents should use an
Anaconda API key with `cloud:write`, presented as `Authorization: Bearer` plus
an explicit provider header:

```text
X-Notebook-Cloud-Auth-Provider: anaconda-api-key
```

That header keeps API-key routing explicit when OIDC and API-key auth are both
enabled on the same Worker. The Worker still validates the token by calling the
configured Anaconda `whoami` endpoint and derives the ACL principal from the
validated response, not from unverified JWT payload fields. Successful whoami
responses are cached for 60 seconds with a bounded in-isolate cache; token
revocation can therefore take up to 60 seconds to be observed by a hot Worker
isolate.

For `runt-publish`, use:

```bash
NOTEBOOK_CLOUD_URL=https://preview.runt.run \
NOTEBOOK_CLOUD_BEARER_TOKEN="$ANACONDA_API_KEY" \
NOTEBOOK_CLOUD_AUTH_PROVIDER=anaconda-api-key \
cargo run -p runt-publish -- --id topic-viz --vanity-name topic-viz ~/notebooks/topic-viz.ipynb
```

## Viewer Runtime OIDC Config

The Worker injects the viewer/editor OIDC configuration into the first-party
HTML shell from runtime variables. That keeps a single viewer bundle usable
across the workers.dev host and the `preview.runt.run` custom domain while the
Cloudflare Worker deployment owns the active redirect URI:

```toml
NOTEBOOK_CLOUD_OIDC_ISSUER = "https://auth.stage.anaconda.com/api/auth"
NOTEBOOK_CLOUD_OIDC_CLIENT_ID = "cec4781f-853c-4267-bf09-4bc59a2a3750"
NOTEBOOK_CLOUD_OIDC_REDIRECT_URI = "https://preview.runt.run/oidc"
```

The browser stores short-lived OIDC access material only in the notebook
application origin. It sends HTTP auth as `Authorization: Bearer` and WebSocket
auth as the non-echoed `nteract-bearer.<base64url-token>` subprotocol.

## Principal Shape

Direct Anaconda OIDC validation yields:

```text
user:anaconda:<encoded-sub>
```

Email, name, and avatar are display/audit metadata. They must not become
`notebook_acl.subject` values.

If a public `runtimed.com` viewer uses WorkOS first, that deployment should use
`user:workos:<encoded-sub>` until a deliberate account-linking migration maps
those users to Anaconda principals.

## Route Takeover Sequence

1. Land and deploy the direct-OIDC Worker support behind the existing
   `workers.dev` hostname.
2. Verify token validation and ACL behavior with a scripted bearer token or
   local callback flow.
3. Add notebook-cloud preview deployment config for `preview.runt.run`.
4. Remove or replace the retired `runtimed/intheloop` `preview.runt.run` route.
5. Deploy notebook-cloud's main Worker to `preview.runt.run`.
6. Deploy/verify renderer asset and output-document Workers. Do not put the
   renderer or output origins behind notebook app credentials.
7. Run hosted smoke against:
   - anonymous public viewer;
   - authenticated viewer;
   - authenticated editor markdown edit;
   - room WebSocket origin policy;
   - render parity fixtures including isolated Sift and widget progress output.

## Expected Health Shape

After direct OIDC is configured, `/api/health` should expose a non-secret OIDC
readiness field, for example:

```json
{
  "auth": {
    "oidc": {
      "status": "configured",
      "issuer": "https://auth.stage.anaconda.com/api/auth",
      "principal_namespace": "user:anaconda"
    }
  }
}
```

Do not expose client secrets, access tokens, refresh tokens, or raw JWT claims.

## Not The Target Path

Cloudflare Access is not the default for this demo. It remains an optional
outer perimeter for deployments that deliberately want Access cookies/assertions
and accept the extra product/configuration layer. A fully Access-protected host
also blocks anonymous public viewers at the edge unless bypass rules are added,
which conflicts with public published notebook URLs.
