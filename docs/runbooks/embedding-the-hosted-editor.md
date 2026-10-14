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
| `manifest.json` | Version, channel, `protocol_version`, source commit, build time, and a SHA-256 for every other file |
| `viewer/` | The browser editor bundle: `assets/`, `plugins/`, and the OIDC callback page |
| `output-document/` | The page that renders untrusted cell output |
| `wasm/runtimed-wasm/` | The `runtimed-wasm` engine (`.js` glue and `.wasm`) |
| `protocol/` | The TypeScript protocol package source and `package.json` |
| `LICENSE` | License text |

The bundle has no deployment configuration baked in. One tarball serves any
host. The tarball is reproducible from the release tag: file order, owners, and
modification times are fixed, and the build time appears only in
`manifest.json`.

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
check, the per-file manifest check, and a static serve test. It needs only
`tar`, `sha256sum`, and Node 22. It also accepts an `https://` URL.

## Serve

Serve `viewer/` as static files. Put `wasm/runtimed-wasm/` and
`output-document/` next to it at those paths. Serve `output-document/` from a
separate origin from the editor, so output code cannot reach the host page.

## Runtime configuration

The host supplies this at runtime. Nothing here is compiled into the assets.

- OIDC provider settings: client ID, audience, issuer, redirect URI, and the
  principal namespace that identities map into.
- Allowed origins for cross-origin requests to your server.
- The base URL where the output document is served.
- The base URL for renderer assets, if they are served separately from `viewer/`.

The viewer talks to a notebook server you run or operate. That server imports
the same `wasm/runtimed-wasm/` engine and the `protocol/` types.

## Compatibility

`manifest.json` lists `protocol_version`. It matches `PROTOCOL_VERSION` in
`crates/notebook-protocol/src/connection/handshake.rs` for that tag. The
daemon or runtime image you connect to must report the same
`protocol_version`. Pin both to releases from the same protocol version.
Versions are not wire-compatible across a protocol bump.
