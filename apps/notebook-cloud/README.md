# nteract notebook cloud prototype

This app is a Cloudflare Worker prototype for hosted nteract notebook rooms. It is intentionally small: the Worker authenticates dev credentials, direct OIDC browser sessions, Anaconda API-key publishing requests, or anonymous viewer connections, authorizes the principal through the D1 room ACL, stamps a trusted `<principal>/<operator>` actor label, and routes `/n/:notebookId/sync` to a Durable Object keyed by notebook id.

The current Durable Object does not host kernels. It owns a `runtimed-wasm` room host for the notebook's `NotebookDoc` + `RuntimeStateDoc`, syncs peers with typed-frame v4, rejects unauthorized Automerge changes before mutating the room, checkpoints the materialized document pair in Durable Object storage, rewrites canonical CBOR presence through the shared helper, and stores bounded frame metadata for sync frames that actually change a materialized document. Viewer-scope peers use the normal sync exchange so they can materialize live room updates, while the room host uses read-only peer state as a protocol hint and still rejects any viewer-authored changes explicitly. No-op read-only sync control frames are acknowledged and delivered as protocol traffic, but they are not persisted as room-event history. Editor-scope live `NotebookDoc` writes are deliberately limited to existing markdown-cell source edits in this prototype; code cells and structural document changes remain read-only unless the connection has owner scope. Runtime peers use a separate `RuntimeStatePeerHandle` authoring surface: they can sync kernel lifecycle, widget comm topology, output routing, and progress/output state for room-accepted executions into `RuntimeStateDoc`, but they cannot create execution intent, edit `NotebookDoc`, rewrite trust/environment/path/project metadata, or acquire the frontend notebook editing API.

`/n/:notebookId/:vanityName` is a hosted notebook page backed by `/n/:id/sync`. Latest notebook views do not fetch a separate materialized render document; viewers join the live Automerge room as read-only peers and editor+ connections use the same synced document for permitted edits. `/n/:id/r/:headsHash` is an immutable pinned viewer that loads the persisted `NotebookDoc` + `RuntimeStateDoc` + `CommsDoc` Automerge snapshot set directly through `/api/n/:id/snapshots/:headsHash`, `/api/n/:id/runtime-snapshots/:runtimeHeadsHash`, `/api/n/:id/comms-snapshots/:commsHeadsHash`, and catalog revision metadata. Snapshot publishes validate that the documents can be loaded and that referenced output/widget blobs exist before recording the catalog revision, so missing runtime or comm snapshots, corrupt snapshot bytes, or missing blobs fail the publish request instead of advertising a broken revision. Output blob refs stay host-neutral and are mapped to `/api/n/:id/blobs/:hash` through the shared `BlobResolver` surface. The browser viewer bundle uses the shared notebook display components (`CellContainer`, `OutputArea`, `ReadOnlyCodeMirror`, `MediaProvider`) so published source, markdown, stdout/stderr, rich display data, widgets, and blob-backed renderer manifests go through the same isolated output renderer path as the desktop notebook.

## Local dev

```bash
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud test
pnpm --dir apps/notebook-cloud wasm
pnpm --dir apps/notebook-cloud build:viewer
pnpm --dir apps/notebook-cloud dev
```

`typecheck` runs `cargo xtask wasm-ensure-runtime` first so a clean checkout regenerates
the gitignored `runtimed-wasm` bindings before TypeScript reads them. Use
`pnpm --dir apps/notebook-cloud wasm` when you explicitly want a full
`runtimed-wasm` rebuild.

With Wrangler running:

```bash
pnpm --dir apps/notebook-cloud smoke
pnpm --dir apps/notebook-cloud smoke:hosted
pnpm --dir apps/notebook-cloud smoke:hosted:live
pnpm --dir apps/notebook-cloud smoke:hosted:collab
pnpm --dir apps/notebook-cloud publish:demo
pnpm --dir apps/notebook-cloud publish:fixture
pnpm --dir apps/notebook-cloud publish:live
```

