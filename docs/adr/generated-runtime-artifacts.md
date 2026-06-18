# Generated Runtime Artifacts

**Status:** Draft, 2026-06-06.

## Context

Several runtime and renderer paths depend on generated files that are expensive
or platform-sensitive to rebuild:

- `runtimed-wasm` browser bindings under
  `apps/notebook/src/wasm/runtimed-wasm/`.
- `sift-wasm` bindings under `crates/sift-wasm/pkg/` and the mirrored demo
  copy under `packages/sift/public/wasm/`.
- renderer plugin bundles under `apps/notebook/src/renderer-plugins/`.
- the MCP widget HTML embedded by `runt-mcp`.

Some of these files are stable enough to keep in Git LFS, while others include
WASM glue names or local build metadata and churn whenever their paired WASM
build changes. Direct `cargo build -p runtimed` still needs some of these
artifacts because `crates/runtimed/build.rs` embeds renderer plugin bytes.

## Decision 1: `xtask artifacts` owns generated artifact preparation

The canonical preparation surface is:

```bash
cargo xtask artifacts status
cargo xtask artifacts ensure [scope]
cargo xtask artifacts verify [scope]
```

Scopes are `runtime`, `sift`, `renderer`, `mcp-widget`, and `all`.

`cargo xtask build`, `cargo xtask dev`, and non-attached
`cargo xtask notebook` call the artifact preparation layer before compiling
Rust or TypeScript. Direct Cargo builds do not prepare artifacts implicitly; run
the relevant `cargo xtask artifacts ensure ...` command first.

For a direct runtime smoke build from a fresh worktree, the minimal sequence is:

```bash
cargo xtask artifacts ensure sift,renderer
cargo build --release -p runtimed
```

## Decision 2: Rust build scripts verify, but do not generate, JS/WASM assets

Rust build scripts may check that embedded generated assets exist and print the
recovery command, but they must not run `xtask`, `pnpm`, Vite, or `wasm-pack`.

Reasons:

- Cargo build scripts running workspace build tools can recurse into the same
  Cargo graph.
- Node and WASM toolchains can install packages or download toolchain pieces,
  which makes `cargo build` surprising and harder to cache.
- Generated renderer bundles are cross-language artifacts; `xtask` is the
  layer that already knows fingerprints, LFS hydration checks, and rebuild
  ordering.

## Decision 3: Stable bundles use Git LFS; volatile bundles stay gitignored

Stable third-party renderer plugin bundles are LFS-tracked so fresh checkouts
can boot and build without paying the full vendor rebuild cost:

- `plotly.js`
- `vega.js`
- `leaflet.js` / `leaflet.css`

Volatile artifacts stay gitignored and are regenerated:

- `apps/notebook/src/renderer-plugins/isolated-renderer.js`
- `apps/notebook/src/renderer-plugins/isolated-renderer.css`
- `apps/notebook/src/renderer-plugins/markdown.js`
- `apps/notebook/src/renderer-plugins/markdown.css`
- `apps/notebook/src/renderer-plugins/bokeh.js`
- `apps/notebook/src/renderer-plugins/sift.js`
- `apps/notebook/src/renderer-plugins/sift.css`
- `apps/notebook/src/wasm/runtimed-wasm/`
- `crates/sift-wasm/pkg/`

The Sift renderer bundle embeds wasm-bindgen glue from `sift-wasm`. Rebuilding
`sift-wasm` without rebuilding `sift.js` can leave the plugin importing
nonexistent `__wbg_*` names. `cargo xtask artifacts ensure sift,renderer`
preserves that pairing.

## Decision 4: Fingerprints and semantic checks define freshness

Byte-for-byte reproducibility is not assumed for wasm-pack outputs across
platforms. Artifact freshness is checked through:

- source and lockfile fingerprints recorded under `target/xtask/`;
- renderer plugin verification that Sift's wasm-bindgen imports exist in the
  paired WASM binary;
- `runtimed-wasm` genesis-seed verification so the browser and daemon agree on
  Automerge roots.

CI should use `cargo xtask artifacts verify ...` when a job consumes generated
artifacts without rebuilding them, and `cargo xtask artifacts ensure ...` when
a job owns rebuilding missing or stale artifacts.

## Consequences

- Direct `cargo build -p runtimed` from a clean worktree can fail until the
  volatile artifacts have been generated. This is expected; the recovery command
  is `cargo xtask artifacts ensure sift,renderer`.
- LFS pointer files are a checkout problem, not a renderer rebuild signal.
  `xtask artifacts` should report them and ask for `git lfs pull`.
- Runbooks for hosted runtime-peer smokes or direct Rust builds should include
  the artifact ensure step before `cargo build`.
