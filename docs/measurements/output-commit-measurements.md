# Non-Stream Output Commit Measurements

**Status:** Historical baseline measurement, 2026-05-24. Documented synchronous
commit cost before output_committer queue landed. Production now enqueues
these outputs through `output_committer`
(`crates/runtimed/src/output_committer.rs`).

This measurement covered the ordinary output path after stream and
`update_display_data` optimizations:

- `display_data`
- `execute_result`
- `error`

**Historical baseline:** These outputs ran manifest creation and
`RuntimeStateDoc.append_output` on the IOPub reader task. The measurement
compared that synchronous shape against an ordered-worker model.

**Current path (post-optimization):** Production starts `output_committer`
from IOPub setup (`crates/runtimed/src/jupyter_kernel.rs:1407-1424`).
Ordinary outputs enqueue via `OutputCommitterHandle::enqueue_output`
(`crates/runtimed/src/output_committer.rs:75-100`); worker-side batch append
uses `sd.append_outputs` (`crates/runtimed/src/output_committer.rs:260-283`).

## Running

```bash
NTERACT_OUTPUT_COMMIT_COUNTS=10,100 \
NTERACT_OUTPUT_COMMIT_PAYLOAD_BYTES=256 \
cargo run -p runtimed --example output_commit_measure
```

Each output line is JSON. The useful fields are:

- `strategy`: `current` or `ordered_worker_model`
- `kind`: `display_data`, `execute_result`, or `error`
- `iopub_nanos`: time spent on the modeled IOPub reader path
- `preflight_nanos`: time spent in display/execute blob-ref preflight
- `worker_nanos`: time spent on worker-side manifest/doc writes
- `committed_outputs`: proof that both strategies commit the same number of outputs

Example shape:

```json
{"strategy":"current","output_count":100,"payload_bytes":256,"kind":"display_data","iopub_nanos":405622706,"preflight_nanos":12624,"worker_nanos":0,"committed_outputs":100}
{"strategy":"ordered_worker_model","output_count":100,"payload_bytes":256,"kind":"display_data","iopub_nanos":237084,"preflight_nanos":10378,"worker_nanos":394422709,"committed_outputs":100}
```

The local sample above shows the tradeoff: an ordered worker does not remove
blob preflight, manifest, or Automerge write cost, but it moves that cost off
the IOPub reader. This benchmark intentionally isolates ordinary non-stream
output commits; stream-boundary flushes remain a separate ordering requirement.
That is the optimization target for a follow-up implementation PR: keep
`ExecutionDone` causally after durable output writes while preventing ordinary
rich output bursts from delaying later IOPub status and control observations.

The ordered-worker model uses an in-memory queue to isolate enqueue cost. A
production queue must still be bounded or otherwise capacity-limited so sustained
rich-output bursts do not trade IOPub latency for unbounded memory growth.

## Production Queue

The production implementation lives in `crates/runtimed/src/output_committer.rs`.
It uses a bounded ordinary-output queue for `display_data`, `execute_result`,
and `error`, plus priority flush barriers for ordering-sensitive transitions:

- `CellError` waits for the queued error or rich traceback output to become
  durable before the lifecycle signal reaches the runtime agent.
- `ExecutionDone` waits for queued ordinary outputs, then the final stream flush
  can emit the terminal lifecycle signal after stream state is durable.
- `update_display_data` drains preceding ordinary outputs before queuing the
  coalesced display update so an update immediately after a new display can find
  its durable target.

Wall-clock fields are for branch-to-branch comparison only; CI tests assert
deterministic work counts, not absolute timings.
