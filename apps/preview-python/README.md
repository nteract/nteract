# Preview Python (experimental)

On-demand notebook compute for our celld cloud deployment only. This package is
not enabled by default and is not a Desktop kernel or a generic Cloudflare
provider. See [the implementation plan](../../docs/plans/preview-python.md).

The initial adapter executes Python directly and returns notebook-shaped outputs
without ZeroMQ. The trusted supervisor and cloud runtime-peer integration are
under development. Do not expose the internal execution endpoint publicly.

## Build

Run `pnpm --filter @nteract/preview-python build`. Runtime assets are pinned to
Pyodide 0.28.3 and verified against `runtime-lock.json`. Build output contains
local interpreter/stdlib assets; runtime startup does not fetch from a CDN.

## Provenance

The compiled-Wasm bootstrap follows the local celld Python Workers experiment
(branch `quod/python-workers`, based on celld 0.5.1). The execution/display
separation is informed by runtimed/runtime-agents' Pyodide agent used by anode.
The current evaluator is newly implemented; IPython formatting, scientific
packages, output bounds and the managed provider remain implementation gates.
No notebook readiness or tenant-isolation claim follows from the build alone.

## Scientific environment and isolation

The pinned package graph includes IPython, pandas, NumPy and Matplotlib. Native
Wasm libraries are compiled at build time. Immutable wheel assets are provided
by a restricted internal service binding and verified again on initialization;
loaded session code stays below celld's module limit. Guest ambient networking
remains disabled. Package assets contain no user data or credentials.

The direct evaluator uses IPython formatters and display publishing, while code
uses Python AST evaluation with top-level await. IPython magics, shell escapes,
stdin, widgets, progressive output streaming and full IPython history semantics
are not currently supported. The trusted supervisor must validate output types
before publishing them into runtime documents. Python-side limits alone are not
a security boundary.

Run the real isolated-server test with a qualified experimental celld binary:

```sh
CELLD_BIN=/absolute/path/to/celld pnpm --filter @nteract/preview-python test
```

The tests own temporary ports/storage/processes and save measurements under
`.scratch/`. This requires the Python Workers branch's hard-termination fixes;
unmodified celld 0.5.1 is not qualified for safe interpreter reuse after a CPU
limit. Current measurements cover interpreter calls, not the cloud UI.
