# nteract operator app

A read-only fleet inventory and metrics app for `deploy.runtimed.run`. The React
surface uses nteract's shared Button, Badge, theme tokens and observable store.
Its Worker runs on celld. Login reuses notebook-cloud's server OIDC implementation,
with a room-independent environment type and an explicit terminal identity rejection
for applications that restrict membership. There is no second token verifier or
session protocol. Transient profile-storage failures remain retryable.

This is application source, **not an installed deployment**. The existing metrics
collector remains owned by `nteract/preview-infra`; this app does not collect host
state, read journals, enumerate raw Durable Object identities, or call a model.
It shows host CPU history, current measured memory/disk, separate application /
output / renderer fleets, resident counts, sockets, restart/OOM counts and retained
deployment events. Missing values stay unknown. Current state and retained history
have separate labels; the initial collection and refresh cadence is one minute.

## Authentication and read boundary

- Authorization-code PKCE, state and nonce checks, token validation, encrypted
  server-side provider credentials, revocable D1-backed sessions and secure
  HttpOnly cookies come from the existing server-login implementation.
- The operator's D1 binding runs on **celld**, with a dedicated stable database
  identity and session secret. It does not use Cloudflare's hosted D1 service.
- `OPERATOR_ALLOWED_EMAILS` is an exact email safelist. The template uses synthetic
  addresses; supply the approved identities through private runtime configuration.
  A verified email is
  required at login and refresh. Each data request rechecks the fresh session's
  verified email binding against the current safelist, so removing an email takes
  effect without waiting for session expiry. Domains, profile display names,
  Cloudflare headers, API keys and provider bearer tokens confer no access.
- `/api/operator/session` renews the server session; DELETE signs out and requires
  the configured same-origin browser Origin. Login/logout are the only user state
  changes. There are no deployment controls.
- The Worker forwards fixed GET queries to `http://127.0.0.1:9464`. It sends no user
  cookies or credentials upstream. Only 1/6/24/168/336-hour windows and exact
  `main` / `pr-N` filters are accepted. JSON and CSV exports use the same gate.
  Unknown upstream routes, arbitrary URLs, SQL, redirects and deployment API
  forwarding are absent. `OPERATOR_METRICS_SERVICE_TOKEN` supplies a dedicated
  32-byte random credential encoded as 64 lowercase hex characters in the fixed
  outbound Authorization header. Missing/invalid configuration fails closed.
  The reader validates this credential on every route, including health. It is
  private runtime configuration, never a browser login credential or build input.
  The operator's OS identity, configuration, storage and celld control listener
  must be isolated from preview Workers; a loopback bind alone is insufficient.
- The sign-in shell and static UI code are public; fleet data and exports require
  an allowed session. Every response is no-store and carries a restrictive CSP.

Cloudflare Access is not involved. Existing DNS/tunnel ingress can remain in use;
an alternative reverse proxy can route the same paths without changing auth or
storage. celld's [D1 documentation](https://celld.dev/docs/services/d1/) describes
the self-hosted binding. Source tests are separate from proving the configured
identity provider admits both requested accounts in a real browser.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/operator typecheck
pnpm --dir apps/operator test
pnpm --dir apps/operator build
METRICS_SERVICE_TOKEN_FILE=/absolute/private/metrics-service-token \
  pnpm --dir apps/operator exec node scripts/prepare-local.mjs
CELLD_ESBUILD="$PWD/apps/operator/node_modules/.bin/esbuild" \
  celld dev apps/operator/wrangler.local.json --host 127.0.0.1 --port 9470 --no-watch
```

Open `http://localhost:9470/operator/`. The separate development entry point mounts
the repository's local OIDC issuer and signs in a synthetic
`operator@example.test` account. It only accepts the exact localhost origin. The
production build excludes this issuer and cannot enable it with environment
variables. Local session state persists in celld's local store; the generated
mode-0600 config and session secret are ignored. Never deploy the development
entry point or copy its config to a public host.

The local path has been exercised on celld 0.5.1, including browser login,
sign-out, protected JSON/CSV and session storage across a process restart. The
development issuer's keys and grants are ephemeral, so restarting it may require
a fresh login when a provider token needs renewal. That issuer is not a production
identity provider. These checks do not qualify a production OAuth client.

Run preview-infra's existing metrics demo or read service on loopback port 9464
to supply measurements, using the same private credential file. Its raw browser
dashboard now also requires service authentication; use the operator UI for
ordinary browser access. Synthetic captures remain labeled by their provenance.
Without that service the app shows an explicit unavailable state. `pnpm dev`
provides UI hot reload but does not supply login or metrics by itself.

## Production handoff

1. Build a reviewed exact revision. Publish only `dist/worker.js`, `dist/index.html`
   and `dist/assets/`; never include `dist-dev/`, generated configuration,
   local state or credentials. Artifact code/config cannot choose trusted routes,
   host commands, OIDC policy or its upstream. Do not run artifact-supplied scripts
   on the host. Build artifacts contain no runtime secrets.
2. In preview-infra's coordinated rollout, provision a dedicated celld fleet and
   session store outside the PR lifecycle and capacity pool. Supply the reviewed
   production config privately, based on `wrangler.json.example`, with a stable
   random session secret of at least 32 characters. Keep the secret and database
   together through updates and backups; rollback of code is not schema rollback.
   Keep app assets behind the Worker (`run_worker_first: true`).
   Supply `OPERATOR_METRICS_SERVICE_TOKEN` privately from the reader's credential;
   do not put it into the example config, application artifact or client bundle.
3. Verify the actual celld release and its configuration contract before host
   installation. Keep both the celld listener and metrics listener private. The
   app needs no journal, registry, controller credentials, deployment workflow
   token, or notebook storage access. Install the existing metrics collector
   separately; serving this app does not enable collection.
4. Confirm the production OAuth client allows
   `https://deploy.runtimed.run/oidc`, its issuer and audience are correct, and both
   requested accounts yield verified email claims. The Anaconda profile in the
   example follows current preview defaults; it is not evidence that a Gmail
   account has been admitted. Do not change to a domain-wide grant to solve this.
5. Route only `/`, `/operator`, `/operator/`, generated `/operator/assets/*.js`
   and `*.css` filenames, `/api/operator/metrics`,
   `/api/operator/export.json`, `/api/operator/export.csv`,
   `/api/operator/session`, `/api/auth/oidc/login` and `/oidc` to this app. Keep
   `/authorize`, `/deploy`, `/status`, `/deployments/*` and `/health` on the existing
   GitHub-OIDC deployment controller. Preserve its `https://deploy.runtimed.run`
   token audience. Never expose the celld listener wholesale (`/state` and peer
   endpoints are private). Ingress remains owned by preview-infra.
6. Before publication, qualify allowed/denied browser login, refresh, logout,
   direct unauthenticated JSON/CSV rejection, fresh and unavailable metrics,
   signed-in narrow layouts, persistence through restart, and the existing
   controller's authenticated CI path. Roll back the route addition if any gate
   fails; preserve the session store and pre-existing application routes.

Operator logs classify configuration fields, unverified or non-safelisted
identities, and upstream status/network/timeouts without recording identities,
cookies or provider payloads. The session's verified email proof has a six-hour
freshness limit; providers with longer access-token lifetimes can require a new
sign-in at that limit. Qualify the chosen provider's renewal behavior before launch.
