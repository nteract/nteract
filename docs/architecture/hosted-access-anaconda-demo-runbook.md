# Hosted Cloudflare Access + Anaconda Demo Runbook

**Status:** Draft, verified against provider metadata on 2026-05-24.

This is the operational path for the Anaconda-hosted notebook-cloud demo:
Cloudflare Access owns the browser login session, Anaconda is the Access OIDC
identity provider, and the notebook-cloud Worker independently validates the
Access JWT before consulting the per-notebook D1 ACL.

Related design docs:

- `docs/architecture/hosted-credential-transport.md`
- `docs/architecture/hosted-room-authorization.md`
- `docs/architecture/hosted-notebook-artifacts.md`
- `docs/architecture/hosted-output-origin-isolation.md`
- `docs/architecture/identity-and-trust.md`

## Target Topology

Use one notebook application hostname for the demo. For a fast prototype this
can be the Worker's `workers.dev` route; for a product-facing demo or anything
business-critical, prefer a Worker route or custom domain so the URL is stable,
brandable, and not tied to the account-level `workers.dev` subdomain.

```text
https://<notebook-host>
```

Examples:

```text
https://notebooks.example.com
https://nteract-notebook-cloud.rgbkrk.workers.dev
```

Cloudflare Access protects that host. Browser users authenticate through
Anaconda OIDC in Cloudflare Access. Cloudflare forwards Access assertions to the
Worker, and the Worker maps the Access subject to:

```text
user:cloudflare-access:<encoded-access-sub>
```

Email and display name are profile metadata. They are not ACL subjects.

Renderer sidecar assets may stay on a separate public asset origin:

```text
https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/
```

Do not add the renderer asset origin to the notebook WebSocket origin allowlist.
It serves public build artifacts only; notebook room traffic belongs to the
notebook application origin.

Untrusted output documents should use their own output-document origin before
private hosted notebooks scale beyond the prototype. That origin is separate
from both the Access-protected notebook host and the renderer asset host; see
`hosted-output-origin-isolation.md`.

## Cloudflare Access Application

Create or enable a Cloudflare Access application for the notebook host.

For the prototype `workers.dev` route:

1. In the Cloudflare dashboard, go to `Workers & Pages`.
2. Select the notebook-cloud Worker.
3. Go to `Settings > Domains & Routes`.
4. For `workers.dev`, click `Enable Cloudflare Access`.
5. Click `Manage Cloudflare Access` to customize the Access policy and IdP.

For a custom hostname or Worker route:

1. In Cloudflare Zero Trust, go to `Access controls > Applications`.
2. Add an application and choose `Self-hosted`.
3. Name it, for example `nteract notebook cloud`.
4. Set the public hostname:

   ```text
   https://<notebook-host>
   ```

Then, for either host shape:

1. Use a session duration suitable for a live demo, for example `8 hours`.
2. Add an `Allow` policy for the demo cohort:
   - Identity provider: the Anaconda OIDC provider configured below.
   - Include: exact demo emails, an Anaconda-backed email domain, or an Access
     group used only for the demo.
   - Require: optional device posture or MFA if the account policy demands it.
3. Copy the application's `Audience Tag`. This is the Worker value:

   ```text
   NOTEBOOK_CLOUD_ACCESS_AUD=<Access application Audience Tag>
   ```

4. Record the Cloudflare One team domain:

   ```text
   NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN=<team-name>.cloudflareaccess.com
   ```

Cloudflare's Access docs describe self-hosted apps, Access cookies, and Access
JWT validation here:

- `https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/`
- `https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/`
- `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`
- `https://developers.cloudflare.com/workers/configuration/routing/workers-dev/`

## Anaconda OIDC Provider In Access

Add Anaconda as a generic OIDC identity provider in Cloudflare Access.

1. In Cloudflare Zero Trust, go to `Settings > Authentication` or
   `Integrations > Identity providers`.
2. Add an identity provider and choose `OpenID Connect`.
3. In the Anaconda OIDC client, register this redirect URI:

   ```text
   https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback
   ```

