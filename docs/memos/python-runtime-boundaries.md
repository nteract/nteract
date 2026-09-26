# Managed Python runtime boundaries

Status: implemented package boundary, IPython execution, and bounded live stream
output; native interruption, checkpoint optimization, and snapshots remain follow-up work.

## Deployment and ownership

Each enabled celld `main` or `pr-*` deployment bundles the notebook room classes,
`PreviewPythonSessions`, and `PackageAssets` in its main Worker. The existing
outputs and renderer-assets services remain separate. This is one private pool
per deployment, not a public Python API or a cluster-wide pool.

```mermaid
flowchart LR
  Room[Notebook room] <-->|Automerge runtime sync| Peer[nteract runtime peer]
  Peer -->|accepted execution| Pool[Private session pool]
  Pool -->|loader binding| Machine[Jailed Pyodide interpreter]
  Machine -->|bounded outputs| Pool
  Pool --> Peer
```

| Piece | Owner | Responsibility |
|---|---|---|
| Notebook integration | `apps/notebook-cloud` | Authorization, room-accepted execution intent, Automerge sync/checkpoints, output blobs |
| Python runtime service | `apps/preview-python` | Runtime peer, ordered execution, session ownership/generation fencing, quotas, clean pool, deduplication |
| Python machine | `packages/pyodide-runtime` | Pinned environment, isolated interpreter, IPython semantics, bounded result validation, deadline/termination adapter |
| Shared formatting | `python/nteract-kernel-launcher` | Traceback schema, source provenance and redaction reused at machine build time |

The service remains native to nteract and Automerge. The interpreter has no
notebook credentials or document-write authority. Package separation is not a
claim of a separate physical process or independent event loop: celld scheduling
must be measured separately. The celld adapter lives at the package's `./celld`
entrypoint; the Python execution module has no service/pool/room dependency.

## Execution contract

The coordinator records accepted source and `cell_id` under `execution_id` in
RuntimeStateDoc. The peer consumes that record, publishes running, and invokes
the machine with those exact fields. The pool key includes owner, notebook, and
runtime session identity; interpreter handles never cross sessions.

Results echo cell/execution IDs and a SHA-256 hash of the accepted source. The
trusted adapter verifies those fields, bounds response bytes, validates output
operations, and constructs fresh records. Guest-supplied IDs do not confer
permission. Only the trusted peer converts output bytes into room-scoped blobs
and manifests. A stale session cannot publish results after replacement.

The IPython compiler names each accepted attempt and registers its source with
the shared traceback formatter. Functions defined by earlier executions retain
that earlier provenance when called from a later cell. Python ContextVars bind
output capture to the execution that created asynchronous work; completed
captures close rather than accepting late output into a newer execution.

IPython owns transformations, display hooks/history, and pre/post cell
lifecycle. The package uses nteract's structured traceback formatter. Safe in-process magics may
work; shell escapes, arbitrary package/environment mutation, stdin, comms/widgets,
completion/inspection transport, Arrow buffers, and all desktop launcher
extensions are not promised by this slice.

## Live output and interruption

Each execution has one ordered NDJSON response: bounded advisory stdout/stderr,
clear, and display-boundary events followed by an authoritative result batch.
The trusted peer uses RxJS windows to coalesce events and serializes publication.
Live records stay inline and have per-execution record/write limits. The final
validated batch replaces live records before terminal state; pending live writes
cannot overwrite it. Rich outputs arrive with that batch. Output before completion
requires naturally yielding Python, such as `await asyncio.sleep(...)`; synchronous
CPU work and `time.sleep` may defer delivery. Python sleep and scheduling are not
overridden to manufacture streaming checkpoints.

Interrupt retains destructive host termination, discarding variables. Native
variable-preserving interruption needs a host capability that can signal the
buffer registered with Pyodide's `setInterruptBuffer` independently of a busy
guest. On the qualified celld `6ab0d999` build, SharedArrayBuffer exists and local
structured cloning retains its shared backing, but both LOADER environment
transfer and cross-isolate RPC reject it; the browser Worker constructor is also
absent. Local shared-memory support does not establish cross-isolate delivery.

A separate Node worker-thread control with pinned Pyodide 0.28.3 interrupted a
CPU loop through its native buffer and preserved the namespace. Unmodified
`time.sleep(20)` reported the interrupt only after the sleep ended. Those controls
establish API behavior, not support in the deployed celld runtime. A narrow,
host-owned signal capability needs runtime/owner fencing, stale-signal clearing,
disposal tests, and a termination fallback. Guest polling and sleep monkeypatching
are not the replacement for that host contract.
Track the native capability and qualification work in
[issue #4325](https://github.com/nteract/nteract/issues/4325).

## Async work to pursue

Keep the Automerge runtime peer boundary. Measure room acceptance, running claim
persistence, interpreter dispatch, evaluation, output preparation, sync, and
browser paint separately before removing waits. A CPU-heavy interpreter and a
second notebook should be exercised concurrently to distinguish application
serialization from celld event-loop starvation.

The current execution-owned response gives live events their identity and order.
A future resumable stream would need explicit sequence numbers and deduplication
across reconnects. Display updates, clear-output ordering, cancellation, and late
background outputs must retain their lineage. Live publication alone makes no
end-to-end latency claim.

Execution IDs support deduplication and attribution but do not make side effects
transactional. A narrower durable claim/terminal record may replace full room
checkpoints on the critical path only after recovery tests prove no accidental
replay. This patch preserves existing checkpoint behavior.

## Snapshots and extraction

Prepared environment snapshots belong below the service/machine boundary: they
change how the loader obtains a clean interpreter. User-session snapshots are a
separate capability requiring versioned runtime assets, Wasm tables, JS references,
filesystem state and a quiescent task boundary. Do not infer resumability from
copying Wasm linear memory. The earlier celld Python Workers experiment remains
the place to explore host support; no live experiment is changed here.

The two pieces stay in the monorepo for now. Moving the machine later requires an
explicit dependency for the shared launcher formatter plus its pinned assets and
compatibility suite. It does not require changing the nteract peer protocol or
introducing a generic public execution service.
