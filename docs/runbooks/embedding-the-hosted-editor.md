# Embedding the hosted editor

After a successful nightly or stable release, an independent workflow builds
and attaches the browser editor as one tarball. The assets may arrive later
than the desktop release; a failed editor build does not block desktop, wheels,
or the existing npm publisher. A host that embeds the editor pins a release tag and a SHA-256. It does
not check out a commit or build Rust and WASM itself.

## What ships

Each release carries two assets, named by channel (`nightly` or `stable`):

```text
notebook-cloud-assets-<channel>.tar.gz
notebook-cloud-assets-<channel>.tar.gz.sha256
```

The tarball holds:

| Path | Contents |
| --- | --- |
| `manifest.json` | Version, channel, `protocol_version`, source commit, `built_at`, and a SHA-256 for every other file |
| `viewer/assets/` | The editor entry script and stylesheet, the OIDC callback script, hashed copies of the WASM engine, and `runtime-wasm-assets.json` naming them |
| `viewer/plugins/` | Renderer plugin assets the editor loads from `rendererAssetsBasePath` |
| `output-document/` | `index.html`, the frame that renders untrusted cell output |
| `wasm/runtimed-wasm/` | The `runtimed-wasm` engine (`runtimed_wasm.js` and `runtimed_wasm_bg.wasm`) for the host's server |
| `protocol/` | The TypeScript protocol package source and its `package.json` |
| `LICENSE` | License text |

The bundle has no host endpoints, credentials, or origins baked in. They arrive
through the JSON config described below. One tarball serves any host.

The packager fixes entry order, owners, modification times, and `built_at`
(the timestamp encoded in the release version). This makes packaging identical
inputs deterministic. Publication retries reuse the original packed bytes;
rebuilding dependencies or the viewer is not a reproducibility guarantee.

`protocol/` is source, not an npm package. Import it by path.

## Verify

Download by release tag, then check the sidecar and every manifest entry:

```sh
TAG=v<version>
BASE=https://github.com/nteract/nteract/releases/download/$TAG
curl -fsSLO "$BASE/notebook-cloud-assets-stable.tar.gz"
curl -fsSLO "$BASE/notebook-cloud-assets-stable.tar.gz.sha256"
sha256sum -c notebook-cloud-assets-stable.tar.gz.sha256
mkdir editor && tar -xzf notebook-cloud-assets-stable.tar.gz -C editor
```

Record the tarball SHA-256 next to the tag in your deployment config. The
repository script `scripts/ci/notebook-cloud-assets-smoke.sh` does the sidecar
check, the per-file manifest check, and a static serve test. It needs `tar`,
`sha256sum`, and Node 22. It also accepts an `https://` URL, which adds `curl`.

## Serve

`viewer/` is a library build. It has no `index.html`. The host renders the
page and the editor mounts into it:

```html
<link rel="stylesheet" href="/assets/notebook-cloud-viewer.css" />
<div id="root"></div>
<script id="nteract-cloud-auth-config" type="application/json">{ ... }</script>
<script id="nteract-cloud-viewer-config" type="application/json">{ ... }</script>
<script type="module" src="/assets/notebook-cloud-viewer.js"></script>
```

- Serve `viewer/assets/` at `/assets/` on the editor origin.
- Serve `viewer/plugins/` at the URL you pass as `rendererAssetsBasePath`.
  Keep renderer assets on their own origin or route.
- Serve `output-document/index.html` from a separate origin and pass that
  origin as `outputDocumentBaseUrl`. Output code must not share the editor's
  origin.
- The browser loads the WASM engine from `runtimedWasmModulePath` and
  `runtimedWasmPath`. Point them at the hashed files under `viewer/assets/`;
  `viewer/assets/runtime-wasm-assets.json` lists their names.
- `wasm/runtimed-wasm/` is for the host's server, which imports
  `runtimed_wasm.js` and `runtimed_wasm_bg.wasm` from it. The browser does not
  fetch this directory.

## Runtime configuration