4. Configure Cloudflare Access with the Anaconda client ID and client secret.
   These stay in Cloudflare Access. They are not Worker secrets.
5. Use these production endpoints:

   ```text
   Issuer:        https://auth.anaconda.com/api/auth
   Auth URL:      https://auth.anaconda.com/api/auth/oauth2/authorize
   Token URL:     https://auth.anaconda.com/api/auth/oauth2/token
   Certificate:   https://auth.anaconda.com/api/auth/.well-known/jwks.json
   Userinfo:      https://auth.anaconda.com/api/auth/oauth2/userinfo
   Scopes:        openid email profile
   Client auth:   client_secret_basic or client_secret_post
   Discovery:     https://auth.anaconda.com/api/auth/.well-known/openid-configuration
   ```

6. For staging, use the same paths under `https://auth.stage.anaconda.com`:

   ```text
   Issuer:        https://auth.stage.anaconda.com/api/auth
   Discovery:     https://auth.stage.anaconda.com/api/auth/.well-known/openid-configuration
   ```

Cloudflare's generic OIDC setup requires the IdP redirect URI above and the
authorization, token, and JWKS endpoints from the provider discovery document:

```text
https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/generic-oidc/
```

## Worker Environment

Set these Worker variables for an Access-backed deployment:

```toml
[vars]
DEPLOYMENT_ENV = "prototype"
NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN = "<team-name>.cloudflareaccess.com"
NOTEBOOK_CLOUD_ACCESS_AUD = "<Access application Audience Tag>"
NOTEBOOK_CLOUD_ALLOWED_ORIGINS = "https://<notebook-host>"
RENDERER_ASSETS_BASE_URL = "https://<asset-host>/renderer-assets/"
RUNTIMED_WASM_BASE_URL = "https://<asset-host>/renderer-assets/"
```

`NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN` and `NOTEBOOK_CLOUD_ACCESS_AUD` are not
secrets. They tell the Worker which Access issuer and audience to accept.

Do not set `NOTEBOOK_CLOUD_ACCESS_JWKS_JSON` in normal production operation.
When unset, the Worker fetches:

```text
https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs
```

Use `NOTEBOOK_CLOUD_ACCESS_JWKS_JSON` only for pinned/offline tests or an
emergency where fetching the Access JWKS is intentionally disabled.

`NOTEBOOK_CLOUD_DEV_TOKEN` is for the old deployed prototype and local smoke
scripts. It is not part of the Access + Anaconda demo auth path. Keep it only
if you still need the dev-token prototype scripts:

```bash
printf "%s" "$NOTEBOOK_CLOUD_DEV_TOKEN" \
  | pnpm --workspace-root exec wrangler secret put NOTEBOOK_CLOUD_DEV_TOKEN \
      --config apps/notebook-cloud/wrangler.toml
```

After deploying the variables, `GET /api/health` reports a non-secret Access
readiness summary:

```json
{
  "auth": {
    "cloudflare_access": {
      "status": "configured",
      "jwks": "remote"
    }
  }
}
```

`status: "partial"` means exactly one of `NOTEBOOK_CLOUD_ACCESS_AUD` or
`NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN` is present. Fix that before running browser
or WebSocket smoke tests; otherwise Access-authenticated requests will fail
with `Cloudflare Access auth is not fully configured`.

## Allowed Origins

For an Access-backed browser deployment, set:

```text
NOTEBOOK_CLOUD_ALLOWED_ORIGINS=https://<notebook-host>
```

Use a comma-separated list only when the same Worker must accept browser
WebSockets from more than one notebook application origin:

```text
NOTEBOOK_CLOUD_ALLOWED_ORIGINS=https://notebooks.example.com,https://preview-notebooks.example.com
```

Rules:

- Include the notebook application origin that renders `/n/:id`.
- The Worker treats same-origin notebook pages as allowed by default and uses
  this variable only to add more notebook application origins.
