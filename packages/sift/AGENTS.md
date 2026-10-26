# Sift

Crossfilter table explorer. Published as `@nteract/sift`; the nteract notebook
embeds it in the isolated output renderer, and other apps embed it to view
local CSV, Parquet, and Arrow files. Demo: [rgbkrk.github.io/sift](https://rgbkrk.github.io/sift/).

## Stack

- **Vite / vite-plus** — dev server, demo build, library build
- **TypeScript** — the table engine is vanilla TS; React renders header charts,
  popovers, menus, and the `SiftTable` wrapper
- **@chenglou/pretext** — DOM-free text measurement and layout
- **Rust / WASM** (`crates/sift-wasm`, wrapping `crates/nteract-predicate`) —
  Parquet and Arrow IPC decoding, sort, histograms, value counts, filters, casts
- **RxJS** — streaming dataset loads in the demo and engine

## Commands

Run from the repository root.

```sh
pnpm install --frozen-lockfile
cargo xtask wasm sift --skip-renderer-plugins   # builds crates/sift-wasm/pkg, mirrored to public/wasm
pnpm --dir packages/sift dev                    # demo
pnpm --dir packages/sift test                   # Vitest; real-WASM cases skip without the build above
pnpm --dir packages/sift test:e2e               # Playwright demo tests
pnpm --dir packages/sift build:lib              # lib/: JS, CSS, types, WASM
pnpm --dir packages/sift test:package           # pack (runs prepack), then test an isolated consumer
pnpm --dir packages/sift exec node scripts/test-package.mjs --browser  # + production Chromium smoke
cargo test -p sift-wasm                         # native Rust tests (not in the workspace lanes)
```

`prepack` needs `cargo-about` (`cargo binstall cargo-about`); it writes
`lib/THIRD_PARTY_NOTICES.md` and refuses to pack an incomplete `lib/`.

## Architecture

### Data sources

Every source ends as a `TableData` the engine reads by `(row, col)`:

1. **Binary files**: `loadTableFile(bytes)` → `load_parquet_bounded` /
   `load_ipc_bounded` in WASM → `createWasmTableData`. Limits are checked from
   footer metadata and after each decoded batch.
2. **Parquet by byte range**: `loadTableFile(byteSource)` or the `byte-source`
   React source → `openParquetFile` (`parquet-file.ts`) → `parquet_open` from
   the footer, then `parquet_append_row_group` per row group over host-fetched
   ranges (`crates/sift-wasm/src/parquet_file.rs`). The `url` source's Parquet
   branch uses the same loader over the buffered response. `overflow:
   "truncate"` turns rows and decoded bytes into a budget: loading stops at
   the first batch that does not fit and the table shows that prefix.
3. **CSV/TSV**: `@nteract/sift-csv` (`crates/sift-csv-wasm`) converts text to Arrow IPC
   bytes, which take path 1. Sift itself has no CSV parser.
4. **Hosted URLs and Arrow manifests**: the `url` and `manifest` sources in
   `react.tsx`, used by the notebook renderer.

Column types come from the Arrow schema with data-driven refinement; summaries
for WASM sources are computed in Rust (`wasm-summaries.ts` adapts them).

### Rendering

The viewport is virtual: cells read WASM memory directly through
`get_cell_string` / `get_cell_f64`. Row heights come from pretext's `layout()`,
which is cheap enough to recompute for every visible cell on each frame.

### Public API

`src/index.ts` is the supported surface. Keep it small: once published, every
export is semver. Internals (accumulators, WASM adapters) stay unexported.

```ts
const engine = createTable(container, tableData, { onChange })
engine.setSort('name', 'asc')
engine.setFilter(colIndex, { kind: 'range', min: 10, max: 50 })
const explorer = engineStateToExplorerState(engine.getState()) // → SQL, pandas, JSON
```

### Packaging

- `vite.lib.config.ts` externalizes every declared dependency and peer; only
  first-party code and the private `@nteract/odometer` are inlined.
- `scripts/test-package.mjs` packs the library and tests it from outside the
  workspace. It fails on undeclared imports and on declared dependencies that
  nothing imports.
- `scripts/third-party-notices.mjs` runs `cargo about` (`about.toml`) over a
  WASM crate's wasm32 dependency graph and adds the Apache NOTICE files and
  bundled C-source licenses cargo-about does not model. `@nteract/sift-csv`
  reuses it. A crate with an unlisted license or unreviewed C sources fails
  generation.
- `style.css` writes nothing to `:root`, `html`, or `body` and ships no reset.
  Tokens live on `.sift-root` (`src/tokens.css`); every element Sift appends to
  `<body>` carries that class. Hosts theme it through `--sift-color-*` inputs.
  `build-lib-css.mjs` moves Tailwind's theme block onto `.sift-root` and fails
  if any document-root selector survives. The demo pages add preflight through
  `demo.css`.

### Naming

- **Sift** — the table and demo
- **`@nteract/sift`** — the npm package
- **`sift-wasm`** — the WASM crate (`crates/sift-wasm`)
- **`nteract-predicate`** — the Rust compute library it wraps
