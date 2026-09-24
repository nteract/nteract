# pyodide-assets

Populated by `node scripts/fetch-pyodide-assets.mjs` (not checked in): the
Pyodide distribution that the pyodide execution worker bundles as static asset
siblings (`pyodide.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, and the
package bundle). celld registers `**/*.wasm` files as static WASM imports
(`CompiledWasm` rule), so the worker bundle references them statically — see
`specs/001-pyodide-decoupled-runtime/contracts/contracts.md` contract C7.

The preview bundle validator (`.github/preview/bundle.mjs`) requires every
service to ship an `assets/` directory, so this directory must be populated
before `celld-local.mjs export` / CI preview bundling.