`pnpm --dir apps/notebook-cloud dev` derives stable Wrangler HTTP and inspector
ports from the git worktree root, so parallel worktrees do not all bind to
`8787` and `9229`. The command prints the local base URL. Local smoke and
publish scripts derive the same URL by default; set `NTERACT_CLOUD_URL` to
target a deployed Worker instead. `NOTEBOOK_CLOUD_URL` remains accepted for
existing smoke commands. Use
`NOTEBOOK_CLOUD_WRANGLER_PORT` or
`NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT` only when you need an explicit local
override.

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
- Materialized room sync for real `NotebookDoc` and `RuntimeStateDoc` frames.
- Editor-scope markdown source edits are accepted, while code-cell edits and structural `NotebookDoc` changes are rejected.

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
http://127.0.0.1:<worktree-port>/n/demo/debug
```

The notebook viewer is available at:

```text
http://127.0.0.1:<worktree-port>/n/{generated-ulid}/demo
```

`/` serves the sign-in shell; open notebooks through `/n/{id}/{vanityName}`.

`publish:fixture` defaults to `packages/runtimed/tests/fixtures/output_streaming`
and publishes a notebook revision with real `RuntimeStateDoc` output manifests:

```text
http://127.0.0.1:<worktree-port>/n/{generated-ulid}/output_streaming
```

Set `NOTEBOOK_CLOUD_FIXTURE=<fixture-dir>` and
`NOTEBOOK_CLOUD_NOTEBOOK_ID=<id>` to publish another fixture pair. If no
notebook id is provided, `publish:demo`, `publish:fixture`, and `publish:live`
generate a fresh ULID-shaped `NotebookDoc` id. The readable path segment is a
vanity name derived from the notebook title or filename stem when available,
and can be overridden with `NOTEBOOK_CLOUD_VANITY_NAME`.

`smoke:hosted` runs a headless Chromium check against the deployed
`preview.runt.run` topic-viz notebook by default:

```text
https://preview.runt.run/n/topic-viz/topic-viz
```

Install the Chromium browser once before running the hosted smoke from a fresh
checkout:

```bash
pnpm --dir apps/notebook-cloud smoke:hosted:install
```

It verifies that the hosted viewer renders the live-published code cell with a
runtime-derived execution count, that sandboxed output iframes expose expected
markdown and Sift notebook content, and that Sift's WASM sidecar loads from the
configured renderer asset origin with CORS. Latest notebook URLs are validated
through the live viewer path and catalog metadata; pinned
`/n/:id/r/:headsHash` URLs load persisted Automerge snapshot bytes rather than a
materialized render API. Override the target with
`NOTEBOOK_CLOUD_HOSTED_URL` or a positional URL argument. Set
`NOTEBOOK_CLOUD_SMOKE_SCREENSHOT=/tmp/notebook-cloud.png` to save a visual
artifact. The JSON report includes coarse `timings_ms` milestones plus
`performanceDiagnostics.resources_by_kind` for viewer document, viewer JS/CSS,
`runtimed-wasm`, output document frames, Sift WASM, notebook output blob fetches,
and pinned snapshot fetches when a pinned URL is tested. Use these diagnostics
to choose performance work before adding timing budgets.

For non-MathNet published notebooks, customize the hosted smoke expectations
with `NOTEBOOK_CLOUD_EXPECTED_SOURCE_TEXT`,
`NOTEBOOK_CLOUD_EXPECTED_EXECUTION_COUNT`, and
`NOTEBOOK_CLOUD_EXPECTED_FRAME_TEXTS`. Markdown cells and isolated output
renderers are checked as frame text because they render inside sandboxed output
documents. Frame texts can be a JSON string array or a `|`-delimited list. Set
`NOTEBOOK_CLOUD_EXPECTED_PAGE_TEXTS` only for text that should appear in the
parent viewer document. Set
`NOTEBOOK_CLOUD_EXPECTED_CATALOG_OWNER_PRINCIPAL=` and
`NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_ACTOR_LABEL=` to skip the live-publish
catalog provenance checks, or set them to the expected owner/actor for another
published notebook. `NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_NOTEBOOK_HEADS_HASH`
and `NOTEBOOK_CLOUD_EXPECTED_LATEST_REVISION_RUNTIME_HEADS_HASH` can pin the
catalog check to a specific exported snapshot set. Set
`NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM=0` when the target notebook does not include a
Sift output.

`publish:live` exports a real synced notebook session through `@runtimed/node`,
uploads its `NotebookDoc` + `RuntimeStateDoc` + `CommsDoc` snapshot set, walks
the exported output and widget manifests for blob refs, uploads the matching
local daemon blobs, and verifies the catalog revision. By default it creates and
executes a small `ShadenA/MathNet` Polars notebook. Set
`NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID=<id>` to publish an already-open live
notebook room instead.

The hidden `runt publish` CLI follows the same source-room idea but lets the
cloud allocate the hosted notebook id. It first posts the requested vanity name
and local source identity to `/api/n`, then uploads blobs and snapshot bytes to
the returned target:

```bash
runt publish --source-notebook-id <local-room-uuid> --vanity-name markdown-harness
```

For local `.ipynb` files, pass the path as `SOURCE`; the CLI opens it through
the daemon, derives the default vanity segment from the filename, and still lets
the cloud allocate the hosted id:

```bash
runt publish ./examples/markdown-harness.ipynb
```

Hosted publishing uses `NTERACT_CLOUD_URL` for the cloud origin and
`NTERACT_API_KEY` for bearer auth. `NTERACT_PUBLISH_URL`,
`NOTEBOOK_CLOUD_URL`, and `NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN` remain accepted
aliases while the alpha publishing surface is settling. `NOTEBOOK_CLOUD_NOTEBOOK_ID`
only applies to the local npm publish scripts above; `runt publish` always asks
the cloud to allocate the hosted notebook id.

`smoke:hosted:live` composes the two live checks: it runs `publish:live`, reads
the returned viewer URL and exported notebook/runtime heads, then runs
`smoke:hosted` against that exact notebook while asserting the catalog latest
revision still points at those heads. Use `NTERACT_CLOUD_URL=https://preview.runt.run`
and `NOTEBOOK_CLOUD_DEV_TOKEN=...` only for the deployed smoke run, or leave the
defaults to target local Wrangler.

