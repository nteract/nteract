# Non-Stream Output Commit and Segment Measurements

This measurement covers ordinary output work after the stream,
`update_display_data`, and ordered output-committer optimizations:

- `display_data`
- `execute_result`
- `error`

The production path now keeps the IOPub reader hot by queueing these outputs
and committing them in ordered batches. That fixes the reader-stall failure, but
it does not change the storage contract: 1000 kernel outputs still become 1000
RuntimeStateDoc output entries and one large Automerge sync frame.

This benchmark now measures two separate costs:

- **Hot-path work**: how much work runs before the IOPub reader can observe the
  next kernel message.
- **Document/sync amplification**: how many RuntimeStateDoc entries, saved-doc
  bytes, and encoded Automerge sync bytes are produced for a burst.

## Running

```bash
NTERACT_OUTPUT_COMMIT_COUNTS=10,100 \
NTERACT_OUTPUT_COMMIT_PAYLOAD_BYTES=256 \
NTERACT_OUTPUT_COMMIT_SEGMENT_SIZE=128 \
cargo run -p runtimed --example output_commit_measure
```

Each output line is JSON. The useful fields are:

- `strategy`: `current`, `ordered_worker_model`, or `blob_segment_model`
- `kind`: `display_data`, `execute_result`, or `error`
- `iopub_nanos`: time spent on the modeled IOPub reader path
- `preflight_nanos`: time spent in display/execute blob-ref preflight
- `worker_nanos`: time spent on worker-side manifest/doc/segment writes
- `committed_outputs`: proof that both strategies commit the same number of outputs
- `durable_output_entries`: number of RuntimeStateDoc output entries written
- `doc_append_calls`: number of RuntimeStateDoc append calls
- `doc_save_bytes`: saved Automerge document size after the burst
- `sync_daemon_bytes`: encoded daemon-to-peer RuntimeStateDoc sync bytes after
  the burst
- `segment_blobs` / `segment_bytes`: segment blob count and total serialized
  segment payload bytes, only for `blob_segment_model`

Example shape:

```json
{"strategy":"ordered_worker_model","output_count":1000,"payload_bytes":256,"kind":"display_data","durable_output_entries":1000,"doc_save_bytes":60705,"sync_daemon_bytes":434021,"committed_outputs":1000}
{"strategy":"blob_segment_model","output_count":1000,"payload_bytes":256,"kind":"display_data","durable_output_entries":8,"segment_blobs":8,"segment_bytes":374200,"doc_save_bytes":2387,"sync_daemon_bytes":3452,"committed_outputs":1000}
```

The local sample above shows the next bottleneck. The ordered worker moves work
off the IOPub reader and batches `append_outputs`, but the flat output model
still produces the same Automerge sync payload as 1000 individual durable
entries. A blob-backed segment changes the document shape: RuntimeStateDoc
stores one ordered segment ref per chunk, while blob storage carries the ordered
child manifests.

The ordered-worker model uses an in-memory queue to isolate enqueue cost. A
production queue must still be bounded or otherwise capacity-limited so sustained
rich-output bursts do not trade IOPub latency for unbounded memory growth.

## Local Sample

Command:

```bash
NTERACT_OUTPUT_COMMIT_COUNTS=100,500,1000 \
NTERACT_OUTPUT_COMMIT_PAYLOAD_BYTES=256 \
NTERACT_OUTPUT_COMMIT_SEGMENT_SIZE=128 \
cargo run -q -p runtimed --example output_commit_measure
```

Representative `display_data` results:

| N | Strategy | Durable entries | Doc append calls | Saved doc bytes | Sync bytes | Segment bytes | Total time |
|---:|---|---:|---:|---:|---:|---:|---:|
| 100 | current | 100 | 100 | 6,784 | 43,448 | 0 | 454 ms |
| 100 | ordered_worker_model | 100 | 1 | 6,800 | 43,448 | 0 | 169 ms |
| 100 | blob_segment_model | 1 | 1 | 1,131 | 579 | 37,425 | 4.8 ms |
| 500 | current | 500 | 500 | 30,626 | 217,021 | 0 | 10.7 s |
| 500 | ordered_worker_model | 500 | 4 | 30,654 | 217,021 | 0 | 3.3 s |
| 500 | blob_segment_model | 4 | 4 | 1,683 | 1,806 | 187,100 | 21 ms |
| 1000 | current | 1000 | 1000 | 60,705 | 434,021 | 0 | 43.0 s |
| 1000 | ordered_worker_model | 1000 | 8 | 60,705 | 434,021 | 0 | 12.8 s |
| 1000 | blob_segment_model | 8 | 8 | 2,387 | 3,452 | 374,200 | 47 ms |

For `execute_result` and `error`, the same shape holds. At N=1000,
`execute_result` flat sync was 457,955 bytes versus 3,452 bytes for segments;
`error` flat sync was 705,038 bytes versus 3,452 bytes for segments.

Wall-clock numbers are local-machine benchmark artifacts. The more stable
result is the amplification ratio: segment refs keep Automerge traffic nearly
constant with segment count, while flat output entries scale with output count.

## Blob-Backed Output Segment Model

The measurement uses an internal prototype manifest:

```json
{
  "output_type": "output_segment",
  "output_id": "...",
  "segment": {
    "blob": "...",
    "size": 374200,
    "media_type": "application/vnd.nteract.output-segment+json",
    "count": 128,
    "first_output_id": "...",
    "last_output_id": "..."
  }
}
```

The segment blob contains:

```json
{
  "version": 1,
  "outputs": [
    { "output_type": "display_data", "output_id": "...", "data": { "...": { "inline": "..." } } }
  ]
}
```

This is deliberately not a kernel protocol change. The kernel still emits
ordinary Jupyter messages, the daemon still creates normal child
`OutputManifest`s, and the segment only changes the daemon-to-client storage
projection. A production implementation should hide this behind RuntimeStateDoc
projection/resolution so existing consumers can continue to ask for flat outputs
when they need them.

## Jupyter Rate Limits

Jupyter Server also treats IOPub as a bounded resource. Its
[`ZMQChannelsWebsocketConnection`](https://jupyter-server.readthedocs.io/en/stable/api/jupyter_server.services.kernels.connection.html#jupyter_server.services.kernels.connection.channels.ZMQChannelsWebsocketConnection)
has `iopub_msg_rate_limit`, `iopub_data_rate_limit`, `rate_limit_window`, and a
`limit_rate` switch for tuning IOPub throughput. That makes a bounded-output
contract reasonable for nteract too: runtimes should not assume unlimited
client-side output transport, and nteract should keep the kernel reader hot
while moving bulk payloads out of the sync document.

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
