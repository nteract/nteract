# nteract notebook cloud prototype

This app is a Cloudflare Worker prototype for hosted nteract notebook rooms. It is intentionally small: the Worker authenticates a dev or anonymous viewer connection, stamps a trusted `<principal>/<operator>` actor label, routes `/n/:notebookId/sync` to a Durable Object keyed by notebook id, and relays typed-frame-v4-shaped WebSocket frames.

The current Durable Object does not host kernels and does not parse Automerge sync messages. It enforces connection scope, rewrites JSON presence actor principals, stores frame metadata, and broadcasts accepted binary typed frames to other peers in the same room.

`/n/:notebookId` is now a public read-only notebook viewer. The source of truth is still the persisted `NotebookDoc` Automerge snapshot in R2; the HTML viewer reads a JSON render cache generated from that snapshot by `runtimed-wasm` at publish time. This avoids committing the volatile generated WASM package to the Worker while keeping the projection grounded in shared notebook APIs. The next step is to serve or bundle `runtimed-wasm` so the viewer can materialize `.am` bytes directly.

## Local dev

```bash
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud test
pnpm --dir apps/notebook-cloud dev
```

With Wrangler running:

```bash
pnpm --dir apps/notebook-cloud smoke
pnpm --dir apps/notebook-cloud publish:demo
```

The smoke script proves:

- WebSocket upgrade on `/n/:notebookId/sync`.
- Durable Object room routing by notebook id.
- Dev identity stamping from `X-User` / `X-Operator` headers or `user` / `operator` query params.
- Presence principal rewrite to the authenticated principal.
- Safe authenticated fallback for malformed/non-JSON presence payloads.
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

If no scope is supplied, dev auth defaults to `viewer`. Write and publish paths must ask for `editor`, `runtime_peer`, or `owner` explicitly.

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
- `NOTEBOOK_SNAPSHOTS`: R2 bucket for Automerge snapshot bytes, generated render caches, and blobs.

Schema lives in `migrations/0001_initial.sql`. The Worker also creates the same tables lazily in local dev so the WebSocket path can run before applying migrations.

## Prototype deployment

Disposable Cloudflare resources currently wired in `wrangler.toml`:

- Worker: `nteract-notebook-cloud`
- URL: `https://nteract-notebook-cloud.rgbkrk.workers.dev`
- D1: `nteract-notebook-cloud-prototype-db`
- R2: `nteract-notebook-cloud-prototype`

The remote migration was applied with:

```bash
pnpm --workspace-root exec wrangler d1 migrations apply nteract-notebook-cloud-prototype-db \
  --config apps/notebook-cloud/wrangler.toml \
  --remote
```

Deploy with:

```bash
pnpm --workspace-root exec wrangler deploy --config apps/notebook-cloud/wrangler.toml
```

Snapshot and blob stubs:

```bash
curl -X PUT "http://127.0.0.1:8787/api/n/demo/snapshots/heads123" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
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

1. Replace JSON presence shim with `notebook_doc::presence` CBOR parsing from shared WASM.
2. Move the Durable Object from byte relay to a real `runtimed-wasm` room peer.
3. Persist Automerge snapshots by heads hash after accepted sync frames.
4. Swap dev auth for OIDC/JupyterHub providers using the `nteract-identity` model.
