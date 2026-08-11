# Host-neutral notebook web artifacts

## Status

Proposed integration contract for external desktop hosts. The contract is
intentionally not Electron-specific.

## Problem

The notebook UI is a workspace application, not a publishable React component.
It imports generated `runtimed-wasm` bindings and content-hashed renderer chunks
that must remain compatible with the daemon and its embedded isolated-output
renderer plugins. Copying `apps/notebook/dist` by hand gives an embedding host
no provenance, integrity, or compatibility signal.

## Options considered

### Embed the complete notebook UI in `runtimed`

This resembles the daemon's embedded renderer-plugin delivery, but the notebook
application is much larger and has a different owner. Embedding it would couple
daemon installation and memory/disk size to one host UI, require the daemon to
become a general static application server, and duplicate the host's origin/CSP
responsibilities.

### Publish an Electron binding package

The existing production browser host already connects through the typed relay
without Tauri. An Electron-only transport would duplicate that protocol before
we have evidence the relay is insufficient, and it would make other desktop or
webview hosts second-class consumers.

### Publish a host-neutral notebook-web archive

Build the existing Vite application in the same release graph as `runtimed` and
package it as a separate release asset. The archive carries:

- `index.html` and all content-hashed frontend assets;
- generated runtime WASM;
- `notebook-web-manifest.json`, naming the nteract source revision and runtime
  compatibility contract;
- `SHA256SUMS`, covering the payload and manifest.

The daemon continues to embed and serve the isolated-output renderer plugins it
already owns. It also serves the canonical isolated output document from the
blob server's `/output-frame` route with output-specific CSP headers. The
manifest records that division explicitly. An embedding host serves the archive
from its own isolated origin, supplies the browser relay, and refuses a daemon
whose source revision differs. The browser host derives `outputDocumentUrl`
from the relay's current blob port and passes it through `NotebookHost`; until a
blob port is available, browser rendering keeps the existing `srcDoc` fallback.

## Proposed first-pass contract

`cargo xtask notebook-web` builds and stages `target/notebook-web`. Release CI
creates a versioned `nteract-notebook-web-<version>.tar.gz` and adjacent archive
checksum from the same commit as the standalone daemon binaries.

The manifest schema starts at version 1. Consumers must reject unknown schema
versions, missing runtime WASM, unsafe file paths, and payload checksum drift.
They may allow an unstamped local development daemon, but a stamped source
revision mismatch fails closed before notebook traffic is relayed.

Hosts remain responsible for making the daemon blob server reachable from the
browser without proxying `/output-frame` through the notebook application
origin, allowing the loopback frame URL in the application CSP, and preserving
the iframe sandbox without `allow-same-origin`.

## Adoption sequence

- Validate a locally built archive and matching daemon by exercising one synced
  rich-output cell through a packaged host, observing its output, and confirming
  the isolated frame uses the daemon `/output-frame` URL rather than `srcDoc`.
- Consume the versioned release asset and daemon from one tag, retain
  integrity/version checks, and document installer ownership. Release
  publication and signing remain separate operational gates.

## Open questions

- Whether the release manifest should eventually carry a protocol compatibility
  range in addition to strict source revision.
- Whether `runt` should gain an install/locate command for the web archive after
  more than one external host needs it.
- Whether a smaller notebook-only Vite entry should exclude settings, gallery,
  and other desktop sub-apps; the first archive deliberately packages the
  already-tested production output.
- Whether the archive should carry a machine-readable third-party notice or
  SBOM alongside the integrity manifest so embedding hosts can feed their own
  release-compliance pipelines without reconstructing the Vite dependency graph.
