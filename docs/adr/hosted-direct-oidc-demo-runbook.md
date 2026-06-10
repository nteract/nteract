# Hosted Direct OIDC Anaconda Demo Runbook

**Status:** Runbook, updated 2026-05-28.
**Review trigger:** Re-check before changing the `preview.runt.run` route,
direct-OIDC Worker variables, or Anaconda-backed hosted demo.

This is the operational path for the notebook-cloud direct OIDC demo:
Cloudflare hosts the Worker, Durable Object, D1, R2, and custom domain, while
the Worker validates Anaconda-issued OIDC tokens directly before consulting the
per-notebook D1 ACL.

Related architecture:

- `docs/adr/hosted-credential-transport.md`
- `docs/adr/hosted-room-authorization.md`
- `docs/adr/identity-and-trust.md`
- `docs/adr/hosted-output-origin-isolation.md`

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

Notebook-cloud now owns the staging lane for the hosted demo. Do not move the
production `app.runt.run` route for this demo; it remains a production
precedent and existing OIDC lane.

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

`NOTEBOOK_CLOUD_DEV_TOKEN` may remain for local-only smoke tests and emergency
prototype diagnostics. It is not the browser auth path and it is not the hosted
publishing credential path.

## API-key Publishing

Browser sessions use direct OIDC. Non-browser publishing agents should use a
publish bearer token with write capability, presented as `Authorization: Bearer`
plus an explicit provider header:

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

For publishing (`runt publish`, backed by the `runt-publish` library crate),
store the publish bearer token in the environment or a local `.env` file:

```bash
NTERACT_CLOUD_URL=https://preview.runt.run
NTERACT_API_KEY=...
```

Then use:

```bash
cargo run -p runt -- publish --id topic-viz --vanity-name topic-viz ~/notebooks/topic-viz.ipynb
```

The publisher defaults to the current hosted staging URL, `https://preview.runt.run`,
and loads publish-related keys from `.env`. Set `NTERACT_CLOUD_URL` for a
different hosted deployment. The hosted deployment currently validates
non-browser publish bearer tokens through Anaconda's API-key `whoami` endpoint,
so the publisher sends `X-Notebook-Cloud-Auth-Provider: anaconda-api-key` for
`NTERACT_API_KEY`. The Worker trusts the `whoami` response, not unverified JWT
payload fields: owner publish requests require `cloud:write` in the validated
API-key scopes. Existing token values can be reused only if they validate that
way. Put those values in `NTERACT_API_KEY`; `ANACONDA_API_KEY` is intentionally
not a public publish env name. `NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN` remains a
compatibility alias. Use `--env-file path/to/.env` when running from a
different checkout.

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

If a future public `runtimed.com` viewer uses a different OIDC provider, that
deployment must use a provider-specific principal namespace until a deliberate
account-linking migration maps those users to Anaconda principals. Do not reuse
email addresses as ACL subjects across providers.

## Deployment Validation Sequence

1. Deploy notebook-cloud's main Worker to `preview.runt.run`.
2. Verify token validation and ACL behavior with a scripted bearer token or
   browser callback flow.
3. Deploy/verify renderer asset and output-document Workers. Do not put the
   renderer or output origins behind notebook app credentials.
4. Run hosted smoke against:
   - anonymous public viewer;
   - authenticated viewer;
   - authenticated editor markdown edit;
   - room WebSocket origin policy;
   - render parity fixtures including isolated Sift and widget progress output.

## Expected Health Shape

With direct OIDC configured, `/api/health` exposes a non-secret OIDC readiness
field:

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

## Avoid Edge-Only Login

Do not put the login decision in a host-level edge perimeter for this demo. The
notebook host must be able to validate OIDC credentials directly, authorize
public viewer links through the room ACL, and let authenticated users fall back
to public read when they do not have editor permissions.
