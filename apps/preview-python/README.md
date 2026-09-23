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