`smoke:hosted:source-room` covers the already-open room path. It creates and
executes the same live MathNet notebook first, then calls `smoke:hosted:live`
with `NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID=<created-room-id>` so `publish:live`
must reopen and export that existing room instead of creating its own preset
session.

`smoke:hosted:collab` covers the deployed browser collaboration path. By
default it seeds a throwaway markdown room through `wasm:roundtrip`, then opens
four isolated Chromium contexts: Alice (`owner`), Bob (`editor`), anonymous
viewer, and ungranted Charlie (`editor`). Alice and Bob get the dev token only
through the same browser localStorage keys as the viewer's prototype
collaborator menu, matching the production viewer path where the WebSocket
sends the token as a subprotocol instead of a URL parameter. The smoke verifies
that Alice edits reach Bob and anonymous without reload, Bob edits reach Alice
and anonymous without reload, Charlie is denied editor access, and no request
URL contains the dev token. Pass
`NOTEBOOK_CLOUD_COLLAB_VIEWER_URL=https://.../n/<id>/<vanity-name>` to reuse an existing room
instead of seeding a new one.

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

For local browser-only testing, the same values can be supplied as query params:

```text
/n/demo/sync?user=alice&operator=desktop:browser&scope=viewer
```

`X-Principal` or `principal` may be used to provide a full principal directly. The Worker stamps internal `x-nteract-*` headers before forwarding to the Durable Object, modeling the ADR boundary where the room host trusts an upstream-authenticated identity.

