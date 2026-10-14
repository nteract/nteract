# Embedding the hosted editor

Every nightly and stable nteract release attaches the browser editor as one
tarball. A host that embeds the editor pins a release tag and a SHA-256. It does
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

The tarball is reproducible from its release tag. Entry order, owners, and
modification times are fixed, and `built_at` is the release timestamp already
encoded in the version. Repackaging the same tag gives the same bytes.

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
