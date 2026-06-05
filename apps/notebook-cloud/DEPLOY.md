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
plugins, bundles the viewer with Vite, copies assets) and then `wrangler deploy`.
The top-level `wrangler.toml` is the prototype config (custom domain
`preview.runt.run`, `DEPLOYMENT_ENV=prototype`), so there is no `--env` flag.

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

`pnpm run deploy` ships only the main rooms Worker (`wrangler.toml`), which carries
the room logic and the viewer assets. The sibling Workers,
`wrangler.output-document.toml` (the output-document iframe) and
`wrangler.renderer-assets.toml` (the renderer assets Worker), change rarely and
deploy independently with `wrangler deploy -c <file>`. Deploy those only when their
own inputs change.