Dev credentials are accepted without an extra token only from loopback Wrangler local development (`localhost`, `127.0.0.1`, or `::1`). Deployed prototype environments require the `NOTEBOOK_CLOUD_DEV_TOKEN` Worker secret to match either the `X-Notebook-Cloud-Dev-Token` header or a WebSocket subprotocol named `nteract-dev-token.<base64url-token>`. `DEPLOYMENT_ENV=development` does not bypass this host check, and URL-carried `dev_token` credentials are rejected on deployed hosts so prototype owner credentials do not appear in URLs. If no scope is supplied, dev auth defaults to `viewer`. Write and publish paths must ask for `editor`, `runtime_peer`, or `owner` explicitly. Blob upload is allowed for runtime peers and owners only, and verifies that the uploaded bytes match the SHA-256 digest in the blob route before writing to R2. Runtime peers may write typed-frame `0x05` (`RuntimeStateDoc`) kernel lifecycle, widget comm topology, output routing, and progress/output changes for accepted executions through the materialized room host; typed-frame `0x00` (`NotebookDoc`) changes, direct execution creation, and trust/environment/path/project metadata rewrites are rejected for runtime_peer scope. Editor and owner `0x05` frames are accepted only for existing widget comm-state mutations under the shared `RuntimeStateDoc` policy; viewer and peer-authored `system` changes are rejected.

For the browser-hosted editor prototype, the viewer keeps the dev token out of
URLs. Open the key menu in the sticky toolbar, paste the Worker dev token, pick
`alice`/`bob` and `editor`, and apply the identity. The token is stored only in
origin-local browser storage and is sent to `/n/:id/sync` as a WebSocket
subprotocol, never as a query parameter. The same menu shows sanitized
diagnostics for the requested principal/scope, connected room actor/scope,
placeholder-token fallback, and the latest connection error. Use **Copy
diagnostics** when sharing an `Offline` report; it intentionally omits the dev
token. The browser also offers the non-sensitive `nteract.v4` WebSocket
subprotocol; the Worker strips the credential-bearing protocol element before
the room responds.

For scripted browser setup, use the same storage keys the toolbar manages:

```js
localStorage.setItem("nteract:notebook-cloud:dev-token", "...real token...");
localStorage.setItem("nteract:notebook-cloud:user", "live-publish");
localStorage.setItem("nteract:notebook-cloud:scope", "editor");
location.reload();
```

That upgrades the same viewer bundle from anonymous read-only mode to
editor-scope markdown editing for existing markdown cells. The CodeMirror
editor uses the shared presence sender, shared remote cursor renderer, and
shared presence reducer, so cursor/selection presence carries the room-stamped
actor label (`<principal>/<operator>`) that also backs CRDT attribution. Clear
these local storage keys, or use the toolbar's Anonymous action, to return the
browser to anonymous viewer mode. If the stored token is still a placeholder
such as `<NOTEBOOK_CLOUD_DEV_TOKEN>`, the viewer refuses to use it, connects as
an anonymous viewer instead, and shows a visible diagnostic with a reset button.

## Direct OIDC auth

`preview.runt.run` uses direct OIDC against Anaconda stage. The Worker injects
the issuer, client id, and redirect URI into the first-party viewer shell, and
the browser completes an Authorization Code + PKCE flow through `/oidc`.
Authenticated browser HTTP requests use `Authorization: Bearer`; browser
WebSockets send the token through a non-echoed bearer subprotocol. The Worker
validates the JWT issuer, audience/client id, signature, time claims, and
principal namespace before consulting the D1 room ACL.

Signed-in users can still read public notebooks when they do not have explicit
collaborator rows. Viewer-scope HTTP reads authorize through the public
`notebook_acl` row, and same-origin browser live-room connections may fall back
from a stale `editor` request to stamped `viewer` scope for public notebooks.
Mutation routes do not use that downgrade.

Non-browser publishing uses a publish bearer token:

