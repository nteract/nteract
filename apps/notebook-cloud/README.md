# nteract notebook cloud prototype

This app is a Cloudflare Worker prototype for hosted nteract notebook rooms. It is intentionally small: the Worker authenticates a dev or anonymous viewer connection, stamps a trusted `<principal>/<operator>` actor label, routes `/n/:notebookId/sync` to a Durable Object keyed by notebook id, and relays typed-frame-v4-shaped WebSocket frames.

The current Durable Object does not host kernels and does not parse Automerge sync messages. It enforces connection scope, rewrites canonical CBOR presence through the shared `runtimed-wasm` helper, stores bounded frame metadata, and broadcasts accepted binary typed frames to other peers in the same room.

`/n/:notebookId` is now a public read-only notebook viewer. The durable source of truth is a persisted `NotebookDoc` + `RuntimeStateDoc` snapshot pair in R2; `/api/n/:id/render` materializes that pair with `NotebookHandle.load_snapshot()` when a render cache is absent. Output blob refs stay host-neutral and are mapped to `/api/n/:id/blobs/:hash` through the shared `BlobResolver` surface. The browser viewer bundle uses the shared notebook display components (`CellContainer`, `OutputArea`, `ReadOnlyCodeMirror`, `MediaProvider`) so published source, markdown, stdout/stderr, rich display data, and blob-backed renderer manifests go through the same isolated output renderer path as the desktop notebook.

## Local dev

```bash
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud test
pnpm --dir apps/notebook-cloud wasm
pnpm --dir apps/notebook-cloud build:viewer
pnpm --dir apps/notebook-cloud dev
```

With Wrangler running:

```bash
pnpm --dir apps/notebook-cloud smoke
pnpm --dir apps/notebook-cloud smoke:hosted
pnpm --dir apps/notebook-cloud publish:demo
pnpm --dir apps/notebook-cloud publish:fixture
pnpm --dir apps/notebook-cloud publish:live
```

The smoke script proves:

- WebSocket upgrade on `/n/:notebookId/sync`.
- Durable Object room routing by notebook id.
- Dev identity stamping from `X-User` / `X-Operator` headers or `user` / `operator` query params.
- Presence CBOR rewrite to the server peer id and authenticated principal.
- Explicit rejection for malformed/non-CBOR presence payloads.
- Same-room typed-frame relay.
- Viewer-scope rejection for notebook writes.
- Viewer-scope rejection for blob, request, and pool-state writes.
- Explicit anonymous viewer identity (`anonymous:<session>/browser:<session>`).
- Local-only anonymous presence: accepted to the sender, not broadcast or persisted.
- D1 room-event readback.

If the volatile frontend WASM package exists at `apps/notebook/src/wasm/runtimed-wasm`,
the deeper roundtrip smoke sends real `runtimed-wasm` Automerge sync payloads through
the Durable Object and verifies that a second `NotebookHandle` converges:

```bash
pnpm --dir apps/notebook-cloud wasm:roundtrip
```

Rebuild the volatile package with:

```bash
cargo xtask wasm runtimed --skip-renderer-plugins
```

The browser harness is available at:

```text
http://127.0.0.1:8787/n/demo/debug
```

The notebook viewer is available at:

```text
http://127.0.0.1:8787/n/nteract-cloud-demo
```

`/` redirects to that demo notebook id.

`publish:fixture` defaults to `packages/runtimed/tests/fixtures/output_streaming`
and publishes a notebook revision with real `RuntimeStateDoc` output manifests:

```text
http://127.0.0.1:8787/n/nteract-cloud-fixture-output_streaming
```

Set `NOTEBOOK_CLOUD_FIXTURE=<fixture-dir>` and
`NOTEBOOK_CLOUD_NOTEBOOK_ID=<id>` to publish another fixture pair.

`smoke:hosted` runs a headless Chromium check against the deployed canonical
MathNet notebook by default:

```text
https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet
```

Install the Chromium browser once before running the hosted smoke from a fresh
checkout:

```bash
pnpm --dir apps/notebook-cloud smoke:hosted:install
```

It verifies that the hosted viewer renders the live-published code cell with a
runtime-derived execution count, that sandboxed output iframes expose expected
notebook content, and that Sift's WASM sidecar loads from the configured
renderer asset origin with CORS. Override the target with
`NOTEBOOK_CLOUD_HOSTED_URL` or a positional URL argument. Override the content
contract with `NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT`,
`NOTEBOOK_CLOUD_EXPECTED_EXECUTION_COUNT`, and
`NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS` (`|` separated). Set
`NOTEBOOK_CLOUD_SMOKE_SCREENSHOT=/tmp/notebook-cloud.png` to save a visual
artifact.

`publish:live` exports a real synced notebook session through `@runtimed/node`,
uploads its `NotebookDoc` + `RuntimeStateDoc` snapshot pair, walks the rendered
output manifests for blob refs, uploads the matching local daemon blobs, and
materializes the hosted render. By default it creates and executes a small
`ShadenA/MathNet` Polars notebook. Set `NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID=<id>`
to publish an already-open live notebook room instead.

## Dev auth

The edge Worker maps dev credentials into the same identity shape as `crates/nteract-identity`:

```text
X-User: alice@example.com
X-Operator: desktop:local
X-Scope: editor
```

becomes:

```text
user:dev:alice%40example.com/desktop:local
```

For browser-only testing, the same values can be supplied as query params:

```text
/n/demo/sync?user=alice&operator=desktop:browser&scope=viewer
```

`X-Principal` or `principal` may be used to provide a full principal directly. The Worker stamps internal `x-nteract-*` headers before forwarding to the Durable Object, modeling the ADR boundary where the room host trusts an upstream-authenticated identity.