- Include loopback origins only for local Wrangler development.
- Do not include the renderer asset Worker origin.
- Do not include sandboxed output iframe origins.
- Do not use `*`.
- Leaving the variable unset keeps the same-origin default only. Access
  assertion-backed and cookie-backed WebSockets still reject missing or
  untrusted `Origin`.

The Worker checks `Origin` before WebSocket auth whenever a client sends one.
Malformed or untrusted origins are rejected. Browser Access sessions must
always send an allowed `Origin` so a malicious site cannot use an ambient
Access cookie, or the forwarded `Cf-Access-Jwt-Assertion` derived from it, to
open a private room socket. Browser-visible credential subprotocols also
require `Origin`.

Header-authenticated CLI, native, and future runtime clients may omit `Origin`,
even when `NOTEBOOK_CLOUD_ALLOWED_ORIGINS` is configured. If those clients send
an `Origin`, it must normalize to the notebook application origin or one of the
configured values. The hosted Access smoke sends `NOTEBOOK_CLOUD_ACCESS_ORIGIN`
by default to exercise the browser-compatible origin path while still carrying
only one Worker-visible credential, `CF-Access-Token`.
If the Access edge also forwards `Cf-Access-Jwt-Assertion` to the Worker, the
Worker treats the forwarded assertion as authoritative for origin identity and
ignores client-carried `CF-Access-Token` or bearer headers on that request.

## Deploy

From the repository root:

```bash
pnpm --dir apps/notebook-cloud build
pnpm --workspace-root exec wrangler d1 migrations apply nteract-notebook-cloud-prototype-db \
  --config apps/notebook-cloud/wrangler.toml \
  --remote
pnpm --workspace-root exec wrangler deploy \
  --config apps/notebook-cloud/wrangler.renderer-assets.toml
pnpm --workspace-root exec wrangler deploy \
  --config apps/notebook-cloud/wrangler.toml
```

Use the deployment's actual D1 database name, Worker config, and asset Worker
config if they differ from the prototype names above.

## ACL Bootstrap Model

The Worker does not grant notebook roles from Anaconda groups or Access
policies. Access authenticates the user. D1 grants the notebook role.

For a demo notebook:

1. Create or publish the notebook with an owner ACL row.
2. Grant known collaborators by principal:

   ```json
   {
     "subject_kind": "principal",
     "subject": "user:cloudflare-access:<encoded-access-sub>",
     "scope": "editor"
   }
   ```

3. Grant a known viewer by principal:

   ```json
   {
     "subject_kind": "principal",
     "subject": "user:cloudflare-access:<encoded-access-sub>",
     "scope": "viewer"
   }
   ```

4. For share-by-email bootstrapping, create a pending invite row with the
   normalized email and optional provider hint. On the invited user's first
   Cloudflare Access login, the Worker resolves the invite before notebook ACL
   authorization, upserts `principal_profiles`, marks the invite accepted, and
   inserts a `notebook_acl` row whose subject is the resolved
   `user:cloudflare-access:<encoded-access-sub>` principal. The email remains
   lookup and display metadata; it is never the ACL subject.

5. Public viewer is a separate explicit row, and only applies when the request
   can reach the Worker without being blocked by Access:

   ```json
   {
     "subject_kind": "public",
     "subject": "anonymous",
     "scope": "viewer"
   }
   ```

A hostname protected entirely by Access will not admit anonymous public viewers
at the Cloudflare edge. For public published notebooks, use an unprotected
public viewer hostname, a bypass policy for the public viewer route, or a
separate public deployment that still relies on the Worker ACL row before
serving room state.

## Hosted Access Smoke

The Access smoke proves that:

- `/api/health` reports Cloudflare Access as fully configured before the script
  creates or mutates a room;
- the Worker accepts a Cloudflare Access application JWT;
- the Access JWT maps to `user:cloudflare-access:<sub>`, not email;
- owner, editor, and viewer ACL rows are honored;
- owner and editor can write real `NotebookDoc` Automerge frames;
- the granted Access viewer receives the live edit stream;
- no token is put in the WebSocket URL.

Install `cloudflared` and authenticate to the Access application:

```bash
cloudflared access login https://<notebook-host>
export NOTEBOOK_CLOUD_ACCESS_JWT="$(cloudflared access token -app=https://<notebook-host>)"
```

For a single-user smoke, the owner token is reused as editor and viewer. For a
multi-user demo, run the token command under each user session:

```bash
export NOTEBOOK_CLOUD_ACCESS_EDITOR_JWT="<second user's Access token>"
export NOTEBOOK_CLOUD_ACCESS_VIEWER_JWT="<third user's Access token>"
```

Build the volatile WASM package and run the smoke:

```bash
cargo xtask wasm runtimed --skip-renderer-plugins

NOTEBOOK_CLOUD_URL=https://<notebook-host> \
NOTEBOOK_CLOUD_ACCESS_ORIGIN=https://<notebook-host> \
NOTEBOOK_CLOUD_ACCESS_NOTEBOOK_ID=access-demo-$(date +%Y%m%d%H%M%S) \
NOTEBOOK_CLOUD_ACCESS_JWT="$NOTEBOOK_CLOUD_ACCESS_JWT" \
pnpm --dir apps/notebook-cloud smoke:hosted:access
```

The script sends:

- `CF-Access-Token: <jwt>` so Cloudflare Access can admit the HTTP and
  WebSocket requests;
- `Origin: https://<notebook-host>` to exercise the browser-compatible
  WebSocket origin gate;

The first request is a token-authenticated `/api/health` preflight. It requires
`auth.cloudflare_access.status === "configured"` and fails before ACL writes if
one of `NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN` or `NOTEBOOK_CLOUD_ACCESS_AUD` is
missing.

Against the current prototype host, `cloudflared access token -app=...` must
succeed before the smoke can run. If it reports that no Access application was
found, the Worker route is still public and only the dev-token prototype auth
path is available. After Access is enabled and the Worker variables are
deployed, `/api/health` should move from `status: "disabled"` to
`status: "configured"`.

It intentionally sends one client-carried Access credential transport per
request. If Access forwards `Cf-Access-Jwt-Assertion` to the origin after
admitting the request, the Worker validates that forwarded assertion as the
authoritative origin credential. The Worker also supports
`Authorization: Bearer <jwt>` and
`nteract-access-token.<base64url-jwt>` as separate deployment/client modes, but
they must not be combined with `CF-Access-Token` on the same request unless the
Access edge has replaced client credential selection with a forwarded
assertion.

Expected JSON shape:

```json
{
  "ok": true,
  "auth_mode": "cloudflare_access",
  "access_health": {
    "status": "configured",
    "jwks": "remote"
  },
  "viewerUrl": "https://<notebook-host>/n/<id>",
  "checks": [
    "cloudflare_access_worker_configured",
    "cloudflare_access_jwt_validated_by_worker",
    "owner_acl_room_seeded",
    "editor_principal_acl_granted",
    "viewer_principal_acl_granted",
    "real_automerge_sync_payload",
    "access_owner_seeded_markdown",
    "access_editor_edited_markdown",
    "access_viewer_live_convergence",
    "actor_principals_match_access_subjects"
  ]
}
```

To also prove anonymous public viewer convergence on a host that permits
unauthenticated public room access, add:

```bash
NOTEBOOK_CLOUD_ACCESS_PUBLIC_SMOKE=1
```

Do not enable that flag against a hostname fully protected by Access; the
anonymous WebSocket should be blocked before it reaches the Worker.

## Browser Cookie Smoke

The CLI smoke proves token validation and ACL behavior. The browser cookie path
should also be checked manually for the demo host:

1. Open `https://<notebook-host>/n/<id>` in a normal browser profile.
2. Complete the Cloudflare Access login through Anaconda.
3. Confirm the WebSocket connects without putting tokens in the URL.
4. Confirm a granted editor can edit an existing markdown cell.
5. Confirm a granted viewer sees the edit but cannot edit.

For the browser path, Cloudflare Access should forward
`Cf-Access-Jwt-Assertion` to the Worker. The Worker validates that assertion
against `NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN` and `NOTEBOOK_CLOUD_ACCESS_AUD`,
then D1 decides the requested notebook scope.

