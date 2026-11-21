# Embedding the hosted editor

After a successful nightly or stable release, a separate workflow builds and
attaches the browser editor as one tarball. These assets can arrive later than
the desktop release; a failed editor build never blocks desktop, wheels, or npm
publishing. Embedding hosts pin a release tag and SHA-256 instead of checking
out source or building Rust and WASM.

## What ships

Each release publishes two assets per channel (`nightly` or `stable`):

```text
notebook-cloud-assets-<channel>.tar.gz
notebook-cloud-assets-<channel>.tar.gz.sha256
```

Tarball layout:

| Path | Contents |
| --- | --- |
| `manifest.json` | Version, channel, `protocol_version`, source commit, `built_at`, and a SHA-256 for every other file |
| `viewer/assets/` | Editor entry script and stylesheet, OIDC callback script, hashed WASM engine files, and `runtime-wasm-assets.json` listing them |
| `viewer/plugins/` | Renderer plugin assets loaded from `rendererAssetsBasePath` |
| `output-document/` | `index.html`, the frame that renders untrusted cell output |
| `wasm/runtimed-wasm/` | `runtimed-wasm` engine (`runtimed_wasm.js` and `runtimed_wasm_bg.wasm`) for the host's server |
| `LICENSE` | License text |

- **Host-agnostic**: No host endpoints, credentials, or origins are baked in.
  Supply them through runtime JSON config so one tarball serves any host.
- **Deterministic packing**: Entry order, owners, mtimes, and `built_at` (from
  the release version timestamp) are fixed for identical inputs. Publication
  retries reuse the original packed bytes; rebuilding dependencies or the
  viewer is not a reproducibility guarantee.
- **Build output only**: The tarball contains no TypeScript source, so hosts do
  not depend on this repository's package layout.

## Verify

Download by release tag, verify the sidecar checksum, unpack, and check every
`manifest.json` entry:

```sh
TAG=v<version>
BASE=https://github.com/nteract/nteract/releases/download/$TAG
curl -fsSLO "$BASE/notebook-cloud-assets-stable.tar.gz"
curl -fsSLO "$BASE/notebook-cloud-assets-stable.tar.gz.sha256"
sha256sum -c notebook-cloud-assets-stable.tar.gz.sha256
mkdir editor && tar -xzf notebook-cloud-assets-stable.tar.gz -C editor
```

Record the tarball SHA-256 beside the tag in your deployment config. To run the
sidecar check, per-file manifest check, and a static serve smoke test, run
`scripts/ci/notebook-cloud-assets-smoke.sh` (requires `tar`, `sha256sum`, Node
22, and `curl` when given an `https://` URL).

## Serve

`viewer/` is a library build with no `index.html`. Render the host page and
mount the editor into it:

```html
<link rel="stylesheet" href="/assets/notebook-cloud-viewer.css" />
<div id="root"></div>
<script id="nteract-cloud-auth-config" type="application/json">{ ... }</script>
<script id="nteract-cloud-viewer-config" type="application/json">{ ... }</script>
<script type="module" src="/assets/notebook-cloud-viewer.js"></script>
```

- Serve `viewer/assets/` at `/assets/` on the editor origin.
- Serve `viewer/plugins/` at the URL passed as `rendererAssetsBasePath`, on its
  own origin or route.
- Serve `output-document/index.html` from a separate origin and pass that
  origin as `outputDocumentBaseUrl`. Output code must not share the editor's
  origin.
- Point `runtimedWasmModulePath` and `runtimedWasmPath` at the hashed files in
  `viewer/assets/` listed by `viewer/assets/runtime-wasm-assets.json`.
- Import `runtimed_wasm.js` and `runtimed_wasm_bg.wasm` from
  `wasm/runtimed-wasm/` on the host's server. The browser does not fetch this
  directory.

## Runtime configuration

Authoritative field lists live in the release tag's source: `loadConfig` in
`apps/notebook-cloud/viewer/cloud-viewer-config.ts` and
`normalizeOidcAuthConfig` in `apps/notebook-cloud/viewer/oidc-auth.ts`.

`#nteract-cloud-viewer-config` is required. The editor refuses to start if any
required key is missing:

| Group | Keys |
| --- | --- |
| Notebook | `notebookId` |
| Server endpoints | `catalogEndpoint`, `syncEndpoint`, `aclEndpoint`, `invitesEndpoint`, `accessRequestsEndpoint`, `workstationsEndpoint`, `workstationDefaultEndpoint`, `workstationAttachEndpoint` |
| Snapshot and blob paths | `snapshotBasePath`, `runtimeSnapshotBasePath`, `commsSnapshotBasePath`, `blobBasePath` |
| Asset paths | `rendererAssetsBasePath`, `runtimedWasmModulePath`, `runtimedWasmPath` |

Optional keys: `headsHash`, `authorProfilesEndpoint`, `outputDocumentBaseUrl`,
`hostCapabilities`, `featureFlags`, and `session`.

`#nteract-cloud-auth-config` is optional. Its `oidc` object enables OIDC
sign-in when `issuer`, `clientId`, and `redirectUri` are set (`providerLabel`,
`scope`, and `flow` are optional). Without the script or those three keys, the
editor runs without sign-in.

All endpoints target your notebook server, which imports `wasm/runtimed-wasm/`.
That server owns cross-origin allow-lists, identity mapping, and credentials.

## Compatibility

`manifest.json` records `protocol_version`, matching `PROTOCOL_VERSION` in
`crates/notebook-protocol/src/connection/handshake.rs` for that tag. Pin the
editor bundle and the daemon or runtime image to releases with the same
`protocol_version`. Releases are not wire-compatible across a protocol bump.

## Build and publication recovery

### Artifact flow

1. The upstream release's WASM build retains `release-wasm-<run>-<attempt>` for
   90 days (source, channel, version, build attempt, and per-file hashes).
   Uploading this copy is optional so storage failures never fail the release.
   The downstream builder selects the latest successful WASM job attempt and
   fails closed if its receipt is missing (never falling back to an older
   version or different bytes).
2. **Build editor assets** validates the upstream release, reuses its WASM and
   renderer bytes, builds the viewer once, and retains
   `editor-assets-<release-run>-<release-attempt>` for 90 days with the
   tarball, sidecar, and `candidate.json` (release, WASM, and build identities
   plus checksums). If a release retry reuses an earlier WASM build, that
   original WASM attempt is recorded separately from the release attempt.
3. **Publish editor assets** runs with write permission from the trusted
   default-branch checkout and treats downloaded artifacts as opaque bytes. It
   verifies the upstream release, immutable tag/source, artifact origin/digest,
   and asset hashes before upload. It never runs downloaded code, rebuilds,
   replaces an existing asset, or moves a rolling channel tag. After upload, it
   downloads and re-hashes both assets before reporting success.

### Recover a failed publication

1. Dispatch **Publish editor assets** on the default branch with the successful
   editor build run ID and attempt.
2. Partial uploads check existing member bytes and upload only the missing
   member. Exact completed pairs are a no-op; byte mismatches fail closed.
3. If GitHub leaves an incomplete `starter` asset after an interrupted upload,
   the publisher reports its asset ID and stops without deleting anything.
   Inspect and delete the incomplete asset manually, then retry the same editor
   build. Completed assets are never replaced.
4. Missing assets on an older release are refused once a newer release exists
   in that channel.

### Recover a failed build

1. Dispatch **Build editor assets** with the successful release run ID and
   attempt. Duplicate events and whole-workflow reruns find the retained
   completed candidate and skip build work.
2. If packed bytes exist for a failed build job, recovery stops for
   investigation.
3. If a successful candidate's artifact expires or is deleted, recovery fails
   explicitly. Cut a new release candidate instead of silently rebuilding the
   old identity. Keep editor build workflow run records while their release is
   supported so this barrier stays enforced.
4. Once packing succeeds, the sealed editor receipt and original WASM job
   record are enough for publication even if the large input WASM artifact
   expires. The editor candidate artifact and run records must remain retained.

### Prerequisites and limits

- Releases must include these workflows and the retained WASM receipt. Older
  releases cannot be backfilled by rebuilding their WASM.
- PR fixture and real-build smoke checks verify packing and static serving;
  they do not prove a published release asset has been accepted by a host.
