# Managed Python runtime boundaries

Status: implemented package boundary and IPython execution foundation; streaming,
checkpoint optimization, and snapshots remain follow-up work.

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

## Async work to pursue

Keep the Automerge runtime peer boundary. Measure room acceptance, running claim
persistence, interpreter dispatch, evaluation, output preparation, sync, and
browser paint separately before removing waits. A CPU-heavy interpreter and a
second notebook should be exercised concurrently to distinguish application
serialization from celld event-loop starvation.

A future streaming protocol should carry execution identity and monotonic output
sequence on every event, with bounded buffering and a terminal marker after the
last accepted output. Display updates, clear-output ordering, cancellation, and
late background outputs must keep their lineage. The current transport still
returns a complete batch; this change makes no end-to-end latency claim.

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