## Current Trial Blockers

The Worker-side pieces needed for an Access-authenticated collaboration smoke
are in place, but an Anaconda-backed trial still depends on these deployment
and product decisions:

1. **Access application and IdP setup.** The demo host must be protected by a
   Cloudflare Access application whose IdP is Anaconda OIDC. For the
   `workers.dev` prototype, this can be enabled directly on the Worker's
   `workers.dev` route from `Workers & Pages > Settings > Domains & Routes`.
   For a product-facing demo, use a custom hostname or Worker route. The Worker
   must receive the matching Access audience and team domain.
2. **Principal namespace.** Until the Worker validates an Anaconda-issued token
   or Access forwards a deployment-approved stable Anaconda subject claim, ACL
   rows should use `user:cloudflare-access:<encoded-access-sub>`. Do not switch
   to `user:anaconda:*` based on email.
3. **Collaborator bootstrap.** The current owner/editor/viewer smoke can derive
   principals from local Access JWT subjects, seed D1 ACL rows, or resolve
   pre-created pending invite rows on first Access login. The browser product
   still needs share-by-email creation routes before non-operators can grant
   collaborators by email.
4. **Public viewers.** A fully Access-protected hostname blocks anonymous
   viewers at the edge. Public published notebooks need an Access bypass rule,
   a separate public viewer hostname, or another route that still reaches the
   Worker ACL check.
5. **Revocation and provider capability bounds.** ACL changes affect new
   connections. Immediate live-connection eviction and provider-side maximum
   capability mapping remain follow-up work before broad production use.
6. **Runtime peer credentials.** The collaboration demo has no remote runtime
   sidecar. Runtime peers still need a credential and blob-upload story before
   hosted execution can join the same room.

## Troubleshooting

`401 missing/invalid Cloudflare Access token`

- Confirm `NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN` is the Cloudflare One team domain,
  not the notebook hostname.
- Confirm `NOTEBOOK_CLOUD_ACCESS_AUD` is the Access application's Audience Tag.
- Confirm the Access token was minted for the same app:

  ```bash
  cloudflared access token -app=https://<notebook-host>
  ```

`403 websocket origin is not allowed`

- Confirm `NOTEBOOK_CLOUD_ALLOWED_ORIGINS` contains exactly the notebook app
  origin, including scheme.
- Confirm `NOTEBOOK_CLOUD_ACCESS_ORIGIN` matches that origin in the smoke.
- Do not use the renderer asset origin as the smoke origin.

`403 notebook access denied`

- Authentication succeeded, but D1 has no ACL row for the requested principal
  and scope.
- The smoke output intentionally reports only `principal_fingerprints`, not raw
  principal strings or emails. For manual ACL bootstrap, derive the principal
  locally from the Access JWT subject (`user:cloudflare-access:<encoded-sub>`)
  or use the owner-authenticated ACL API to inspect rows for a seeded smoke
  notebook.
- Do not grant email strings as `notebook_acl.subject`.

`404 or failed render for public viewers`

- A public viewer needs both network reachability and the explicit ACL row:
  `subject_kind = public`, `subject = anonymous`, `scope = viewer`.
- A fully Access-protected hostname blocks anonymous requests at the edge before
  Worker ACLs run.

`Missing apps/notebook/src/wasm/runtimed-wasm output`

- Run:

  ```bash
  cargo xtask wasm runtimed --skip-renderer-plugins
  ```

## References

- Cloudflare self-hosted Access apps:
  `https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/`
- Cloudflare generic OIDC IdP:
  `https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/generic-oidc/`
- Cloudflare Access JWT validation:
  `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`
- Cloudflare CLI Access tokens:
  `https://developers.cloudflare.com/cloudflare-one/tutorials/cli/`
- Anaconda production OIDC discovery:
  `https://auth.anaconda.com/api/auth/.well-known/openid-configuration`
- Anaconda stage OIDC discovery:
  `https://auth.stage.anaconda.com/api/auth/.well-known/openid-configuration`
