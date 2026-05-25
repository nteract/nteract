# Output Widget Replay Measurements

**Status:** Draft, 2026-05-24.

This note records the reproducible measurement surface for the current
runtime-agent to IPython Output widget replay path. It is intentionally a
measurement baseline, not an optimization.

## What Is Measured

When a Jupyter Output widget captures output, the IOPub task currently:

1. appends one output manifest to `RuntimeStateDoc.comms[*].outputs`;
2. mirrors the full outputs list into the comm state `outputs` property;
3. resolves every manifest in that full list back to nbformat JSON;
4. sends one best-effort `SendCommUpdate` replay to the kernel.

The durable record remains `RuntimeStateDoc`. The kernel-facing replay is
best-effort convenience for the Python-side Output widget object.

## Rust Measurement

Run the measurement helper from the repository root:

```bash
NTERACT_OUTPUT_WIDGET_REPLAY_COUNTS=10,50,100 \
NTERACT_OUTPUT_WIDGET_REPLAY_PAYLOAD_BYTES=256 \
cargo run -p runtimed --example output_widget_replay_measure
```

Each output line is JSON with a `strategy` and nested `metrics`. The key field
is `metrics.manifest_resolutions`: with the current replay loop, `N` captured
outputs resolve `N * (N + 1) / 2` manifests because every replay update
resolves the full output list. The cached strategy resolves only the newly
appended manifest when its local cache matches the durable output list.

Example shape:

```json
{"strategy":"current","metrics":{"output_count":100,"manifest_resolutions":5050,"resolved_outputs_sent":5050}}
{"strategy":"cached","metrics":{"output_count":100,"manifest_resolutions":100,"resolved_outputs_sent":5050}}
```

The unit test
`output_widget_replay_measure::tests::measurement_records_triangular_resolve_work_for_current_replay_loop`
pins that deterministic triangular work count. The companion
`cached_replay_resolves_each_manifest_once` test pins the linearized resolution
target for the Output widget replay cache. Wall-clock fields are included for
local comparison between branches, but they should not be used as strict CI
assertions.

## Notebook Fixtures

Two audit fixtures cover the widget pressure that motivated the stack:

- `crates/notebook/fixtures/audit-test/16-widget-slider.ipynb` exercises rapid
  frontend-to-kernel widget state changes and kernel responsiveness.
- `crates/notebook/fixtures/audit-test/17-output-widget-replay-stress.ipynb`
  creates one Output widget and captures 200 stream outputs into it. This is
  the representative high-output replay fixture for future local or E2E checks.

## Optimization Target

The first optimization PR should reduce kernel-facing replay work without
changing these invariants:

- `RuntimeStateDoc.comms[*].outputs` remains the durable source of truth.
- Output widget `clear_output(wait=...)` semantics are preserved.
- IOPub must not await bounded replay backpressure.
- `KernelIdle`, `CellError`, `ExecutionDone`, and `KernelDied` remain on the
  reliable lifecycle path, not on best-effort output work transport.