```text
Authorization: Bearer <NTERACT_API_KEY>
X-Notebook-Cloud-Auth-Provider: anaconda-api-key
```

`runt publish` treats this as publish bearer auth. It defaults to the current
hosted staging URL, `https://preview.runt.run`, accepts `NTERACT_CLOUD_URL` for
a different deployment, loads publish-related values from `.env`, and maps
`NTERACT_API_KEY` to the current provider header automatically.
The Worker validates the token through Anaconda `whoami`; the validated
`cloud:write` scope, not unverified JWT payload claims, is what authorizes owner
publishes. Existing token values can be reused if they pass that validation.
Put those values in `NTERACT_API_KEY`; `ANACONDA_API_KEY` is intentionally not a
public publish env name. `NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN` remains accepted
as a compatibility alias:

```bash
NTERACT_CLOUD_URL=https://preview.runt.run \
NTERACT_API_KEY=... \
runt publish --vanity-name topic-viz ./topic-viz.ipynb
```

Each hosted publish reserves a cloud notebook id before uploading snapshots. The
cloud generates that id as a ULID; the vanity name only controls the readable
path segment. To publish an already-open daemon room, pass its notebook UUID
instead of a file path, or use `--source-notebook-id`. This exports the active
session's `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` snapshot set, so
executed outputs and widget/runtime state are included:

```bash
NTERACT_CLOUD_URL=https://preview.runt.run \
NTERACT_API_KEY=... \
runt publish --source-notebook-id <open-notebook-uuid> --vanity-name markdown-harness
```

See `docs/adr/hosted-direct-oidc-demo-runbook.md`.

Requests with no dev credential become anonymous public viewers. The Worker derives:

```text
anonymous:<session>/browser:<session>
```

from the `viewer_session` query parameter, `X-Viewer-Session` header, or a generated UUID. This is intentionally not `system`: `system` is reserved for seed/import authorship, while anonymous viewers are real room connections with read-only `viewer` scope. Anonymous viewers cannot write `NotebookDoc`, `RuntimeStateDoc`, blob, pool, or request frames. Anonymous presence is local-only so public page views do not appear as collaborators to editors.

Snapshot and blob reads require `viewer` authorization. Anonymous
users only receive that scope when the notebook has an explicit public
`notebook_acl` row. Production hosts should move output blobs to signed URLs or
a dedicated output origin before accepting private notebook data at scale.

## ACL management

The prototype exposes a small owner-only ACL API:

```text
GET    /api/n/{notebookId}/acl
POST   /api/n/{notebookId}/acl
DELETE /api/n/{notebookId}/acl
```

`GET` returns the current flat D1 ACL rows. `POST` grants one row and `DELETE`
revokes one row using this JSON body:

```json
{
  "subject_kind": "principal",
  "subject": "user:anaconda:alice",
  "scope": "editor"
}
```

Public read is explicit:

```json
{
  "subject_kind": "public",
  "subject": "anonymous",
  "scope": "viewer"
}
```

Public rows may only grant `viewer`, and principal rows cannot target `system`
or anonymous principals. Deleting the final owner row is rejected. Group/org
expansion, owner transfer workflow, audit events, and Zanzibar/Authzed-style
relationship evaluation remain outside this prototype API.

## Storage shape

Bindings in `wrangler.toml`:

