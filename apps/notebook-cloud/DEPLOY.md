# Deploying to preview.runt.run

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

## Scope

`pnpm run deploy` ships the renderer assets Worker before the main rooms Worker.
The main Worker carries room logic, viewer assets, and the content-hashed
runtime WASM assets referenced by `/assets/runtime-wasm-assets.json`. The
renderer assets Worker carries public renderer sidecars such as `sift_wasm.wasm`
and compatibility copies of the runtime WASM files. The output-document sibling
Worker (`wrangler.output-document.toml`) still deploys independently with
`wrangler deploy -c wrangler.output-document.toml` when its own inputs change.