Two JSON scripts carry everything the editor needs. The authoritative field
lists live in the release tag's source: `loadConfig` in
`apps/notebook-cloud/viewer/cloud-viewer-config.ts` and
`normalizeOidcAuthConfig` in `apps/notebook-cloud/viewer/oidc-auth.ts`.

`#nteract-cloud-viewer-config` is required. The editor refuses to start when
any of these keys is missing:

| Group | Keys |
| --- | --- |
| Notebook | `notebookId` |
| Server endpoints | `catalogEndpoint`, `syncEndpoint`, `aclEndpoint`, `invitesEndpoint`, `accessRequestsEndpoint`, `workstationsEndpoint`, `workstationDefaultEndpoint`, `workstationAttachEndpoint` |
| Snapshot and blob paths | `snapshotBasePath`, `runtimeSnapshotBasePath`, `commsSnapshotBasePath`, `blobBasePath` |
| Asset paths | `rendererAssetsBasePath`, `runtimedWasmModulePath`, `runtimedWasmPath` |

Optional keys include `headsHash`, `authorProfilesEndpoint`,
`outputDocumentBaseUrl`, `hostCapabilities`, `featureFlags`, and `session`.

`#nteract-cloud-auth-config` is optional. Its `oidc` object enables OIDC
sign-in when it carries `issuer`, `clientId`, and `redirectUri`;
`providerLabel`, `scope`, and `flow` are optional. Without the script, or
without those three keys, the editor runs with no sign-in.

The endpoints point at a notebook server you run. That server imports the
engine in `wasm/runtimed-wasm/` and the types in `protocol/`. Cross-origin
allow-lists, identity mapping, and credentials are that server's concern, not
the editor's.

## Compatibility

`manifest.json` lists `protocol_version`. It matches `PROTOCOL_VERSION` in
`crates/notebook-protocol/src/connection/handshake.rs` for that tag. The
daemon or runtime image you connect to must report the same
`protocol_version`. Pin both to releases from the same protocol version.
Versions are not wire-compatible across a protocol bump.

## Build and publication recovery

The successful release's single WASM build retains `release-wasm-<run>-<attempt>`
for 90 days, including source/channel/version, build attempt, and per-file hashes.
The optional **Build editor assets** workflow validates that successful release,
reuses its WASM and renderer bytes, then builds the viewer once. It retains
`editor-assets-<release-run>-<release-attempt>` for 90 days with the tarball,
sidecar, and `candidate.json` (release/WASM/build identities and checksums).
A release retry that reuses a successful earlier WASM build records that original
WASM attempt separately from the successful release attempt.

**Publish editor assets** runs afterward with write permission, checks out only
the trusted default-branch publisher, and treats downloaded artifacts as bytes.
It verifies the successful upstream release, immutable tag/source, artifact
origin/digest, and asset hashes before uploading. It never runs downloaded code,
rebuilds, replaces an existing asset, or changes a rolling channel tag. Both
uploaded assets are downloaded and hashed again before success is reported.

To recover a publication failure, dispatch **Publish editor assets** on the
default branch with the successful editor build run ID and attempt. A partial
upload resumes only the missing member after checking the existing member's
bytes. An exact completed pair is a no-op; different bytes fail closed. Missing
older assets are refused after a newer release in that channel exists.

To retry an initially failed build, dispatch **Build editor assets** with the
successful release run ID and attempt. Duplicate events and whole-workflow
reruns first find the retained completed candidate and skip all build work.
If packed bytes exist but their build job failed, publication/build recovery
stops for investigation. If a successful candidate's artifact expired or was
deleted, recovery fails explicitly; use a new release candidate, never silently
rebuild the old identity. Workflow run records must remain available to enforce
that barrier; do not delete editor build runs while their release is supported.

The first supported release must include these workflows and the retained WASM
receipt. Older releases cannot be backfilled by rebuilding their WASM. PR
fixture/real-build smoke checks validate packing and static serving; they do
not establish that a published release asset has been accepted by a host.