- `NOTEBOOK_ROOMS`: Durable Object namespace, one object per notebook id.
- `DB`: D1 catalog for notebooks, revisions, and blobs.
- `NOTEBOOK_SNAPSHOTS`: R2 bucket for `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and blob snapshots.
- `ASSETS`: Worker static assets for `/assets/notebook-cloud-viewer.js`, renderer chunks, and `/plugins/sift_wasm.wasm`.
- `RENDERER_ASSETS_BASE_URL` (optional): base URL for renderer plugin assets such as `sift_wasm.wasm`. The prototype deployment points this at the dedicated `nteract-notebook-cloud-assets` Worker. If unset, the viewer uses the main Worker-owned `/renderer-assets/` route so sandboxed `srcdoc` iframes can fetch plugin WASM through explicit CORS headers.
- `RUNTIMED_WASM_BASE_URL` (optional): base URL for `runtimed_wasm.js` and `runtimed_wasm_bg.wasm`. The prototype deployment also points this at the dedicated asset Worker so the large WASM module is loaded as a CDN cacheable file instead of being inlined into the viewer bundle.
- `OUTPUT_DOCUMENT_BASE_URL` (optional): URL for the isolated output document shell. The prototype deployment points this at the dedicated `nteract-notebook-cloud-outputs` Worker. If unset, the shared renderer keeps using browser `srcdoc` for local/prototype fallback.
- `NOTEBOOK_CLOUD_ALLOWED_ORIGINS` (optional): comma- or whitespace-separated notebook application origins added to the same-origin WebSocket allowlist. Browser-visible credential subprotocols always require an allowed `Origin`; header-authenticated native/CLI clients may omit `Origin`, but any supplied `Origin` must be allowed.

The dedicated renderer asset Worker serves only public, build-time sidecar files from the plugin asset bundle. It intentionally sends `Access-Control-Allow-Origin: *` so sandboxed `srcdoc` iframes with opaque origins can fetch renderer WASM and so the parent viewer can import runtime WASM from a CDN origin. Do not serve authenticated, notebook-specific, or user-generated blobs from this origin; those belong behind the notebook host's blob resolver or a future signed output origin. Deploy the renderer asset Worker before the main Worker when `RENDERER_ASSETS_BASE_URL` or `RUNTIMED_WASM_BASE_URL` points at the separate origin.

Schema lives in `migrations/`. The Worker also creates the current catalog tables lazily in local dev so the WebSocket path can run before applying migrations.

Accepted WebSocket frame payload caps mirror `notebook-wire` per-frame limits:
Automerge sync, runtime-state sync, and response frames may be up to 64 MiB;
`PUT_BLOB` up to 32 MiB; request and broadcast frames up to 16 MiB; presence
frames up to 4 KiB; and pool-state/session-control frames up to 1 MiB. The
Durable Object keeps only the latest 500 `frame:*` metadata entries in object
storage; D1 is not a frame replay log.

Published revision artifacts follow `docs/adr/hosted-notebook-artifacts.md`:

```text
n/{id}/snapshots/{notebookHeadsHash}.am
docs/{runtimeStateDocId}/snapshots/{runtimeHeadsHash}.am
docs/{comms:runtimeStateDocId}/snapshots/{commsHeadsHash}.am
n/{id}/blobs/{sha256}
```

Notebook snapshots currently retain the `n/{id}` compatibility namespace.
Runtime-state snapshots are keyed by first-class `runtime_state_doc_id`; publish
and runtime-snapshot routes require `X-Runtime-State-Doc-Id`, and the catalog row
stores both `runtime_state_doc_id` and the concrete `runtime_snapshot_key`.
CommsDoc snapshots use the same runtime-state document id namespace with a
`comms:` prefix and are referenced by `comms_snapshot_key`.
Legacy revisions can still be read through their recorded snapshot keys.

Snapshot publishes validate that the documents can be loaded through
`runtimed-wasm` and that all referenced blobs are present before recording a
revision. The hosted viewer reads the snapshot set directly for pinned
revisions and uses `/n/:id/sync` for live latest views.

## Prototype deployment

Disposable Cloudflare resources currently wired in `wrangler.toml`:

- Worker: `nteract-notebook-cloud`
- Renderer asset Worker: `nteract-notebook-cloud-assets`
- Output document Worker: `nteract-notebook-cloud-outputs`
- URL: `https://preview.runt.run`
- Renderer assets URL: `https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/`
- Output document URL: `https://preview.runtusercontent.com/frame/`
- D1: `nteract-notebook-cloud-prototype-db`
- R2: `nteract-notebook-cloud-prototype`