Dev credentials are accepted without an extra token only from Wrangler local development (`localhost`, `127.0.0.1`, `::1`, or `DEPLOYMENT_ENV=development`). Deployed prototype environments require the `NOTEBOOK_CLOUD_DEV_TOKEN` Worker secret to match either the `X-Notebook-Cloud-Dev-Token` header or `dev_token` query parameter. If no scope is supplied, dev auth defaults to `viewer`. Write and publish paths must ask for `editor`, `runtime_peer`, or `owner` explicitly.

Requests with no dev credential become anonymous public viewers. The Worker derives:

```text
anonymous:<session>/browser:<session>
```

from the `viewer_session` query parameter, `X-Viewer-Session` header, or a generated UUID. This is intentionally not `system`: `system` is reserved for seed/import authorship, while anonymous viewers are real room connections with read-only `viewer` scope. Anonymous viewers cannot write `NotebookDoc`, `RuntimeStateDoc`, blob, pool, or request frames. Anonymous presence is local-only so public page views do not appear as collaborators to editors.

Snapshot and blob reads are public in this prototype so `/n/:id` can act like a publish viewer without a product auth flow. Production hosts should move those reads behind viewer-or-better auth, signed URLs, or a dedicated output origin before accepting private notebooks.

## Storage shape

Bindings in `wrangler.toml`:

- `NOTEBOOK_ROOMS`: Durable Object namespace, one object per notebook id.
- `DB`: D1 catalog for notebooks, revisions, blobs, and room event metadata.
- `NOTEBOOK_SNAPSHOTS`: R2 bucket for `NotebookDoc` snapshots, `RuntimeStateDoc` snapshots, generated render caches, and blobs.
- `ASSETS`: Worker static assets for `/assets/notebook-cloud-viewer.js`, renderer chunks, and `/plugins/sift_wasm.wasm`.
- `RENDERER_ASSETS_BASE_URL` (optional): base URL for renderer plugin assets such as `sift_wasm.wasm`. The prototype deployment points this at the dedicated `nteract-notebook-cloud-assets` Worker. If unset, the viewer uses the main Worker-owned `/renderer-assets/` route so sandboxed `srcdoc` iframes can fetch plugin WASM through explicit CORS headers.

Schema lives in `migrations/0001_initial.sql`. The Worker also creates the same tables lazily in local dev so the WebSocket path can run before applying migrations.

Accepted WebSocket frame payload caps mirror `notebook-wire` per-frame limits: Automerge sync and runtime-state frames may be up to 64 MiB, `PUT_BLOB` up to 32 MiB, request frames up to 16 MiB, and presence/pool-state/session-control frames up to 1 MiB. The Durable Object keeps only the latest 500 `frame:*` metadata entries in object storage; D1 room events are observability rows, not the replay log.

Published revision artifacts follow `docs/architecture/hosted-notebook-artifacts.md`:

```text
n/{id}/snapshots/{notebookHeadsHash}.am
n/{id}/snapshots/runtime-state/{runtimeHeadsHash}.am
n/{id}/blobs/{sha256}
n/{id}/renders/{notebookHeadsHash}.json
```

The render path is optional. If it is missing, the Worker loads the snapshot pair through `runtimed-wasm` and returns a materialized render response.

## Prototype deployment

Disposable Cloudflare resources currently wired in `wrangler.toml`:

- Worker: `nteract-notebook-cloud`
- Renderer asset Worker: `nteract-notebook-cloud-assets`
- URL: `https://nteract-notebook-cloud.rgbkrk.workers.dev`
- Renderer assets URL: `https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/`
- D1: `nteract-notebook-cloud-prototype-db`
- R2: `nteract-notebook-cloud-prototype`

The renderer asset Worker binds only `dist/plugins`, not the full viewer bundle, so the separate origin is limited to renderer sidecars such as Sift's WASM binary.

The remote migration was applied with:

```bash
pnpm --workspace-root exec wrangler d1 migrations apply nteract-notebook-cloud-prototype-db \
  --config apps/notebook-cloud/wrangler.toml \
  --remote
```

Deploy with:

```bash
printf "%s" "$NOTEBOOK_CLOUD_DEV_TOKEN" \
  | pnpm --workspace-root exec wrangler secret put NOTEBOOK_CLOUD_DEV_TOKEN \
      --config apps/notebook-cloud/wrangler.toml
pnpm --dir apps/notebook-cloud build
pnpm --workspace-root exec wrangler deploy --config apps/notebook-cloud/wrangler.renderer-assets.toml
pnpm --workspace-root exec wrangler deploy --config apps/notebook-cloud/wrangler.toml
```

Snapshot and blob stubs:

```bash
curl -X PUT "http://127.0.0.1:8787/api/n/demo/runtime-snapshots/runtime123" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
  --data-binary @runtime-state.am

curl -X PUT "http://127.0.0.1:8787/api/n/demo/snapshots/heads123" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
  -H "X-Runtime-Heads-Hash: runtime123" \
  --data-binary @notebook.am

curl -X PUT "http://127.0.0.1:8787/api/n/demo/blobs/sha256abc" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
  --data-binary @output.bin
```

Catalog and event readback:

```bash
curl "http://127.0.0.1:8787/api/n/demo"
curl "http://127.0.0.1:8787/api/n/demo/events?limit=20"
curl "http://127.0.0.1:8787/api/n/demo/render"
```

## Next integration steps

1. Move the Durable Object from byte relay to a real `runtimed-wasm` room peer.
2. Publish a full Sift/Arrow fixture and verify blob-backed table rendering.
3. Swap dev auth for OIDC/JupyterHub providers using the `nteract-identity` model.
