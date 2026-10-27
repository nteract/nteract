# Sift

Crossfilter data explorer. [Pretext](https://github.com/chenglou/pretext) × [Arrow](https://arrow.apache.org/).

![Sift — crossfilter in action](https://img.runt.run/sift/crossfilter-demo.gif)

Published as [`@nteract/sift`](https://www.npmjs.com/package/@nteract/sift). Try it at [rgbkrk.github.io/sift](https://rgbkrk.github.io/sift/).

## Features

- **Local CSV/TSV, Parquet, and Arrow IPC streams** — bounded file adapters, no notebook or server needed
- **Stream hosted Arrow IPC or load Parquet URLs** — WASM-native
- **Crossfilter** — brush histograms to filter, all other summaries update instantly
- **Column profiling** — null%, distinct count shown inline in headers
- **Smart summaries** — histograms, category bars, boolean ratios, binary value bars, searchable popovers. Adapts visualization to column type × cardinality.
- **Column type casting** — right-click to treat text as numbers, dates, booleans — with full undo
- **Smart column detection** — pandas index columns, HuggingFace ClassLabel features
- **Virtual scroll** — 100k+ rows at 120fps. Pretext layout at 0.0002ms/cell.
- **Odometer status bar** — rolling digit animation for row count, visible range, FPS
- **Multi-instance** — embed multiple tables on one page (notebook demo included)
- **RxJS streaming** — cancellable dataset loading via `switchMap`
- **Mobile** — tap any row for a detail sheet with all column values
- **Dark mode**, keyboard nav, pinned columns, ARIA grid
- **8 HuggingFace datasets** built into the demo

## Quick start

From the nteract repository root:

```sh
pnpm install --frozen-lockfile
cargo xtask wasm sift --skip-renderer-plugins
pnpm --dir packages/sift dev
```

## Use as a library

The package ships JavaScript, compiled CSS, TypeScript declarations, and WASM,
with notices for the Rust crates compiled into the WASM in
`lib/THIRD_PARTY_NOTICES.md`. React and React DOM are peer dependencies; no
notebook, kernel, or daemon is needed. Tested with React 19. Types resolve
under TypeScript's `bundler` module resolution (Vite, webpack, esbuild). Pin an
exact version; stable nteract releases publish to `latest` and nightlies to the
`nightly` dist-tag.

```tsx
import { loadTableFile, SiftTable } from '@nteract/sift'
import '@nteract/sift/style.css'

const load = useCallback(() => loadTableFile(bytes), [bytes]) // Parquet or Arrow IPC
<SiftTable source={{ kind: 'loader', load }} style={{ height: 600 }} />
```

Files load whole or fail; defaults are 16 MiB, 100,000 rows, and 256 columns.
Parquet can also be read by byte range through a `ByteSource` (footer first,
then one row group at a time), which drops the 16 MiB input cap. With
`overflow: 'truncate'` it shows the leading rows that fit the row and memory
budget instead of failing, and `autoLoad` pauses at a soft budget with a
"Load more" button; see the embedding guide. Every summary labels what
its numbers cover (`scope`): histograms are over loaded rows, while range and
null count come from Parquet footer statistics for the whole file when present.
CSV and TSV go through [`@nteract/sift-csv`](https://www.npmjs.com/package/@nteract/sift-csv), a separate WASM
module that returns Arrow IPC bytes for `loadTableFile`, so apps that only open
Parquet or Arrow do not carry the CSV parser.

See the [embedding guide](docs/embedding-guide.md) for WASM asset setup, memory
limits, lifecycle, styling, and host viewer/editor integration.

## Engine API

```ts
engine.setSort('age', 'desc')
engine.setFilter(colIndex, { kind: 'range', min: 18, max: 65 })
engine.clearAllFilters()

// Inspect the current sort, filters, and counts.
const state = engine.getState()
```

See [`docs/embedding-guide.md`](docs/embedding-guide.md) for the full API.

## WASM compute (`sift-wasm`)

Rust crate wrapping arrow-rs. Parquet decoding, sort, histograms, value counts, string search, column casting — all in one WASM binary. Data lives in WASM memory; JS holds handles.

```sh
cargo xtask wasm sift --skip-renderer-plugins
```

## Stack

| Layer | What |
|-------|------|
| Layout | [@chenglou/pretext](https://github.com/chenglou/pretext) — DOM-free text measurement |
| Data | [Apache Arrow](https://arrow.apache.org/) — columnar, streamed via RecordBatchReader |
| Compute | [sift-wasm](https://github.com/nteract/nteract/tree/main/crates/sift-wasm) — arrow-rs WASM kernels |
| Reactivity | [RxJS](https://rxjs.dev/) — streaming pipeline |
| Charts | SVG histograms + HTML bars |

## Development

Run from the repository root after the setup above:

```sh
pnpm --dir packages/sift test          # Vitest unit tests
pnpm --dir packages/sift test:e2e      # Playwright E2E
pnpm --dir packages/sift build         # production build (demo)
pnpm --dir packages/sift build:lib     # lib/ (JS, CSS, types, WASM)
pnpm --dir packages/sift test:package  # packed consumer outside the workspace
```

## Demo pages

- `/` — main demo with dataset picker
- `/notebook.html` — multi-table notebook simulation