The renderer asset Worker binds only `dist/plugins`, not the full viewer bundle, so the separate origin is limited to renderer sidecars such as Sift's WASM binary. The output document Worker binds only `dist-output-document` and serves the shared isolated output shell; it does not expose notebook APIs, app bundle assets, renderer sidecars, blobs, or room WebSockets.

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
pnpm --workspace-root exec wrangler deploy --config apps/notebook-cloud/wrangler.output-document.toml
pnpm --workspace-root exec wrangler deploy --config apps/notebook-cloud/wrangler.toml
```

## Operational observability

The Worker emits Cloudflare-safe structured console records with the prefix
`[notebook-cloud]`. Records include `service`, `event`, `timestamp`, and
event-specific dimensions such as `notebook_id`, `peer_id`, `scope`,
`frame_type`, `duration_ms`, and log-derived counters (`counter` +
`counter_delta`). Do not add request bodies, auth tokens, raw WebSocket payloads,
or notebook source text to these logs.

Tail the deployed prototype with:

```bash
pnpm --workspace-root exec wrangler tail nteract-notebook-cloud \
  --config apps/notebook-cloud/wrangler.toml \
  --format pretty
```

Useful events while debugging collaboration:

- `room.connection.accepted` / `room.connection.closed` - peer lifecycle and
  `room_peer_count`.
- `room.peer_sync.completed` / `room.peer_sync.failed` - bootstrap sync latency
  and reconnect churn.
- `room.frame.rejected` - scope validation, malformed frames, and room-host
  write rejection. Count by `counter=rejected_frames`.
- `room.materialized_frame.applied` - `NotebookDoc` / `RuntimeStateDoc` / `CommsDoc` frame
  application duration, changed flags, whether the inbound frame was persisted,
  and outbound fanout.
- `room.materializer.loaded`, `room.materializer.checkpoint.saved`, and
  `room.materializer.snapshot_pair_missing` - Durable Object materialization and
  persisted snapshot health.
- `snapshot_pair.validation.completed`, `snapshot_pair.validation.failed`, and
  `snapshot_pair.validation.missing_blobs` - publish-time snapshot-set health
  and missing output/widget blob diagnosis.
- `asset.fetch.completed` - viewer, `runtimed-wasm`, and renderer-plugin sidecar
  asset delivery. Filter by `asset_kind=renderer_plugin` for Sift WASM loading.
- `blob.read.missing`, `blob.upload.completed`, and `blob.upload.rejected` -
  output blob resolution and runtime/upload behavior.
- `authz.denied`, `acl.grant.completed`, and `acl.revoke.completed` - ACL
  decisions and owner mutations.

Quick deployed smoke runbook:

```bash
NTERACT_CLOUD_URL=https://preview.runt.run \
NOTEBOOK_CLOUD_DEV_TOKEN=... \
pnpm --dir apps/notebook-cloud smoke

NTERACT_CLOUD_URL=https://preview.runt.run \
NOTEBOOK_CLOUD_DEV_TOKEN=... \
pnpm --dir apps/notebook-cloud wasm:roundtrip

NTERACT_CLOUD_URL=https://preview.runt.run \
NOTEBOOK_CLOUD_DEV_TOKEN=... \
pnpm --dir apps/notebook-cloud smoke:hosted:live

NTERACT_CLOUD_URL=https://preview.runt.run \
NOTEBOOK_CLOUD_DEV_TOKEN=... \
pnpm --dir apps/notebook-cloud smoke:hosted:collab

