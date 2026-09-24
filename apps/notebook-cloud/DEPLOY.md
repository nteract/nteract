# Hosted notebook deployment

## Choose the deployment path

The app can run on Cloudflare or celld. Managed `*.runtimed.run` previews use
a separate trusted deployment controller; updating this repository's Wrangler
configuration does not update that controller's configuration.

| Deployment | Configuration owner | What must be supplied |
| --- | --- | --- |
| Cloudflare, including local Wrangler | [`wrangler.toml`](wrangler.toml) and sibling Worker configs | Durable Object bindings/migrations, D1, R2, assets, scheduled triggers, origins and authentication settings |
| Local or self-managed celld | [`scripts/celld-local.mjs`](scripts/celld-local.mjs) generated projects | The main, output-document and renderer-assets Workers, their generated bindings and storage, and the public origins/auth settings for the host |
| Managed `main.runtimed.run` and PR previews | Private [`nteract/preview-infra`](https://github.com/nteract/preview-infra), especially `lib/model.mjs` and `lib/lifecycle.mjs` | Controller-owned bindings, schedules, storage, credentials and compatible application build declarations |

The checked-in Wrangler file includes the bindings and schedule for notebook
rooms and the live `/n` listing. Its account resources and domains target
nteract's prototype. For your own deployment, provision your own D1/R2
resources and configure your domains, authentication and secrets. You do not
need access to the private preview controller to run Wrangler or local celld;
follow the [local development instructions](README.md#local-dev).

Managed Pyodide execution is an additional celld capability. Its application
export requires `NOTEBOOK_CLOUD_CELLD_PYTHON=1` and the built
`@nteract/preview-python` assets; managed previews also require the controller's
qualified Python runtime and provider configuration. The Cloudflare Wrangler
file alone does not configure that provider. Notebook storage/editing and a
connected external runtime remain separate from managed Python setup.

## Adding a hosted capability

When adding a Durable Object, binding, migration, scheduled handler or provider,
update and verify each supported deployment path:

1. Export the entrypoint from the app and configure its bindings/migrations in
   Wrangler and the celld exporter. Include a schedule when recovery depends on
   a scheduled handler.
2. For managed previews, coordinate the companion `preview-infra` change. The
   [trusted packaging helpers](../../.github/preview/README.md) include only
   compiled code, assets and migrations. They deliberately exclude generated
   `wrangler.json` files, which can contain secrets. An application declaration
   selects a fixed controller-supported capability; it never supplies arbitrary
   deployment configuration or privileges.
3. Define compatibility for older bundles, then install the reviewed controller
   support before deploying the declaring application. Preserve existing
   notebook storage and session identity during updates.
4. Check the deployed feature in a browser. A successful build, `/api/health`
   response or Ready preview comment does not prove a new binding works.

For Notebook Home, the exporter writes
`main/assets/__preview-notebook-home.json` containing `{"version":1}`. The
controller must recognize it and supply `NOTEBOOK_HOME` / `NotebookHome`, its
Durable Object migration, and the minute schedule that retries pending catalog
notifications. D1 schema migration `0010_notebook_home.sql` and lazy schema
initialization provide the outbox and catalog triggers.

An ordinary GET to `/api/notebook-home/events` returns **426** when the route is
configured and expects a WebSocket upgrade. **503** with "notebook home events
are not configured" means the D1 or Durable Object binding is missing. Then
verify signed-in `/n` tabs receive new notebooks and title changes without
refreshing either tab. Verify reconnect recovery and scheduled retry separately;
the minute schedule is recovery, not the normal update cadence. See the
[controller operations guide](https://github.com/nteract/preview-infra/blob/main/docs/operations.md)
for its installation and ownership rules.

## Deploying the Cloudflare prototype

`preview.runt.run` is the hosted prototype: this Worker plus its Durable Object
(`NOTEBOOK_ROOMS`), `DEPLOYMENT_ENV=prototype`, on the `preview.runt.run` custom
domain. It runs real endpoints and real room logic (`runtimed` compiled to WASM),
and the live demos run against it, so treat it as practically production.

## Deploy

From `apps/notebook-cloud`:

```bash
pnpm run deploy
```

That runs `pnpm run build` (compiles `runtimed` to WASM, builds the renderer
plugins, bundles the viewer with Vite, copies assets, and writes the runtime
WASM asset manifest), deploys `wrangler.renderer-assets.toml`, then deploys the
main Worker with `wrangler.toml`. The top-level `wrangler.toml` is the prototype
config (custom domain `preview.runt.run`, `DEPLOYMENT_ENV=prototype`), so there
is no `--env` flag.

Keep the renderer-assets deploy ahead of the main Worker. The viewer loads
content-hashed runtime WASM from the main Worker's
`/assets/runtime-wasm-assets.json`, and compatibility copies are also posted to
the renderer-assets Worker. Shipping only the main Worker can leave browser tabs
running new viewer JavaScript against stale sidecar WASM.

## Verify

```bash
pnpm run deploy:check
```

`curl`s `https://preview.runt.run/api/health`. Expect `status: ok`,
`deployment_env: prototype`, and both auth providers (`anaconda_api_key`, `oidc`)
`configured`. `wrangler deploy` also prints the new Version ID.

## Prerequisites

- `wrangler` authenticated to the Cloudflare account that owns `runt.run`.
  `wrangler whoami` should show `workers (write)`, `d1 (write)`, and
  `workers_routes (write)`.
- A Rust toolchain and `cargo xtask` for the WASM build.
- `wrangler.toml` keeps the Anaconda API-key userinfo URL on the same staging
  origin as the OIDC issuer:
  `https://auth.stage.anaconda.com/api/auth/sessions/whoami`. A production
  `anaconda.com` whoami endpoint rejects staging-minted API keys even though the
  OIDC path still works.

## Scope

`pnpm run deploy` ships the renderer assets Worker before the main rooms Worker.
The main Worker carries room logic, viewer assets, and the content-hashed
runtime WASM assets referenced by `/assets/runtime-wasm-assets.json`. The
renderer assets Worker carries public renderer sidecars such as `sift_wasm.wasm`
and compatibility copies of the runtime WASM files. The output-document sibling
Worker (`wrangler.output-document.toml`) still deploys independently with
`wrangler deploy -c wrangler.output-document.toml` when its own inputs change.
