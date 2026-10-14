# @nteract/sift-csv

CSV and TSV to Arrow IPC, in WebAssembly. Published as
[`@nteract/sift-csv`](https://www.npmjs.com/package/@nteract/sift-csv). Built for
[`@nteract/sift`](https://www.npmjs.com/package/@nteract/sift), usable by any
Arrow consumer. Pin an exact version; the package is pre-1.0.

```ts
import { csvToArrowIpc } from '@nteract/sift-csv'
import { loadTableFile } from '@nteract/sift'

const ipc = await csvToArrowIpc(text, { delimiter: '\t' })
const data = await loadTableFile(ipc, { format: 'arrow-ipc' })
```

It is a separate package so apps that only open Parquet or Arrow do not carry
the CSV parser: the WASM is about 2 MB (590 KB gzipped).

## Behavior

- Type inference reads the whole file. Booleans (`true`/`false`, any case),
  Int64, Float64 (including exponents), ISO Date32, and ISO Timestamp columns
  are detected. A column with mixed shapes is text.
- Empty fields are null in every column type.
- Files load whole or fail. Ragged rows, unbalanced quotes, and limit breaches
  reject with the reason; nothing is truncated or sampled.
- Defaults: 16 MiB input, 100,000 rows, 256 columns, 128 MiB of Arrow output.
  Every limit is an option.

## WASM asset

`lib/wasm/sift_csv_wasm_bg.wasm` is resolved next to the glue through
`import.meta.url`. When a bundler or iframe moves it, point at the binary first:

```ts
import { setWasmUrl } from '@nteract/sift-csv'
setWasmUrl(new URL('@nteract/sift-csv/wasm', import.meta.url))
```

## Development

```sh
cargo xtask wasm sift-csv              # crates/sift-csv-wasm/pkg
pnpm --dir packages/sift-csv test
pnpm --dir packages/sift-csv build:lib
pnpm --dir packages/sift-csv test:package
cargo test -p sift-csv-wasm
```