NOTEBOOK_CLOUD_HOSTED_URL=https://preview.runt.run/n/<id>/<vanity-name> \
NOTEBOOK_CLOUD_REQUIRE_SIFT_WASM=0 \
pnpm --dir apps/notebook-cloud smoke:hosted
```

These smoke commands use `NOTEBOOK_CLOUD_DEV_TOKEN` as a prototype diagnostic
credential. `wasm:roundtrip` refuses to target a deployed Worker without that
environment variable because deployed dev credentials must never travel in
URLs. Its JSON result includes `timings_ms` for owner
seeding, ACL grants, peer connection, and both Alice/Bob/anonymous convergence
directions; use those values with `room.peer_sync.completed` and
`room.materialized_frame.applied` logs to separate WebSocket latency from room
materialization cost.

`smoke:hosted:collab` builds on that protocol roundtrip with a browser-level
check. Its JSON result includes the throwaway `viewerUrl`, the room id, and
per-step timings for browser open, connection, Alice/Bob edit propagation,
anonymous live updates, and Charlie's denied editor session. Set
`NOTEBOOK_CLOUD_COLLAB_ROUNDS=<n>` to increase the default Alice/Bob ping-pong
markdown edit convergence loop when chasing intermittent editor divergence.

Use `GET /api/n/{id}/acl` with an owner credential to confirm editor/viewer
grants. A healthy throwaway collaboration run should show editor
`room.materialized_frame.applied` records with `persisted=true` when Alice/Bob
change the document, viewer `room.peer_sync.completed` records, no unexpected
`room.frame.rejected` records for Alice/Bob, and anonymous viewer presence
logged only as `room.presence.local_only`. Read-only viewer sync acks/needs may
emit `room.materialized_frame.applied` with `persisted=false`; they should not
create stored room-event history. If the browser shows `Offline`, open the key
menu first: placeholder or stale dev tokens are surfaced there, and the Worker
logs token/auth failures as `auth.failed` without recording raw token material.
The copied browser diagnostic should include the requested principal/scope,
connected actor/scope when available, and the last WebSocket connection error,
but never the stored token value.

Snapshot and blob stubs:

```bash
NOTEBOOK_CLOUD_LOCAL_URL="${NTERACT_CLOUD_URL:-${NOTEBOOK_CLOUD_URL:-http://127.0.0.1:<worktree-port>}}"

curl -X PUT "$NOTEBOOK_CLOUD_LOCAL_URL/api/n/demo/runtime-snapshots/runtime123" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
  --data-binary @runtime-state.am

curl -X PUT "$NOTEBOOK_CLOUD_LOCAL_URL/api/n/demo/snapshots/heads123" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
  -H "X-Runtime-Heads-Hash: runtime123" \
  --data-binary @notebook.am

curl -X PUT "$NOTEBOOK_CLOUD_LOCAL_URL/api/n/demo/blobs/sha256abc" \
  -H "X-User: alice" \
  -H "X-Operator: desktop:curl" \
  -H "X-Scope: owner" \
  --data-binary @output.bin
```

Catalog and pinned snapshot readback:

```bash
NOTEBOOK_CLOUD_LOCAL_URL="${NTERACT_CLOUD_URL:-${NOTEBOOK_CLOUD_URL:-http://127.0.0.1:<worktree-port>}}"

curl "$NOTEBOOK_CLOUD_LOCAL_URL/api/n/demo"
curl "$NOTEBOOK_CLOUD_LOCAL_URL/api/n/demo/snapshots/{notebookHeadsHash}"
curl "$NOTEBOOK_CLOUD_LOCAL_URL/api/n/demo/runtime-snapshots/{runtimeHeadsHash}" \
  -H "X-Runtime-State-Doc-Id: {runtimeStateDocId}"
```

## Next integration steps

1. Verify `preview.runt.run` topic-viz, lets-edit, and hosted smoke paths after
   each live-sync or auth change.
2. Keep the notebook page viewer-first: sign-in should not request edit by
   default, and public-read fallback should keep signed-in users out of
   anonymous-reset loops.
3. Move the cloud viewer/editor toward shared desktop notebook controller and
   cell/editor components instead of expanding cloud-only forks.
4. Replace flat ACL rows with the relationship model chosen for hosted
   notebooks.
5. Decide the runtime-peer upload flow for presigned blob writes and remote
   runtime agents.
6. Move notebook-specific output blobs to signed URLs or a dedicated private
   output origin before hosting private notebooks at scale.
